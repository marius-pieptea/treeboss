/** The emulator's gRPC channel without an emulator: the bytes of each message, the framing of replies, a client against a local HTTP/2 server, and finding the endpoint. */
import fs from "fs";
import http2 from "http2";
import os from "os";
import path from "path";
import { describe, expect, test } from "bun:test";
import { MessageReader, decode, discoveryDirs, encode, findEndpoints, grpcChannel, grpcClient, keyMessage, parseDiscovery, parseImage, textMessage, touchMessage } from "../src/emulator/grpc";
import { png } from "./emulator-fakes";

const framed = (m: Uint8Array) => {
  const out = new Uint8Array(5 + m.length);
  new DataView(out.buffer).setUint32(1, m.length);
  out.set(m, 5);
  return out;
};
const str = (v: number | Uint8Array | undefined) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : v);

describe("messages", () => {
  test("a touch is a TouchEvent with one finger at full pressure; a lift has none, and is still sent at 0,0", () => {
    expect([...touchMessage(300, 2, true)]).toEqual([0x0a, 8, 0x08, 0xac, 0x02, 0x10, 0x02, 0x20, 0x80, 0x08]);
    expect([...touchMessage(0, 0, false)]).toEqual([0x0a, 0]);
  });

  test("keys go by their W3C name, Menu by its Linux code, and text as text, each as a press", () => {
    const back = decode(keyMessage("back"));
    expect(back.get(2)).toEqual([2]);
    expect(str(back.get(4)?.[0])).toBe("GoBack");
    expect(str(decode(keyMessage("recents")).get(4)?.[0])).toBe("AppSwitch");
    const menu = decode(keyMessage("menu"));
    expect([menu.get(1), menu.get(3), menu.get(4)]).toEqual([[1], [139], undefined]);
    expect(str(decode(textMessage("hi there")).get(5)?.[0])).toBe("hi there");
  });

  test("decode reads what encode writes, big varints included, and steps over fixed-width fields", () => {
    const m = encode([[1, 2 ** 40], [2, "é"], [3, new Uint8Array([7, 8])], [4, 0], [5, ""]]);
    const withDouble = new Uint8Array([0x31, 1, 2, 3, 4, 5, 6, 7, 8, ...m]); // field 6, a double, in front
    const f = decode(withDouble);
    expect(f.get(1)).toEqual([2 ** 40]);
    expect(str(f.get(2)?.[0])).toBe("é");
    expect([...(f.get(3)?.[0] as Uint8Array)]).toEqual([7, 8]);
    expect([f.has(4), f.has(5), f.has(6)]).toEqual([false, false, false]);
    expect(() => decode(new Uint8Array([0x08, 0x80]))).toThrow();
  });

  test("an Image's PNG is a frame with the PNG's size; the empty image of a display that is off is none", () => {
    const bytes = png(720, 1600, "x");
    expect(parseImage(encode([[1, encode([[3, 720], [4, 1600]])], [4, bytes], [5, 7]]))).toEqual({ bytes, width: 720, height: 1600 });
    expect(parseImage(encode([[5, 1]]))).toBeNull();
  });
});

describe("framing", () => {
  test("replies are split into messages across any chunk boundaries", () => {
    const msgs = [new Uint8Array([1, 2, 3]), new Uint8Array(0), new Uint8Array(70_000).map((_, i) => i % 251)];
    const body = Buffer.concat(msgs.map(framed));
    for (const size of [1, 2, 5, 7, 4096, body.length]) {
      const reader = new MessageReader();
      const out: Uint8Array[] = [];
      for (let i = 0; i < body.length; i += size) out.push(...reader.push(body.subarray(i, i + size)));
      expect(out.length).toBe(3);
      out.forEach((m, k) => expect(Buffer.from(m).equals(Buffer.from(msgs[k]!))).toBe(true));
    }
  });

  test("a compressed message is refused", () => {
    expect(() => new MessageReader().push(new Uint8Array([1, 0, 0, 0, 1, 5]))).toThrow(/compressed/);
  });
});

