/**
 * tasks.md: parse it, and flip its checkboxes without touching anything else.
 *
 * The strict line format (Spec Kit's) is
 *
 *     - [ ] T012 [P] [US1] Create the User model in src/models/user.ts
 *
 * where `[P]` marks a task that can run alongside its neighbours (different files, no unfinished
 * dependency) and `[US#]` ties a task to a user story. The parser is tolerant on purpose: files are edited
 * by people and by agents, so odd spacing, other bullet characters, upper-case X, tokens in any order,
 * CRLF line endings and a missing task id all still read as tasks. Anything that looks like a checkbox
 * line but has nothing after it is reported as malformed, never silently dropped or counted.
 *
 * The writer changes exactly one character per toggled task (the one inside the brackets), so a diff of
 * tasks.md after a toggle is one line, whatever the rest of the file looks like.
 */

export interface SpecTask {
  /** Zero-based line index in the file: the stable handle for a toggle, since ids can be duplicated or absent. */
  line: number;
  /** "T012", or null when the line has no id. */
  id: string | null;
  done: boolean;
  parallel: boolean;
  /** "US1", or null. */
  story: string | null;
  /** The description with the id and markers removed. */
  text: string;
  /** The first file path mentioned in the description, if any. */
  file: string | null;
  /** The `##` heading it sits under, e.g. "Phase 3: User Story 1". */
  phase: string | null;
  /** The `###` heading under that phase, if any. */
  group: string | null;
  indent: number;
}

export interface SpecPhase {
  title: string;
  tasks: SpecTask[];
}

export interface ParsedTasks {
  tasks: SpecTask[];
  phases: SpecPhase[];
  total: number;
  done: number;
  /** Checkbox lines with no description. */
  malformed: Array<{ line: number; text: string }>;
}

const CHECKBOX = /^(\s*)[-*+]\s*\[([ xX])\]\s*(.*)$/;
const HEADING = /^(#{2,3})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const PATH = /(?:^|[\s(`'"])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]+)/;

/** Split into lines, keeping the exact line ending of each so a rewrite is byte-for-byte except the toggle. */
function splitKeep(text: string): Array<{ body: string; eol: string }> {
  const out: Array<{ body: string; eol: string }> = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === "" && m.index >= text.length) break;
    out.push({ body: m[1], eol: m[2] });
    if (m[2] === "") break;
  }
  return out;
}

export function parseTasks(text: string): ParsedTasks {
  const lines = splitKeep(text);
  const tasks: SpecTask[] = [];
  const malformed: ParsedTasks["malformed"] = [];
  const phases: SpecPhase[] = [];
  let phase: string | null = null;
  let group: string | null = null;
  let current: SpecPhase | null = null;
  let fenced = false;

  lines.forEach(({ body }, i) => {
    if (FENCE.test(body)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const h = HEADING.exec(body);
    if (h) {
      if (h[1] === "##") {
        phase = h[2];
        group = null;
        current = null;
      } else group = h[2];
      return;
    }
    const m = CHECKBOX.exec(body);
    if (!m) return;
    let rest = m[3].trim();
    if (!rest) {
      malformed.push({ line: i, text: body.trim() });
      return;
    }
    let id: string | null = null;
    let parallel = false;
    let story: string | null = null;
    // Id first, then markers in any order: "T001 [P] [US1] …", "T001 [US1] [P] …", "[P] T001 …".
    for (let guard = 0; guard < 6; guard++) {
      const idm = /^(T\d+)\b[:.)]?\s*/i.exec(rest);
      if (idm && id === null) {
        id = idm[1].toUpperCase();
        rest = rest.slice(idm[0].length);
        continue;
      }
      const marker = /^\[(P|US\d+)\]\s*/i.exec(rest);
      if (marker) {
        if (marker[1].toUpperCase() === "P") parallel = true;
        else story = marker[1].toUpperCase();
        rest = rest.slice(marker[0].length);
        continue;
      }
      break;
    }
    const task: SpecTask = {
      line: i,
      id,
      done: m[2] !== " ",
      parallel,
      story,
      text: rest.trim(),
      file: PATH.exec(rest)?.[1] ?? null,
      phase,
      group,
      indent: m[1].replace(/\t/g, "  ").length,
    };
    tasks.push(task);
    if (!current) {
      current = { title: phase ?? "Tasks", tasks: [] };
      phases.push(current);
    }
    (current as SpecPhase).tasks.push(task);
  });

  return { tasks, phases, total: tasks.length, done: tasks.filter((t) => t.done).length, malformed };
}

