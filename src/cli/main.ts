#!/usr/bin/env bun
/**
 * trb: the treeboss CLI.
 *
 *   trb run "fix the failing test"          open a session and follow it
 *   trb run -p "Opus leads Codex" "…"       lead a Hydra pair
 *   trb ls | show | logs | attach | send | spawn | interrupt | close | merge | diff
 *   trb pair | mcp | skill | config | engines | doctor | daemon
 */
import fs from "fs";
import { VERSION } from "../version";
import { c, die } from "./fmt";
import { cmdUi } from "./commands/ui";
import { cmdCompact, cmdHandoff } from "./commands/handoff";
import { cmdGoal, cmdPlan } from "./commands/goal";
import { cmdModel } from "./commands/model";
import {
  cmdAttach,
  cmdClose,
  cmdDiff,
  cmdInterrupt,
  cmdLogs,
  cmdLs,
  cmdMerge,
  cmdRun,
  cmdAsk,
  cmdSend,
  cmdShow,
  cmdSpawn,
} from "./commands/session";
import { cmdCodegraph } from "./commands/codegraph";
import { cmdSpec } from "./commands/spec";
import { cmdAttachments } from "./commands/attach";
import { cmdDocs } from "./commands/docs";
import { cmdRoadmap } from "./commands/roadmap";
import { cmdLab } from "./commands/lab";
import { cmdEvidence } from "./commands/evidence";
import { cmdDesign } from "./commands/design";
import { cmdRemote } from "./commands/remote";
import { cmdProduct, cmdPortfolio } from "./commands/product";
import { cmdAutopilot, cmdSchedule } from "./commands/autopilot";
import { cmdEnv, cmdSecret } from "./commands/secrets";
import { cmdPr } from "./commands/pr";
import { cmdCi } from "./commands/ci";
import { cmdDeploy, cmdDomain, cmdRelease } from "./commands/deploy";
import { cmdMobile } from "./commands/mobile";
import { cmdSignals } from "./commands/signals";
import { cmdPractices } from "./commands/practices";
import { cmdChecklist } from "./commands/checklists";
import { cmdAgent, cmdConfig, cmdModels, cmdDaemon, cmdDoctor, cmdEngines, cmdMcp, cmdPair, cmdSkill } from "./commands/config";