describe("client", () => {
  /** A stand-in for the emulator's endpoint: getStatus, a three-frame screenshot stream, and a refusal for a wrong token. */
  async function server() {
    const calls: string[] = [];
    const srv = http2.createServer();
    srv.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
      const method = String(headers[":path"]).split("/").pop()!;
      calls.push(method);
      if (headers.authorization !== "Bearer good") {
        stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "16", "grpc-message": encodeURIComponent(`The token \`${headers.authorization}\` is invalid`) }, { endStream: true });
        return;
      }
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      if (method === "streamScreenshot") {
        for (const tag of ["a", "b"]) stream.write(framed(encode([[4, png(720, 1600, tag)]])));
        stream.write(framed(encode([[5, 3]]))); // an empty image: the display went off
        stream.end();
      } else stream.end(framed(new Uint8Array()));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    return { port: (srv.address() as { port: number }).port, calls, close: () => new Promise<void>((r) => srv.close(() => r())) };
  }

  test("unary calls answer; a refused token fails without quoting it; a stream delivers its frames and ends", async () => {
    const s = await server();
    const good = grpcClient(s.port, "good");
    const bad = grpcClient(s.port, "s3cret-token");
    try {
      expect((await good.unary("getStatus", new Uint8Array())).length).toBe(0);
      const refused = await bad.unary("getStatus", new Uint8Array()).catch((e: Error) => e);
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toContain("invalid");
      expect((refused as Error).message).not.toContain("s3cret");

      const ch = grpcChannel(good);
      await ch.touch(1, 2, true);
      await ch.key("home");
      const frames: number[] = [];
      const ended = await new Promise<Error | null>((resolve) => ch.frames((f) => frames.push(f.width), resolve));
      expect(ended).toBeNull();
      expect(frames).toEqual([720, 720]);
      expect(s.calls).toEqual(["getStatus", "getStatus", "sendTouch", "sendKey", "streamScreenshot"]);
    } finally {
      good.close();
      bad.close();
      await s.close();
    }
  });
});

describe("discovery", () => {
  const ini = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";

  test("a discovery file gives the console port, the gRPC port and the token; one without -grpc has no port", () => {
    expect(parseDiscovery(ini({ "port.serial": "5554", "port.adb": "5555", "grpc.port": "8554", "grpc.token": "tok" }))).toEqual({ consolePort: 5554, grpcPort: 8554, token: "tok" });
    expect(parseDiscovery(ini({ "port.serial": "5554", "avd.name": "trb" }))).toEqual({ consolePort: 5554, grpcPort: null, token: null });
    expect(parseDiscovery("nothing here")).toBeNull();
  });

  test("endpoints for our console port: the file the emulator named first, then the newest; others are passed over", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trb-grpc-"));
    const write = (name: string, o: Record<string, string>, ageS: number) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, ini(o));
      const t = new Date(Date.now() - ageS * 1000);
      fs.utimesSync(file, t, t);
      return file;
    };
    const old = write("pid_1.ini", { "port.serial": "5554", "grpc.port": "8554", "grpc.token": "old" }, 60);
    write("pid_2.ini", { "port.serial": "5554", "grpc.port": "8555", "grpc.token": "new" }, 1);
    write("pid_3.ini", { "port.serial": "5556", "grpc.port": "8556", "grpc.token": "other" }, 0);
    write("pid_4.ini", { "port.serial": "5554" }, 0);
    write("notes.ini", { "port.serial": "5554", "grpc.port": "1", "grpc.token": "x" }, 0);
    expect(findEndpoints(5554, null, [dir, path.join(dir, "missing")])).toEqual([
      { port: 8555, token: "new" },
      { port: 8554, token: "old" },
    ]);
    expect(findEndpoints(5554, old, [dir])).toEqual([
      { port: 8554, token: "old" },
      { port: 8555, token: "new" },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("where the emulator advertises, per OS", () => {
    const run = (...p: string[]) => path.join(...p, "avd", "running");
    expect(discoveryDirs({ TMP: "C:\\t", TEMP: "C:\\t", LOCALAPPDATA: "C:\\L" }, "win32", "C:\\h", "C:\\t")).toEqual([run("C:\\t"), run("C:\\L", "Temp")]);
    expect(discoveryDirs({}, "darwin", "/Users/me", "/var/tmp")).toEqual([run("/Users/me", "Library", "Caches", "TemporaryItems"), run("/var/tmp")]);
    expect(discoveryDirs({ XDG_RUNTIME_DIR: "/run/user/1000", USER: "me" }, "linux", "/home/me", "/tmp")).toEqual([run("/run/user/1000"), run("/tmp", "android-me"), run("/tmp")]);
  });
});