/** Done and total, for callers that want a progress bar and not the task graph (same rules as parseTasks: fenced code is skipped). */
export function countTasks(text: string): { done: number; total: number } {
  const { done, total } = parseTasks(text);
  return { done, total };
}

/** Set (or flip) one task's checkbox by its line index. Throws when that line is not a task. */
export function setTaskDone(text: string, line: number, done?: boolean): string {
  const lines = splitKeep(text);
  const l = lines[line];
  if (!l || !CHECKBOX.test(l.body)) throw new Error(`Line ${line + 1} is not a task.`);
  const m = /^(\s*[-*+]\s*\[)([ xX])(\])/.exec(l.body);
  if (!m) throw new Error(`Line ${line + 1} is not a task.`);
  const now = m[2] !== " ";
  const next = done === undefined ? !now : done;
  if (next === now) return text;
  l.body = m[1] + (next ? "x" : " ") + m[3] + l.body.slice(m[0].length);
  return lines.map((x) => x.body + x.eol).join("");
}

/**
 * Tick tasks by id (the agent reports "TASKS_DONE: T001, T002"). Unknown ids and already-ticked tasks
 * are ignored. Returns the new text and which ids actually changed.
 */
export function tickIds(text: string, ids: string[]): { text: string; ticked: string[] } {
  const want = new Set(ids.map((x) => x.toUpperCase()));
  let out = text;
  const ticked: string[] = [];
  for (const t of parseTasks(text).tasks) {
    if (t.id && want.has(t.id) && !t.done) {
      out = setTaskDone(out, t.line, true);
      ticked.push(t.id);
    }
  }
  return { text: out, ticked };
}

/** "TASKS_DONE: T001, T003" lines in an agent's reply. */
export function reportedDone(output: string | null | undefined): string[] {
  if (!output) return [];
  const ids: string[] = [];
  for (const m of output.matchAll(/^\s*TASKS?_DONE\s*:\s*(.+)$/gim)) for (const id of m[1].match(/T\d+/gi) ?? []) ids.push(id.toUpperCase());
  return [...new Set(ids)];
}

/** The next `n` unchecked tasks in file order. */
export function nextTasks(p: ParsedTasks, n = 5): SpecTask[] {
  return p.tasks.filter((t) => !t.done).slice(0, n);
}

/**
 * Runs of unchecked `[P]` tasks that sit next to each other in one phase, split into groups a head can own.
 * Tasks of one user story stay together (they usually touch the same files); with no stories, each task is
 * its own group. At most `maxGroups` groups come back: the rest are folded in round-robin, so the number of
 * heads never exceeds the cap. A run of one task is not parallel, so it is not returned.
 */
export function parallelGroups(p: ParsedTasks, maxGroups = 4): SpecTask[][] {
  const runs: SpecTask[][] = [];
  let run: SpecTask[] = [];
  const flush = () => {
    if (run.length > 1) runs.push(run);
    run = [];
  };
  let lastPhase: string | null | undefined;
  for (const t of p.tasks) {
    if (t.done) continue;
    if (t.parallel && (run.length === 0 || t.phase === lastPhase)) {
      run.push(t);
      lastPhase = t.phase;
    } else {
      flush();
      if (t.parallel) {
        run.push(t);
        lastPhase = t.phase;
      }
    }
  }
  flush();
  // Only the first run is started now: the rest of the phase waits for it, which is the whole point of `[P]`.
  const first = runs[0];
  if (!first) return [];
  const groups: SpecTask[][] = [];
  const byStory = new Map<string, SpecTask[]>();
  for (const t of first) {
    if (t.story) {
      const g = byStory.get(t.story);
      if (g) g.push(t);
      else {
        const ng = [t];
        byStory.set(t.story, ng);
        groups.push(ng);
      }
    } else groups.push([t]);
  }
  if (groups.length <= maxGroups) return groups;
  const folded: SpecTask[][] = groups.slice(0, maxGroups);
  groups.slice(maxGroups).forEach((g, i) => folded[i % maxGroups].push(...g));
  return folded;
}

/** One line for a task, as the agent is shown it. */
export function taskLine(t: SpecTask): string {
  return `${t.id ?? `line ${t.line + 1}`}${t.parallel ? " [P]" : ""}${t.story ? ` [${t.story}]` : ""} ${t.text}`;
}
