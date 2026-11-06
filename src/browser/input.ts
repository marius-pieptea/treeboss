/**
 * The operator taking over: clicks, keys, scrolling and navigation sent from the live view. These go through the
 * same `act` as the agent's tools, so the status line, the busy light and the frame stream behave identically;
 * the actor is "you".
 */
import { BrowserError, act, checkUrl, closeTab, getContext, newTab, rootOf, setActiveTab } from "./manager";

export type BrowserInput =
  | { kind: "click"; x: number; y: number; double?: boolean }
  | { kind: "scroll"; dx: number; dy: number; x?: number; y?: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "navigate"; url: string }
  | { kind: "back" }
  | { kind: "reload" }
  | { kind: "select_tab"; index: number }
  | { kind: "new_tab"; url?: string }
  | { kind: "close_tab"; index: number };

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export async function userInput(sessionId: string, input: BrowserInput): Promise<void> {
  if (!rootOf(sessionId)) throw new BrowserError(`No session "${sessionId}".`);
  const c = await getContext(sessionId);
  const run = (label: string, fn: Parameters<typeof act<void>>[2]) => act(c, { label, actor: "you", sessionId }, fn);
  switch (input.kind) {
    case "click":
      if (!fin(input.x) || !fin(input.y)) throw new BrowserError("click needs numeric x and y.");
      return run(`Clicking at (${Math.round(input.x)}, ${Math.round(input.y)})`, async (p) => {
        await p.mouse.click(input.x, input.y, { clickCount: input.double ? 2 : 1 });
      });
    case "scroll":
      if (!fin(input.dx) || !fin(input.dy)) throw new BrowserError("scroll needs numeric dx and dy.");
      return run("Scrolling", async (p) => {
        if (fin(input.x) && fin(input.y)) await p.mouse.move(input.x, input.y);
        await p.mouse.wheel(input.dx, input.dy);
      });
    case "type":
      if (typeof input.text !== "string" || !input.text) throw new BrowserError("type needs text.");
      return run("Typing", async (p) => {
        await p.keyboard.type(input.text.slice(0, 2000));
      });
    case "key":
      if (typeof input.key !== "string" || !input.key) throw new BrowserError("key needs a key name.");
      return run(`Pressing ${input.key}`, async (p) => {
        await p.keyboard.press(input.key);
      });
    case "navigate": {
      const v = checkUrl(String(input.url ?? ""));
      if (!v.ok) throw new BrowserError(v.error);
      return run(`Opening ${v.url}`, async (p) => {
        await p.goto(v.url, { waitUntil: "domcontentloaded" });
      });
    }
    case "back":
      return run("Going back", async (p) => {
        await p.goBack({ waitUntil: "domcontentloaded" });
      });
    case "reload":
      return run("Reloading", async (p) => {
        await p.reload({ waitUntil: "domcontentloaded" });
      });
    case "select_tab":
      if (!fin(input.index)) throw new BrowserError("select_tab needs an index.");
      setActiveTab(c, input.index);
      return;
    case "new_tab":
      return run("Opening a tab", async () => {
        await newTab(c, typeof input.url === "string" && input.url.trim() ? input.url : undefined);
      });
    case "close_tab":
      if (!fin(input.index)) throw new BrowserError("close_tab needs an index.");
      return run(`Closing tab ${input.index}`, () => closeTab(c, input.index));
    default:
      throw new BrowserError("Unknown input.");
  }
}
