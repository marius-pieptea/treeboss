/** `trb ui [dir]`: open the web UI on a directory. */
import path from "path";
import { opts } from "../args";
import { api, connect } from "../client";
import { c, die } from "../fmt";
import { uiBuilt } from "../../daemon/ui";

export async function cmdUi(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { "no-open": { type: "boolean" } });
  const dir = path.resolve(positionals[0] ?? process.cwd());
  const { info } = await connect();
  const { workspace } = await api<{ workspace: { id: string; name: string; path: string } }>("POST", "/api/workspaces", { path: dir });
  const { ticket } = await api<{ ticket: string }>("POST", "/api/ui/ticket");

  if (!uiBuilt()) {
    console.error(c.yellow("The UI is not built yet: run `bun run build:web` in the treeboss directory, then `trb ui` again."));
  }
  const plain = `${info.url}/w/${workspace.id}`;
  // The ticket is single-use and lives 60 seconds; the plain URL is what you bookmark.
  const signIn = `${info.url}/_auth?ticket=${ticket}&to=${encodeURIComponent(`/w/${workspace.id}`)}`;
  console.log(`${c.bold(workspace.name)}  ${c.dim(workspace.path)}\n${plain}`);

  if (values["no-open"]) {
    console.log(c.dim(`\nsign-in link (single use, 60s):\n${signIn}`));
    return 0;
  }
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  if (!Bun.which(opener)) die(`Could not find \`${opener}\` to open a browser. Use --no-open and paste the sign-in link.`);
  Bun.spawn([opener, signIn], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true }).unref();
  return 0;
}