const HELP = `${c.bold("trb")} ${VERSION}: drive coding CLIs from one daemon, with Hydra pairs, live subagents, MCPs and skills.

${c.bold("Work")}
  trb ui [dir]                  open the web UI on a directory
  trb . | trb <dir>             the same, for a folder you name directly
  trb run "<prompt>"            open a session and follow it       [-e engine] [-m model] [--effort e] [-p pair] [-a agent] [-C dir] [-w] [-d] [--plan|--ask] [-g goal --check cmd] [--json]
  trb ask "<question>"          read-only question on a cheap model, answer printed [-e engine] [-m model] [-C dir]
  trb ls                        list sessions                      [-a all depths] [--closed] [--json]
  trb show [id]                 the session tree and last answer   [--full] [--json]
  trb logs [id]                 the run log                        [-f follow] [--tree] [--last]
  trb attach <id>               follow a running session live
  trb send <id> "<message>"     follow up (resumes the engine session)  [--mode build|plan|ask]
  trb model <id> [<model>]      show the session's model, or switch it for the next turn (same engine)   [--effort e]
  trb goal <id> ["<goal>"]      show, set (--check "<cmd>" --max-turns n --max-minutes n) or stop the goal
  trb plan <id> [on|off|approve] plan mode: read-only until you approve; approve switches to build
  trb spawn <id> "<brief>"      open a subagent under a session    [-r role] [-e engine] [-m model]
  trb interrupt <id>            stop the current turn (keeps context)
  trb merge <id>                apply a subagent's worktree changes to its parent as uncommitted edits
  trb diff <id>                 a subagent's committed changes
  trb close <id>                close a session (and its subagents)
  trb handoff <id>              start a fresh session from a summary of this one   [-e engine] [-m model] [-a agent] [-i next] [--print] [-d]
  trb compact <id>              ask the engine to compact its context in place (claude)

${c.bold("Configure")}
  trb agent [list|show|add|edit|rm]             specialized agents: instructions + the skills and MCPs they may use
  trb pair [list|add|edit|rm|recipes|roles]     Hydra pairs: who leads, what the heads run
  trb mcp  [list|add|rm|enable|disable|import|test]
  trb skill [list|add|new|import|show|rm|enable|disable|packs|pack <id> on|off]
  trb config [list|get|set|reset]
  trb engines                   which coding CLIs are installed
  trb models <engine>           the models an engine offers [--refresh]
  trb spec  [ls|new|constitution|show|tasks|step|attach|implement|architecture]  specs the agents work from (constitution, specs, plans, tasks)
  trb lab [show|run|sweep|sweeps|cancel|roadmap|spec|fix|design|dismiss|ship|reopen|rm]  find what to improve (features, ui, ai, perf, dx, review) and act on it
  trb evidence [ls|show|capture|note|export|rm|investigations|investigate|run|close|findings|status|build|on|off|rea]  what agents captured from web pages and concluded, kept per project (on by default; trb evidence off turns it off); investigations group a reverse-engineering run, findings are features and UI designs to build; "rea off" stops offering the third-party REA reverse-engineering MCP server (on by default)
  trb roadmap [show|init|add|move|done|edit|rm|start]  the roadmap (ROADMAP.md): lanes, items, spec progress, sessions from an item
  trb design [show|systems|apply|save|start]  the design system (DESIGN.md + design/tokens.css): apply from the library, generate, wire, review
  trb attachments <session> [path…]  specs, plans and docs a session has attached (attach, --inline, --detach)
  trb docs   [ls|stale|new|init|current|generate|attach]  the project's documentation: pages, how fresh each is, writing and refreshing them with an agent
  trb codegraph [status|init|sync|index|uninit] the code index agents get as tools (init only on request)
  trb remote [status|pair|ls|revoke]  pair a phone with a QR code and manage paired devices (off by default: trb config set remote_mode lan|tailscale)
  trb secret [ls|set|unset|import|export] [--env dev|staging|prod]  a workspace's encrypted secrets, per environment
  trb practices [ls|enable|disable|check]  practice packs: maintainability rules agents follow here, and their checks
  trb env [ls|add|rm]           the workspace's environments (dev, staging, prod, or your own)
  trb doctor                    check the whole setup
  trb daemon [start|stop|restart|status|logs]

${c.bold("Ship")}
  trb product [ls|new|show|attach|detach|set-status|budget]  products: the things you ship, with their repos and spend
  trb portfolio [--json]        every product on one screen: roadmap progress, last verify, spend vs budget
  trb autopilot [start|ls|show|pause|resume|stop|approve|reject]  unattended runs over a spec's tasks, with approval gates
  trb schedule [ls|add|rm|run]  cron-style jobs: prompts, lab sweeps, checks, dependency updates, signal syncs
  trb pr [create|ls|checks|merge]  pull requests of a session, through the GitHub CLI (gh)
  trb ci init [--write]         the CI workflow (.github/workflows/ci.yml) from what the project has
  trb deploy [env] | targets | history | rollback   deploy an environment and see what each deploys with
  trb release range|draft|drafts|publish|ls        what a release covers, agent-drafted notes, publish (push, GitHub release, deploy)
  trb release plan|cut <patch|minor|major>         the quick path: preview, or cut, the bump, a mechanical changelog, commit and tag
  trb domain [add|check] <domain> --target <host>  DNS for a deploy target
  trb mobile [show|metadata|build|builds|submit|update|preview]  the Expo and EAS pipeline: builds, store submit, updates
  trb signals [ls|sync|triage|token|widget]        what the product reports back: errors, metrics, widget feedback
  trb checklist [ls|attach|detach|show|check|tick|fix|audit|stack|new|edit|reset|rm|item]  launch checklists: what must pass before a prod deploy, and the catalog they come from

<id> may be a unique prefix, or "last". Ctrl-C during \`trb run\` interrupts the turn; \`-d\` detaches.
State lives in ${c.dim("~/.treeboss")} (override with TRB_HOME).`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return 0;
    case "-v":
    case "--version":
    case "version":
      console.log(VERSION);
      return 0;
    case "ui":
      return cmdUi(rest);
    case "run":
      return cmdRun(rest);
    case "ask":
      return cmdAsk(rest);
    case "ls":
    case "list":
      return cmdLs(rest);
    case "show":
      return cmdShow(rest);
    case "logs":
      return cmdLogs(rest);
    case "attach":
      return cmdAttach(rest);
    case "send":
      return cmdSend(rest);
    case "spawn":
      return cmdSpawn(rest);
    case "interrupt":
      return cmdInterrupt(rest);
    case "close":
      return cmdClose(rest);
    case "merge":
      return cmdMerge(rest);
    case "model":
      return cmdModel(rest);
    case "goal":
      return cmdGoal(rest);
    case "plan":
      return cmdPlan(rest);
    case "handoff":
      return cmdHandoff(rest);
    case "compact":
      return cmdCompact(rest);
    case "diff":
      return cmdDiff(rest);
    case "agent":
    case "agents":
      return cmdAgent(rest);
    case "pair":
    case "pairs":
      return cmdPair(rest);
    case "mcp":
      return cmdMcp(rest);
    case "skill":
    case "skills":
      return cmdSkill(rest);
    case "config":
      return cmdConfig(rest);
    case "models":
      return cmdModels(rest);
    case "codegraph":
      return cmdCodegraph(rest);
    case "spec":
    case "specs":
      return cmdSpec(rest);
    case "roadmap":
      return cmdRoadmap(rest);
    case "lab":
      return cmdLab(rest);
    case "evidence":
      return cmdEvidence(rest);
    case "design":
      return cmdDesign(rest);
    case "remote":
      return cmdRemote(rest);
    case "product":
      return cmdProduct(rest);
    case "portfolio":
      return cmdPortfolio(rest);
    case "autopilot":
      return cmdAutopilot(rest);
    case "schedule":
      return cmdSchedule(rest);
    case "secret":
      return cmdSecret(rest);
    case "env":
      return cmdEnv(rest);
    case "pr":
      return cmdPr(rest);
    case "ci":
      return cmdCi(rest);
    case "deploy":
      return cmdDeploy(rest);
    case "release":
      return cmdRelease(rest);
    case "domain":
      return cmdDomain(rest);
    case "mobile":
      return cmdMobile(rest);
    case "signals":
      return cmdSignals(rest);
    case "practices":
      return cmdPractices(rest);
    case "checklist":
      return cmdChecklist(rest);
    case "attachments":
      return cmdAttachments(rest);
    case "docs":
      return cmdDocs(rest);
    case "engines":
      return cmdEngines(rest);
    case "doctor":
      return cmdDoctor();
    case "daemon":
      return cmdDaemon(rest);
    case "mcp-serve": {
      // Not for humans: the stdio MCP server a CLI engine spawns. Keep stdout clean.
      const { serveMcp } = await import("../mcp/serve");
      await serveMcp();
      return 0;
    }
    default:
      // `trb .` or `trb <dir>` opens that folder, the same as `trb ui <dir>`.
      if (cmd && fs.statSync(cmd, { throwIfNoEntry: false })?.isDirectory()) return cmdUi([cmd, ...rest]);
      die(`Unknown command "${cmd}". Try \`trb help\`.`);
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(c.red("error: ") + (err?.message ?? err));
    process.exit(1);
  },
);
