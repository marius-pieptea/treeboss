/** `trb codegraph [status|init|sync|index]`: the code index the agents get as MCP tools. Only `init` creates one, and only when asked. */
import path from "path";
import { opts } from "../args";
import { CODEGRAPH_INSTALL_COMMAND, codegraphStatus } from "../../codegraph/detect";
import { startCodegraph, getCodegraphJob, cancelCodegraphJob, type CodegraphJobMode } from "../../codegraph/jobs";
import { estimateIndexSize } from "../../codegraph/estimate";
import { uninitCodegraph } from "../../codegraph/uninit";
import { c, die, printJson } from "../fmt";

export async function cmdCodegraph(argv: string[]): Promise<number> {
  const { values, positionals } = opts(argv, { json: { type: "boolean" }, "no-gitignore": { type: "boolean" }, yes: { type: "boolean" } });
  const sub = positionals[0] ?? "status";
  const dir = path.resolve(positionals[1] ?? process.cwd());
  if (sub === "status") {
    const st = codegraphStatus(dir, { fresh: true });
    if (values.json) return printJson(st);
    if (!st.available) console.log(c.yellow("CodeGraph is not available: no bundled copy, no codegraph_bin setting, nothing on PATH.") + c.dim(`\n  ${CODEGRAPH_INSTALL_COMMAND}`));
    else if (st.state === "none") {
      const est = estimateIndexSize(dir);
      console.log(`Not initialized. Run ${c.bold("trb codegraph init")} to create the index for ${dir} (about ${est.files.toLocaleString("en-US")} source files).`);
      if (est.warning) console.log(c.yellow(est.warning));
    } else if (st.state === "incomplete") console.log(`${c.yellow("incomplete")}  ${st.note ?? "The last index run never finished."} Run ${c.bold("trb codegraph index")}.  ${c.dim(st.root ?? "")}`);
    else console.log(`${st.state === "stale" ? c.yellow("stale") : c.green("indexed")}  ${st.symbols} symbols, ${st.files} files, ${st.edges} edges  ${c.dim(st.root ?? "")}${st.pendingChanges ? c.dim(`  (${st.pendingChanges} pending changes: trb codegraph sync)`) : ""}`);
    if (st.available) console.log(c.dim(`codegraph ${st.version ?? "?"} (${st.source})${st.reindexRecommended ? `, index built by ${st.builtWith ?? "an older version"}: trb codegraph index recommended` : ""}${st.note && st.state !== "incomplete" ? `. ${st.note}` : ""}`));
    console.log(c.dim(`sessions: ${st.setting}${st.useOverride ? " (this workspace)" : " (global: trb config set codegraph auto|off)"}   keep in sync: ${st.keepInSync ? "on" : "off"}`));
    return 0;
  }
  if (sub === "uninit") {
    if (!values.yes) return die("This deletes the .codegraph/ index. Run again with --yes to confirm.");
    try {
      console.log(c.green(`removed ${uninitCodegraph(dir).removed}`));
      return 0;
    } catch (e: any) {
      return die(e.message);
    }
  }
  if (sub === "init" || sub === "sync" || sub === "index") {
    const mode: CodegraphJobMode = sub === "index" ? "reindex" : sub;
    let job;
    try {
      job = startCodegraph(dir, mode, { gitignore: mode === "init" && !values["no-gitignore"] });
    } catch (e: any) {
      return die(e.message);
    }
    let last = "";
    // Ctrl-C stops the job (and removes a partial index this run created) instead of leaving it behind.
    process.once("SIGINT", () => void cancelCodegraphJob(job.id).then(() => process.exit(130)));
    while (getCodegraphJob(job.id)?.state === "running") {
      const j = getCodegraphJob(job.id)!;
      const tail = j.progress.phase ? `${j.progress.phase}${j.progress.percent !== null ? ` ${j.progress.percent}%` : ""}${j.progress.detail ? ` (${j.progress.detail})` : ""}` : (j.log[j.log.length - 1] ?? "");
      if (tail && tail !== last) console.log(c.dim((last = tail)));
      await Bun.sleep(300);
    }
    const done = getCodegraphJob(job.id)!;
    if (done.state === "failed") return die(done.error ?? `${sub} failed`);
    if (done.state === "cancelled") return die(done.note ?? "cancelled");
    if (done.note) console.log(c.dim(done.note));
    console.log(c.green(done.summary ?? "done"));
    return 0;
  }
  return die("Usage: trb codegraph [status|init|sync|index|uninit] [path]   (init: --no-gitignore, uninit: --yes)");
}
