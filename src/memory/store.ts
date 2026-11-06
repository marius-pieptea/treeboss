/**
 * Project memory over a workspace's files. Rules live in the managed block of AGENTS.md (the source of
 * truth); CLAUDE.md gets the same block so claude, which does not read AGENTS.md, sees them too. Only the
 * block is rewritten. No database: the rules travel with the repo.
 */
import fs from "fs";
import path from "path";
import { UserError } from "../util";
import { cleanRule, findBlock, parseRules, ruleId, spliceRules } from "./block";

export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";
const MAX_RULES = 200;
const MAX_RULE_CHARS = 400;
const MAX_FILE_BYTES = 2_000_000;

export interface Rule {
  id: string;
  text: string;
}

export interface MemoryView {
  rules: Rule[];
  files: Array<{ path: string; exists: boolean; managed: boolean; /** why a mirror is skipped */ note: string | null }>;
}

function realOf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The file inside the root, refusing a symlink that leads out of it. */
export function fileIn(root: string, name: string): string {
  const base = realOf(root);
  const abs = path.join(base, name);
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) {
    const target = realOf(abs);
    const rel = path.relative(base, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new UserError(`${name} is a symlink that leaves the workspace; refusing to write it.`);
  }
  return abs;
}

export function read(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new UserError(`${path.basename(abs)} is not a file.`);
    if (st.size > MAX_FILE_BYTES) throw new UserError(`${path.basename(abs)} is too large to manage.`);
    return fs.readFileSync(abs, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

export function writeAtomic(abs: string, content: string): void {
  const tmp = `${abs}.trb-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, abs);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const importsAgents = (content: string): boolean => /^\s*@\.?\/?AGENTS\.md\s*$/m.test(content);

/** CLAUDE.md is mirrored unless it already defers to AGENTS.md (an `@AGENTS.md` import, or a symlink to it). */
export function mirrorSkipReason(root: string, agentsAbs: string, claudeAbs: string): string | null {
  const st = fs.lstatSync(claudeAbs, { throwIfNoEntry: false });
  if (st?.isSymbolicLink() && realOf(claudeAbs) === realOf(agentsAbs)) return "CLAUDE.md is a link to AGENTS.md";
  const text = read(claudeAbs);
  if (text !== null && importsAgents(text)) return "CLAUDE.md imports AGENTS.md";
  return null;
}

export function readRules(root: string): Rule[] {
  const a = read(fileIn(root, AGENTS_FILE));
  let texts = a === null ? [] : parseRules(a);
  if (!texts.length) {
    const c = read(fileIn(root, CLAUDE_FILE));
    if (c !== null) texts = parseRules(c);
  }
  const seen = new Set<string>();
  const rules: Rule[] = [];
  for (const text of texts) {
    const id = ruleId(text);
    if (seen.has(id)) continue;
    seen.add(id);
    rules.push({ id, text });
  }
  return rules;
}

export function memoryView(root: string): MemoryView {
  const agents = fileIn(root, AGENTS_FILE);
  const claude = fileIn(root, CLAUDE_FILE);
  const a = read(agents);
  const c = read(claude);
  const skip = mirrorSkipReason(root, agents, claude);
  return {
    rules: readRules(root),
    files: [
      { path: AGENTS_FILE, exists: a !== null, managed: a !== null && !!findBlock(a), note: null },
      { path: CLAUDE_FILE, exists: c !== null, managed: c !== null && !!findBlock(c), note: skip },
    ],
  };
}

/** Write `rules` into both files. Everything is validated before the first write, so a damaged CLAUDE.md does not leave AGENTS.md half done. */
function writeRules(root: string, rules: Rule[]): void {
  const texts = rules.map((r) => r.text);
  const agents = fileIn(root, AGENTS_FILE);
  const claude = fileIn(root, CLAUDE_FILE);
  const aOld = read(agents);
  const cOld = read(claude);
  const aNew = spliceRules(aOld ?? "", texts);
  const mirror = !mirrorSkipReason(root, agents, claude);
  const cNew = mirror ? spliceRules(cOld ?? "", texts) : null;

  const put = (abs: string, old: string | null, next: string) => {
    if (old === next) return;
    // A file that only held our block disappears with it.
    if (!next.trim() && old !== null) fs.rmSync(abs, { force: true });
    else if (next.trim()) writeAtomic(abs, next);
  };
  put(agents, aOld, aNew);
  if (cNew !== null) put(claude, cOld, cNew);
}

function checkText(text: string): string {
  const t = cleanRule(text);
  if (!t) throw new UserError("A rule cannot be empty.");
  if (t.length > MAX_RULE_CHARS) throw new UserError(`A rule is at most ${MAX_RULE_CHARS} characters.`);
  if (/<!--|-->/.test(t)) throw new UserError("A rule cannot contain HTML comment markers.");
  return t;
}

export function addRule(root: string, text: string): { rule: Rule; added: boolean } {
  const t = checkText(text);
  const rules = readRules(root);
  const id = ruleId(t);
  const same = rules.find((r) => r.id === id);
  if (same) return { rule: same, added: false };
  if (rules.length >= MAX_RULES) throw new UserError(`At most ${MAX_RULES} rules.`);
  const rule = { id, text: t };
  writeRules(root, [...rules, rule]);
  return { rule, added: true };
}

export function updateRule(root: string, id: string, text: string): Rule {
  const t = checkText(text);
  const rules = readRules(root);
  const i = rules.findIndex((r) => r.id === id);
  if (i < 0) throw new UserError("No such rule (it may have been edited elsewhere); reload the list.");
  const nid = ruleId(t);
  if (nid !== id && rules.some((r) => r.id === nid)) throw new UserError("Another rule already says that.");
  const rule = { id: nid, text: t };
  rules[i] = rule;
  writeRules(root, rules);
  return rule;
}

export function deleteRule(root: string, id: string): void {
  const rules = readRules(root);
  if (!rules.some((r) => r.id === id)) throw new UserError("No such rule (it may have been edited elsewhere); reload the list.");
  writeRules(root, rules.filter((r) => r.id !== id));
}

/** Add several at once (the scaffolder seeds a new project with its recipe's conventions). */
export function addRules(root: string, texts: string[]): number {
  const rules = readRules(root);
  let n = 0;
  for (const raw of texts) {
    const t = checkText(raw);
    const id = ruleId(t);
    if (rules.some((r) => r.id === id) || rules.length >= MAX_RULES) continue;
    rules.push({ id, text: t });
    n++;
  }
  if (n) writeRules(root, rules);
  return n;
}
