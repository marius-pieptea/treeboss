/**
 * The message box. With no session open it starts one (and shows the pickers that decide who runs it);
 * with a session open it sends a follow-up, or stops the running turn.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Check, ChevronDown, FileText, Settings2, Square } from "lucide-react";
import { toast } from "sonner";
import { get, post, url } from "@/lib/api";
import { bus } from "@/lib/bus";
import { fuzzyFilter } from "@/lib/fuzzy";
import { qk, useAgents, useEngines, usePairs } from "@/lib/queries";
import { useConfig, useSkills } from "@/features/settings/data";
import { assignmentLabel } from "@/features/settings/agents-logic";
import { useUi, useWs } from "@/lib/store";
import type { Agent, Pair, SessionView } from "@/lib/types";
import { useWorkspace } from "@/lib/workspace";
import { proposeMemory } from "@/features/memory/proposal";
import { cn, basename, dirname } from "@/lib/utils";
import { Dialog, Popover } from "@/components/ui/overlay";
import { ContextMeter } from "./ContextMeter";
import { QueueStrip } from "./QueueStrip";
import { useQueue } from "./queue-store";
import { SessionModelChip } from "./SessionModel";
import { AttachChips, useAttachments } from "@/features/attach/AttachPicker";
import { ContextChips, useContextPalette } from "@/features/context/useContextPalette";
import { viewChip } from "@/features/context/logic";
import type { AttachItem } from "@/features/attach/logic";
import { GoalDraftChip, ModeSegment, useGoalControl, useModeControl } from "./ModeControls";
import { PlusMenu } from "./PlusMenu";
import { DesignChip } from "@/features/design/DesignChip";
import { designProblem, needsText, parseDesignCommand, placeholderFor, takePendingDesign, type DesignIntent } from "@/features/design/composer";
import { PairChipInner, PairList, RunTabs, type RunTab } from "./RunWith";
import { takePendingPrefill } from "./prefill";
import { setupChips } from "./SetupChips";
import { TreebossToggle, setSessionTreeboss } from "./TreebossControl";
import { sessionTreeboss, treebossDefault } from "./treeboss-logic";
import { StatusSlot } from "./StatusSlot";
import { type Mode, isModeShortcut, modeView } from "./slot-logic";
import { useAskDefault } from "./ask-data";
import type { Shelf as ShelfModel } from "./chat-logic";
import { goalPayload, type GoalDraft } from "./goal-logic";
import { Checkbox, Select } from "@/components/ui/form";
import { EngineIcon, ModelIcon } from "@/components/ui/engine-icon";
import { EffortSlider, ModelPicker } from "@/components/ui/model-select";
import { UsageHover } from "./UsageHover";
import { shortModelName, showsModelMark } from "@/lib/models-logic";
import { cachedCatalog, effortAfterEngineChange, loadCatalog, modelAfterEngineChange } from "@/lib/models";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/misc";
import {
  EFFORTS,
  agentPickerPatch,
  applyMention,
  buildCreatePayload,
  effectiveSkills,
  findMentionToken,
  leadProblem,
  loadAgentChoice,
  loadPicker,
  matchAgent,
  normalizeSkillsOverride,
  pairDefaults,
  pairSummary,
  parseSlash,
  saveAgentChoice,
  savePicker,
  skillsChipLabel,
  matchSkills,
  slashSuggestions,
  type PickerState,
  SLASH_COMMANDS,
  type SlashDef,
} from "./composer-logic";

/** Rendered inside a popover so opening it fetches the daemon's current list (it may have changed elsewhere). */
function RefetchOnOpen({ refetch }: { refetch: () => unknown }) {
  useEffect(() => void refetch(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

const optionClass = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] outline-none hover:bg-active focus-visible:bg-active";

interface SuggestionItem {
  key: string;
  node: ReactNode;
  apply: () => void;
}

export interface ComposerProps {
  /** The open session, or null to start a new one. */
  session: SessionView | null;
  running: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onStarted: (sessionId: string) => void;
  onNewSession: () => void;
  /** The lead and heads, for the status slot above the box (null when the session has neither a pair nor heads). */
  shelf?: ShelfModel | null;
  onOpenHead?: (id: string) => void;
  /** A message is going out: the thread shows it before the daemon answers. */
  onSendStart?: (text: string) => void;
  /** The send failed: the thread drops the pending message. */
  onSendFail?: () => void;
}

/** What the composer sends: the text, and for a design turn which kind (the daemon builds the prompt). */
interface Outgoing {
  text: string;
  design?: DesignIntent;
}

export function Composer({ session, running, draft, setDraft, onStarted, onNewSession, shelf = null, onOpenHead, onSendStart, onSendFail }: ComposerProps) {
  const { workspace, root } = useWorkspace();
  // Read by the error handlers, which run after the draft has been cleared for the send.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const ws = useWs();
  const activeTab = ws.tabs.find((t) => t.id === ws.activeTab);
  const qc = useQueryClient();
  const engines = useEngines();
  const pairsQuery = usePairs();
  const pairs = pairsQuery;
  const agentsQuery = useAgents();
  const skillsQuery = useSkills();
  const config = useConfig();
  const [picker, setPickerState] = useState<PickerState>(loadPicker);
  // The specialized agent for the next session, remembered per workspace; and the skills list when the user
  // changed it (null: not changed, so the agent's assignment or "everything enabled" applies and nothing is sent).
  const [agentName, setAgentName] = useState<string>(() => loadAgentChoice(workspace.id));
  const [skillsOverride, setSkillsOverride] = useState<string[] | null>(null);
  // Plan mode and a goal for the next session (an open session has its own, shown and changed in place).
  const [newMode, setNewMode] = useState<Mode>("build");
  const [newDepth, setNewDepth] = useState<"quick" | "spec">("quick");
  // The model chosen for a new ask session; null follows the daemon's cheap default for the engine.
  const [askPick, setAskPick] = useState<string | null>(null);
  const [newGoal, setNewGoal] = useState<GoalDraft | null>(null);
  // A design turn: the daemon wraps the message in the design instructions (features/design/composer.ts).
  const [designIntent, setDesignIntent] = useState<DesignIntent | null>(() => takePendingDesign());
  // Specs, plans and docs for the next session (an open session keeps its own on the daemon).
  const [pendingAttach, setPendingAttach] = useState<AttachItem[]>([]);
  const attach = useAttachments(session, pendingAttach, setPendingAttach);
  const modeControl = useModeControl(session, { mode: newMode, setMode: setNewMode, depth: newDepth, setDepth: setNewDepth });
  // Treeboss mode: an open session keeps its own; the next one follows the treeboss_mode setting until the user picks (null).
  const [newTreeboss, setNewTreeboss] = useState<boolean | null>(null);
  const treebossOn = session ? sessionTreeboss(session) : (newTreeboss ?? treebossDefault(config.data));
  const treebossSwitch = useMutation({
    mutationFn: (on: boolean) => setSessionTreeboss(session!.id, on),
    onError: (e: Error) => toast.error("Could not switch treeboss mode", { description: e.message }),
  });
  const goalControl = useGoalControl(session, newGoal, setNewGoal);
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const setPicker = (patch: Partial<PickerState>) =>
    setPickerState((p) => {
      const next = { ...p, ...patch };
      savePicker(next);
      return next;
    });

  const pair = useMemo(() => pairs.data?.find((p) => p.id === picker.pairId) ?? null, [pairs.data, picker.pairId]);
  // A pair decides the lead; the pickers then show it read-only rather than letting the two disagree.
  const fromPair = pairDefaults(pair);
  const eff = fromPair ?? { engine: picker.engine, model: picker.model, effort: picker.effort };

  /**
   * Switch engine. A model id means nothing to another engine, so the model (and an effort the new engine does not
   * offer) are dropped unless the new engine's own list has them.
   */
  const chooseEngine = async (id: string, extra: Partial<PickerState> = {}) => {
    const next = cachedCatalog(qc, id) ?? (await loadCatalog(qc, id));
    setPicker({ engine: id, model: modelAfterEngineChange(picker.model, next), effort: effortAfterEngineChange(picker.effort, next?.efforts), ...extra });
  };
  const askDefault = useAskDefault(eff.engine, !session && newMode === "ask" && !pair);
  useEffect(() => setAskPick(null), [eff.engine]);
  const problem = !session ? leadProblem(engines.data, eff.engine, !!pair) : null;
  const closed = session?.status === "closed";

  const agent = useMemo(() => agentsQuery.data?.find((a) => a.name === agentName) ?? null, [agentsQuery.data, agentName]);
  const enabledSkills = useMemo(() => (skillsQuery.data ?? []).filter((x) => x.enabled).map((x) => x.name), [skillsQuery.data]);
  // What a session really gets: its own list, else its agent's, else the default set (never the whole library).
  const defaultSkills = useMemo(() => (skillsQuery.data ?? []).filter((x) => x.enabled && x.default).map((x) => x.name), [skillsQuery.data]);
  const skillsNow = effectiveSkills(skillsOverride, agent) ?? defaultSkills;

  const chooseAgent = (name: string) => {
    setAgentName(name);
    saveAgentChoice(workspace.id, name);
    setSkillsOverride(null); // a different agent starts from its own assignment
    const patch = agentPickerPatch(agentsQuery.data?.find((a) => a.name === name) ?? null, !!pair);
    if (patch) setPicker(patch);
  };

  // Forget a stored agent that no longer exists.
  useEffect(() => {
    if (agentsQuery.data && agentName && !agentsQuery.data.some((a) => a.name === agentName)) {
      setAgentName("");
      saveAgentChoice(workspace.id, "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsQuery.data]);

  // Forget a stored pair that no longer exists.
  useEffect(() => {
    if (pairs.data && picker.pairId && !pairs.data.some((p) => p.id === picker.pairId)) setPicker({ pairId: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairs.data]);

  useEffect(
    () =>
      bus.on("focus-composer", () => {
        useUi.getState().setRightTab("agent");
        setTimeout(() => area.current?.focus(), 30);
      }),
    [],
  );

  // Text pushed in from elsewhere (a picked preview element, console errors): appended after what is typed.
  useEffect(() => bus.on("composer-insert", (e) => setDraft(draft.trim() ? `${draft.replace(/\s+$/, "")}\n\n${e.text}` : e.text)));

  // The Design tab or the palette asked for a design turn.
  useEffect(
    () =>
      bus.on("composer-design", () => {
        const p = takePendingDesign();
        if (!p) return;
        setDesignIntent(p);
        setTimeout(() => area.current?.focus(), 30);
      }),
    [],
  );

  // A prompt another view prepared for a new session (Evidence's build hand-off): after what is typed, or alone.
  const takePrefill = () => {
    const text = takePendingPrefill();
    if (!text) return;
    setDraft(draftRef.current.trim() ? `${draftRef.current.replace(/\s+$/, "")}\n\n${text}` : text);
    setTimeout(() => area.current?.focus(), 30);
  };
  useEffect(() => takePrefill(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => bus.on("composer-prefill", takePrefill));

  // The palette's "Mode: …" commands.
  useEffect(() => bus.on("composer-mode", (e) => modeControl.set(e.mode)));

  // Grow with the text, up to a cap.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  /* ---------------------------------------------------------- suggestions */
  const mention = findMentionToken(draft, caret);
  const slash = slashSuggestions(draft);
  const files = useQuery({
    queryKey: [...qk.fsAll(root), "find"],
    enabled: !!mention,
    queryFn: () => get<{ files: string[] }>(url.fs(root, "find")).then((r) => r.files),
    staleTime: 20_000,
  });

  // Symbols, commits, @url, @terminal, @browser and images: chips resolved by the daemon (see features/context).
  const ctx = useContextPalette({
    root,
    mention,
    draft,
    caret,
    setDraft,
    view: viewChip(activeTab, root),
    refocus: (p) =>
      requestAnimationFrame(() => {
        area.current?.focus();
        area.current?.setSelectionRange(p, p);
        setCaret(p);
      }),
  });

  const suggestions: SuggestionItem[] = useMemo(() => {
    if (dismissed) return [];
    if (mention) {
      const fileRows: SuggestionItem[] = fuzzyFilter(mention.query, files.data ?? [], 7).map((m) => ({
        key: m.path,
        node: (
          <>
            <FileText className="size-3.5 shrink-0 text-fg-faint" />
            <span className="truncate">{basename(m.path)}</span>
            <span className="truncate font-mono text-[10.5px] text-fg-faint">{dirname(m.path)}</span>
          </>
        ),
        apply: () => {
          const r = applyMention(draft, mention, m.path, caret);
          setDraft(r.text);
          requestAnimationFrame(() => {
            area.current?.focus();
            area.current?.setSelectionRange(r.caret, r.caret);
            setCaret(r.caret);
          });
        },
      }));
      return [...ctx.entries, ...fileRows];
    }
    const q = /^\/([a-z0-9._-]*)$/i.exec(draft)?.[1]?.toLowerCase();
    const skillMatches = q === undefined ? [] : matchSkills(q, (skillsQuery.data ?? []).filter((k) => k.enabled && !SLASH_COMMANDS.some((c) => c.name === k.name)));
    if (slash.length || skillMatches.length) {
      const commandRows = slash.map((c: SlashDef) => ({
        key: c.name,
        node: (
          <>
            <span className="font-mono text-accent">/{c.name}</span>
            {c.args && <span className="font-mono text-[10.5px] text-fg-faint">{c.args}</span>}
            <span className="ml-auto truncate text-[11px] text-fg-muted">{c.help}</span>
          </>
        ),
        apply: () => {
          setDraft(`/${c.name}${c.args ? " " : ""}`);
          requestAnimationFrame(() => area.current?.focus());
        },
      }));
      // Skills sit below the commands and carry a "skill" tag, so the two kinds read differently.
      const skillRows = skillMatches.map((k) => ({
        key: `skill:${k.name}`,
        node: (
          <>
            <span className="font-mono text-fg">/{k.name}</span>
            <span className="rounded border border-line-strong px-1 text-[10px] uppercase tracking-wide text-fg-faint">skill</span>
            <span className="ml-auto truncate text-[11px] text-fg-muted">{k.description}</span>
          </>
        ),
        apply: () => {
          setDraft(`/${k.name} `);
          requestAnimationFrame(() => area.current?.focus());
        },
      }));
      return [...commandRows, ...skillRows];
    }
    return [];
  }, [dismissed, mention, slash, skillsQuery.data, files.data, draft, caret, setDraft, ctx.entries]);

  useEffect(() => setIndex(0), [suggestions.length, mention?.query]);

  /* ---------------------------------------------------------- actions */
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
    if (session) void qc.invalidateQueries({ queryKey: qk.session(session.id) });
  };

  const create = useMutation({
    mutationFn: ({ text: prompt, design }: Outgoing) =>
      post<{ session: SessionView }>(
        "/api/sessions",
        {
          ...buildCreatePayload({ prompt, cwd: workspace.path, worktree: picker.worktree, pairId: pair?.id ?? "", engine: eff.engine, model: eff.model, effort: eff.effort, agent: agent?.name ?? "", skills: skillsOverride }),
          // A design turn writes files: the daemon runs it in build mode whatever is picked here.
          ...(design ? { design } : {}),
          ...(!design && newMode === "plan" ? { mode: "plan", ...(newDepth === "spec" ? { plan_depth: "spec" } : {}) } : {}),
          // Ask starts on the engine's cheap model at low effort (the daemon picks both) unless one was chosen for it here.
          ...(design ? {} : newMode === "ask" && !pair ? { mode: "ask", model: askPick ?? "", effort: "" } : newMode === "ask" ? { mode: "ask" } : {}),
          treeboss: treebossOn,
          ...(newGoal ? { goal: goalPayload(newGoal) } : {}),
          ...(pendingAttach.length ? { attachments: pendingAttach.map((a) => ({ path: a.path, mode: a.mode })) } : {}),
          ...(ctx.payload.length ? { context: ctx.payload } : {}),
        },
      ),
    onSuccess: (r, { text: prompt, design }) => {
      if (!design) void proposeMemory(root, prompt, qc);
      setDesignIntent(null);
      setDraft("");
      setSkillsOverride(null);
      setNewGoal(null);
      setPendingAttach([]);
      ctx.clear();
      invalidate();
      onStarted(r.session.id);
    },
    onError: (e: Error, { text }) => {
      toast.error(e.message);
      onSendFail?.();
      if (!draftRef.current.trim()) setDraft(text);
    },
  });

  const send = useMutation({
    mutationFn: ({ text: message, design }: Outgoing) => post(url.session(session!.id, "send"), { message, ...(design ? { design } : {}), ...(ctx.payload.length ? { context: ctx.payload } : {}) }),
    onSuccess: (_r, { text: message, design }) => {
      if (!design) void proposeMemory(root, message, qc);
      setDesignIntent(null);
      setDraft("");
      ctx.clear();
      invalidate();
    },
    onError: (e: Error, { text }) => {
      toast.error(e.message);
      onSendFail?.();
      if (!draftRef.current.trim()) setDraft(text);
    },
  });

  const interrupt = useMutation({
    mutationFn: () => post(url.session(session!.id, "interrupt")),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const runSlash = (name: string, arg: string): boolean => {
    const needsNew = () => {
      if (session) {
        toast.message(`/${name} applies to the next session`, { description: "Start a new session first (/new)." });
        return false;
      }
      return true;
    };
    switch (name) {
      case "new":
      case "clear":
        onNewSession();
        setDraft("");
        return true;
      case "interrupt":
        if (session && running) interrupt.mutate();
        else toast.message("Nothing is running");
        setDraft("");
        return true;
      case "pair": {
        if (!needsNew()) return true;
        if (/^(none|no|off)$/i.test(arg)) {
          setPicker({ pairId: "" });
          setDraft("");
          return true;
        }
        // Pairs can be created from the CLI or another tab: look at the daemon's current list, not a cached one.
        void (async () => {
          const list = (await pairsQuery.refetch()).data ?? pairs.data ?? [];
          const wanted = arg.toLowerCase();
          const p = list.find((x) => x.title.toLowerCase() === wanted || x.id === arg) ?? list.find((x) => x.title.toLowerCase().includes(wanted));
          if (!p) toast.error(`No pair matching "${arg}"`, { description: list.length ? list.map((x) => x.title).join(", ") : "Create one in Settings > Hydra pairs." });
          else setPicker({ pairId: p.id });
        })();
        setDraft("");
        return true;
      }
      case "agent": {
        if (!needsNew()) return true;
        if (/^(none|no|off)$/i.test(arg)) {
          chooseAgent("");
          setDraft("");
          return true;
        }
        // Agents can be created from the terminal or another tab: look at the daemon's current list.
        void (async () => {
          const list = (await agentsQuery.refetch()).data ?? agentsQuery.data ?? [];
          const a = matchAgent(list, arg);
          if (!a) toast.error(`No agent matching "${arg}"`, { description: list.length ? list.map((x) => x.name).join(", ") : "Create one in Settings > Agents." });
          else {
            setAgentName(a.name);
            saveAgentChoice(workspace.id, a.name);
            setSkillsOverride(null);
            const patch = agentPickerPatch(a, !!pair);
            if (patch) setPicker(patch);
          }
        })();
        setDraft("");
        return true;
      }
      case "engine": {
        if (!needsNew()) return true;
        const e = engines.data?.find((x) => x.id === arg.toLowerCase());
        if (!e) toast.error(`Unknown engine "${arg}"`, { description: engines.data?.filter((x) => x.installed).map((x) => x.id).join(", ") });
        else void chooseEngine(e.id, { pairId: "" });
        setDraft("");
        return true;
      }
      case "model":
        if (!needsNew()) return true;
        setPicker({ model: arg, pairId: "" });
        setDraft("");
        return true;
      case "effort":
        if (!needsNew()) return true;
        {
          // What the chosen engine accepts, when its list is loaded; else the common three.
          const allowed = cachedCatalog(qc, eff.engine)?.efforts ?? [...EFFORTS];
          if (!allowed.includes(arg.toLowerCase())) toast.error(allowed.length ? `Effort is one of: ${allowed.join(", ")}` : `${eff.engine} has no effort control`);
          else setPicker({ effort: arg.toLowerCase(), pairId: "" });
        }
        setDraft("");
        return true;
    }
    return false;
  };

  const submit = () => {
    const text = draft.trim();
    // `/design …`: a design turn now, or just the chip when there is nothing to send yet.
    const dc = parseDesignCommand(text);
    if (dc && !dc.send) {
      setDesignIntent(dc.intent);
      setDraft("");
      requestAnimationFrame(() => area.current?.focus());
      return;
    }
    const design = dc ? dc.intent : designIntent;
    const body = dc ? dc.input : text;
    if (!body && !(design && !needsText(design.kind))) return;
    if (!dc) {
      const cmd = parseSlash(text);
      if (cmd && runSlash(cmd.name, cmd.arg)) return;
    }
    if (closed) return toast.error("This session is closed. Start a new one.");
    const why = design ? designProblem(design, body) : null;
    if (why) return toast.error(why);
    // A turn is running: line the message up behind it. It goes out when the turn finishes cleanly.
    if (running && session) {
      useQueue.getState().add({ sessionId: session.id, text: body, ...(design ? { design } : {}), ...(ctx.payload.length ? { context: ctx.payload } : {}) });
      setDesignIntent(null);
      setDraft("");
      ctx.clear();
      return;
    }
    const out: Outgoing = { text: body, ...(design ? { design } : {}) };
    if (!session && problem) return toast.error(problem);
    // Shown at once: the thread takes the message and the draft clears, without waiting for the daemon.
    onSendStart?.(body);
    setDraft("");
    if (!session) create.mutate(out);
    else send.mutate(out);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        suggestions[index]?.apply();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const busy = create.isPending || send.isPending;
  const canSend = (draft.trim().length > 0 || (!!designIntent && !needsText(designIntent.kind))) && !busy && !closed;
  const placeholder = closed ? "This session is closed" : running ? "Working… Enter queues your message for when it finishes" : designIntent ? placeholderFor(designIntent.kind) : modeView(modeControl.mode, modeControl.depth).placeholder(!!session);
  const planning = modeControl.mode === "plan" && !closed;
  const asking = modeControl.mode === "ask" && !closed;

  // The "@" button and the "+" menu's Mention item: put an @ at the caret and let the file suggestions open.
  const insertMention = () => {
    const el = area.current;
    const at = el?.selectionStart ?? draft.length;
    const lead = at > 0 && !/\s/.test(draft[at - 1]) ? " " : "";
    setDraft(draft.slice(0, at) + lead + "@" + draft.slice(at));
    requestAnimationFrame(() => {
      el?.focus();
      const p = at + lead.length + 1;
      el?.setSelectionRange(p, p);
      setCaret(p);
      setDismissed(false);
    });
  };

  const installed = engines.data?.filter((e) => e.installed) ?? [];
  const [modelOpen, setModelOpen] = useState(false);
  const [runTab, setRunTab] = useState<RunTab>("harness");
  // Agent and skills are picked in a small dialog from the + menu (a list is too long for the menu itself).
  const [setupView, setSetupView] = useState<"agent" | "skills" | null>(null);
  const sessionPair = useMemo(() => (session?.pair ? (pairs.data?.find((p) => p.id === session.pair) ?? null) : null), [pairs.data, session?.pair]);
  const skillsLabelNow = skillsOverride ? skillsChipLabel(skillsNow, enabledSkills) : null;

  // What the chip names: the session's own engine and model once it exists, else what the next one will use.
  const chipEngine = session ? session.engine : eff.engine;
  const askingNew = !session && newMode === "ask" && !pair;
  const chipModel = session ? (session.model ?? "") : askingNew ? (askPick ?? askDefault.data?.model ?? "") : eff.model;
  const chipLabel = `${chipEngine || "engine"} · ${chipModel || "default"}`;
  /** A pair in words for the chip's title and aria-label: "Sonnet 5.5 leads Haiku 5.5 · Team". */
  const pairText = (p: Pair) => `${pairSummary(p, engines.data)} · ${p.title}`;
  const chipInner = (
    <>
      <UsageHover engine={chipEngine}>
        <EngineIcon engine={chipEngine} className="size-3.5 shrink-0" />
      </UsageHover>
      {showsModelMark(chipEngine, chipModel) && <ModelIcon model={chipModel} engine={chipEngine} className="size-3.5 shrink-0" />}
      <span className="hidden truncate @[340px]:inline">{shortModelName(chipModel) || "default"}</span>
    </>
  );
  const chipClass = "flex h-6 min-w-0 max-w-[200px] items-center gap-1.5 rounded-md px-1.5 text-[11.5px] text-fg-muted outline-none transition-colors";

  return (
    <div className="shrink-0 border-t border-line bg-panel">
      <StatusSlot session={session} shelf={shelf} onOpenHead={onOpenHead ?? (() => {})} />
      <div className="relative px-2.5 pb-2.5 pt-2.5">
        {suggestions.length > 0 && (
          <div role="listbox" className="absolute inset-x-2.5 bottom-full mb-2 max-h-[240px] animate-slide-up overflow-y-auto rounded-xl border border-line-strong bg-overlay/95 p-1 shadow-pop backdrop-blur-md">
            {suggestions.map((s, i) => (
              <button key={s.key} role="option" aria-selected={i === index} onMouseEnter={() => setIndex(i)} onMouseDown={(e) => e.preventDefault()} onClick={s.apply} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] outline-none", i === index && "bg-active")}>
                {s.node}
              </button>
            ))}
            <div className="flex items-center gap-2 border-t border-line px-2 pt-1 text-[10px] text-fg-faint">
              <Kbd>↑↓</Kbd> move <Kbd>↵</Kbd> choose <Kbd>esc</Kbd> close
            </div>
          </div>
        )}

        {session && <QueueStrip sessionId={session.id} running={running} />}
        <div
          data-composer
          onDrop={ctx.onDrop}
          onDragOver={ctx.onDragOver}
          data-planning={planning || undefined}
          data-asking={asking || undefined}
          data-running={running || undefined}
          // Alt+P flips Build/Plan from anywhere inside the box (the text, the + menu, the mode control).
          onKeyDown={(e) => {
            if (isModeShortcut(e.nativeEvent)) {
              e.preventDefault();
              modeControl.toggle();
            }
          }}
          className={cn("aura rounded-2xl border bg-raised shadow-sm transition-[background-color,border-color,box-shadow] focus-within:bg-panel focus-within:shadow-pop", planning ? "border-violet/50 ring-1 ring-violet/20 focus-within:border-violet" : asking ? "border-accent/50 ring-1 ring-accent/25 focus-within:border-accent" : "focus-within:border-accent/60", !planning && !asking && (running ? "border-accent/30" : "border-line"))}>
          <textarea
            ref={area}
            value={draft}
            rows={1}
            disabled={closed}
            aria-label="Message"
            placeholder={placeholder}
            spellCheck
            onChange={(e) => {
              setDraft(e.target.value);
              setCaret(e.target.selectionStart);
              setDismissed(false);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onPaste={ctx.onPaste}
            onKeyDown={onKeyDown}
            // The global :focus-visible ring is unlayered CSS and beats Tailwind's outline-none; the box around the
            // textarea (focus-within) already shows focus.
            style={{ outline: "none" }}
            className="block max-h-[220px] min-h-[38px] w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-[13px] leading-[1.5] text-fg placeholder:text-fg-faint disabled:opacity-60"
          />
          <ContextChips ctx={ctx} />
          <AttachChips
            att={attach}
            extra={(() => {
              const goalChip = !session && newGoal ? <GoalDraftChip goal={newGoal} onEdit={goalControl.open} onClear={() => setNewGoal(null)} /> : null;
              const designChip = designIntent ? <DesignChip intent={designIntent} onChange={setDesignIntent} onClear={() => setDesignIntent(null)} /> : null;
              const setup = setupChips({
                fixed: session ? { agent: session.agent ?? null, worktree: session.isolation === "worktree" } : undefined,
                agent: agent?.title ?? null,
                skillsLabel: skillsLabelNow,
                worktree: picker.worktree,
                onAgent: () => setSetupView("agent"),
                onSkills: () => setSetupView("skills"),
                onClearAgent: () => chooseAgent(""),
                onClearSkills: () => setSkillsOverride(null),
                onClearWorktree: () => setPicker({ worktree: false }),
              });
              return designChip || goalChip || setup ? (
                <>
                  {designChip}
                  {goalChip}
                  {setup}
                </>
              ) : null;
            })()}
          />
          <div className="@container flex items-center gap-1 px-1.5 pb-1.5">
            <PlusMenu
              att={attach}
              closed={!!closed}
              goalActive={goalControl.active && !(!session && newGoal)}
              onGoal={goalControl.open}
              designActive={!!designIntent}
              onDesign={() => {
                setDesignIntent((d) => d ?? { kind: "brief", brainstorm: true });
                requestAnimationFrame(() => area.current?.focus());
              }}
              onMention={insertMention}
              onPickFiles={ctx.pickFiles}
              setup={session ? undefined : { agent: agent?.title ?? null, skills: skillsChipLabel(skillsNow, enabledSkills), worktree: picker.worktree, onAgent: () => setSetupView("agent"), onSkills: () => setSetupView("skills"), onWorktree: () => setPicker({ worktree: !picker.worktree }) }}
            />

            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              {session ? (
                <SessionModelChip session={session} chipClass={chipClass} chipInner={sessionPair ? <PairChipInner pair={sessionPair} /> : chipInner} chipLabel={sessionPair ? pairText(sessionPair) : chipLabel} pair={sessionPair} />
              ) : (
                <Popover
                  side="top"
                  align="start"
                  width={348}
                  open={modelOpen}
                  onOpenChange={(o) => {
                    setModelOpen(o);
                    if (o) setRunTab(pair ? "hydra" : "harness");
                  }}
                  trigger={
                    <button data-engine-chip data-pair-chip={pair ? "" : undefined} aria-label={`Run with: ${pair ? pairText(pair) : chipLabel}`} title={pair ? pairText(pair) : "Choose the harness or a Hydra pair"} className={cn(chipClass, "hover:bg-hover hover:text-fg focus-visible:bg-hover", problem && "text-amber")}>
                      {pair ? <PairChipInner pair={pair} /> : chipInner}
                      <ChevronDown className="!size-2.5 shrink-0 opacity-60" />
                    </button>
                  }
                >
                  <RunTabs tab={runTab} setTab={setRunTab} hasPair={!!pair}>
                    {runTab === "harness" ? (
                      <div data-run-harness>
                        {pair && (
                          <p data-run-pair-note className="mx-2 mb-1 rounded-md border border-violet/25 bg-violet/10 px-2 py-1.5 text-[11px] text-fg-muted">
                            The lead follows <span className="font-medium text-violet">{pair.title}</span>. Changing anything here leaves the pair: a session runs a harness or a pair, not both.
                          </p>
                        )}
                        <div className="flex items-center gap-2 px-2 pb-1">
                          <span className="w-11 shrink-0 text-[11px] text-fg-muted">Engine</span>
                          <Select
                            size="sm"
                            aria-label="Engine"
                            value={eff.engine}
                            onChange={(id) => void chooseEngine(id, { pairId: "" })}
                            options={installed.map((e) => ({ value: e.id, label: e.label, hint: e.mcp === "none" ? "no subagents" : undefined }))}
                            placeholder="engine"
                            className="flex-1"
                          />
                        </div>
                        <ModelPicker engine={eff.engine} value={askingNew ? chipModel : eff.model} onChange={(m) => (askingNew ? setAskPick(m) : setPicker({ engine: eff.engine, effort: eff.effort, model: m, pairId: "" }))} onDone={() => setModelOpen(false)} />
                        <div className="mt-1.5 flex items-center gap-2 px-2">
                          <span className="w-11 shrink-0 text-[11px] text-fg-muted">Effort</span>
                          <EffortSlider engine={eff.engine} model={eff.model} value={eff.effort} onChange={(e) => setPicker({ engine: eff.engine, model: eff.model, effort: e, pairId: "" })} />
                        </div>
                      </div>
                    ) : (
                      <PairList
                        pairs={pairs.data ?? []}
                        selectedId={picker.pairId}
                        refetch={pairsQuery.refetch}
                        note={(p) => (p.lead_engine && !installed.some((e) => e.id === p.lead_engine) ? `${p.lead_engine} is not installed.` : null)}
                        onPick={(id) => {
                          setPicker({ pairId: id });
                          if (id) setModelOpen(false);
                          else setRunTab("harness");
                        }}
                      />
                    )}
                  </RunTabs>
                </Popover>
              )}
            </div>

            <TreebossToggle
              on={treebossOn}
              disabled={!!closed || treebossSwitch.isPending}
              onToggle={() => (session ? treebossSwitch.mutate(!treebossOn) : setNewTreeboss(!treebossOn))}
              sessionId={session?.id}
              state={session?.treeboss_state}
            />
            <ModeSegment control={modeControl} />

            {session && <ContextMeter session={session} />}

            {running && canSend && (
              <Button variant="primary" size="icon" onClick={submit} aria-label="Queue message for when the turn finishes" className="size-7 rounded-full">
                <ArrowUp className="!size-4" />
              </Button>
            )}
            {running ? (
              <Button variant="danger" size="sm" onClick={() => interrupt.mutate()} disabled={interrupt.isPending} aria-label="Stop the running turn" className="animate-pop">
                <Square className="!size-2.5 fill-current" /> <span className="hidden @[380px]:inline">Stop</span>
              </Button>
            ) : (
              <Button variant="primary" size="icon" onClick={submit} disabled={!canSend} aria-label={session ? "Send message" : "Start session"} className={cn("size-7 rounded-full transition-[opacity,transform] enabled:hover:scale-105 enabled:active:scale-95", !canSend && "opacity-40")}>
                {busy ? <span className="size-3.5 animate-spin-fast rounded-full border-2 border-accent-fg/30 border-t-accent-fg" /> : <ArrowUp className="!size-4" />}
              </Button>
            )}
          </div>
        </div>
        {problem && !session && <div className="mt-1.5 px-1 text-[11px] text-amber">{problem}</div>}
      </div>
      {goalControl.dialog}
      {setupView && (
        <Dialog open onOpenChange={(o) => !o && setSetupView(null)} width={380} title={setupView === "agent" ? "Agent" : "Skills for this session"}>
          <SetupForm
            view={setupView}
            close={() => setSetupView(null)}
            agents={agentsQuery.data ?? []}
            refetchAgents={agentsQuery.refetch}
            agent={agent}
            agentName={agentName}
            skills={skillsQuery.data ?? []}
            skillsNow={skillsNow}
            skillsOverride={skillsOverride}
            setSkillsOverride={setSkillsOverride}
            enabledSkills={enabledSkills}
            defaultSkills={defaultSkills}
            chooseAgent={chooseAgent}
          />
        </Dialog>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ agent and skills */

interface SetupFormProps {
  view: "agent" | "skills";
  close: () => void;
  agents: Agent[];
  refetchAgents: () => unknown;
  agent: Agent | null;
  agentName: string;
  skills: Array<{ name: string; description: string; enabled: boolean }>;
  skillsNow: string[] | null;
  skillsOverride: string[] | null;
  setSkillsOverride: (v: string[] | null) => void;
  enabledSkills: string[];
  defaultSkills: string[];
  chooseAgent: (name: string) => void;
}

/** The two lists that shape the NEXT session and are too long for a menu. */
function SetupForm(p: SetupFormProps) {
  if (p.view === "agent") {
    return (
      <>
        <RefetchOnOpen refetch={p.refetchAgents} />
        <button className={optionClass} onClick={() => { p.chooseAgent(""); p.close(); }}>
          <Check className={cn("size-3.5 text-accent", p.agentName && "opacity-0")} />
          <span className="flex-1">No agent</span>
          <span className="text-[10px] text-fg-faint">plain session</span>
        </button>
        <div className="max-h-[240px] overflow-y-auto">
          {p.agents.map((a) => (
            <button key={a.name} className={cn(optionClass, "items-start")} onClick={() => { p.chooseAgent(a.name); p.close(); }}>
              <Check className={cn("mt-0.5 size-3.5 shrink-0 text-accent", p.agentName !== a.name && "opacity-0")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{a.title}</span>
                {a.description && <span className="line-clamp-2 block text-[11px] leading-snug text-fg-muted">{a.description}</span>}
                <span className="block truncate font-mono text-[10.5px] text-fg-faint">
                  skills: {assignmentLabel(a.skills, "skill")} · mcp: {assignmentLabel(a.mcp, "MCP server")}
                </span>
              </span>
            </button>
          ))}
        </div>
        {p.agents.length === 0 && <div className="px-2 py-2 text-xs text-fg-muted">No agents yet. An agent bundles instructions with the skills and tools it may use.</div>}
        <div className="mt-1 border-t border-line pt-1">
          <button className={optionClass} onClick={() => useUi.getState().openTab({ kind: "settings", page: "agents", title: "Agents" })}>
            <Settings2 className="size-3.5 text-fg-faint" />
            {p.agents.length ? "Manage agents…" : "Create an agent…"}
          </button>
        </div>
      </>
    );
  }
  if (p.view === "skills") {
    return (
      <>
        <p className="px-1.5 pb-1.5 text-[11px] leading-snug text-fg-muted">{p.skillsOverride ? "Changed for this session." : p.agent?.skills ? `Starts from ${p.agent.title}'s assignment.` : "The default skills (the default_skills setting). Tick to narrow this session to a list."}</p>
        <div className="max-h-[260px] overflow-y-auto">
          {p.skills.map((sk) => {
            const on = p.skillsNow === null ? sk.enabled : p.skillsNow.includes(sk.name);
            return (
              <label key={sk.name} className={cn("flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-active", !sk.enabled && "cursor-not-allowed opacity-50")}>
                <Checkbox
                  checked={on && sk.enabled}
                  className="mt-0.5"
                  label={sk.name}
                  onChange={(v) => {
                    if (!sk.enabled) return;
                    const current = p.skillsNow === null ? p.enabledSkills : p.skillsNow;
                    const next = v ? [...new Set([...current, sk.name])] : current.filter((n) => n !== sk.name);
                    p.setSkillsOverride(normalizeSkillsOverride(next, p.agent?.skills ?? p.defaultSkills, p.enabledSkills));
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px]">{sk.name}</span>
                  <span className="line-clamp-1 block text-[11px] text-fg-muted">{sk.enabled ? sk.description : "disabled in Settings, stays off"}</span>
                </span>
              </label>
            );
          })}
          {p.skills.length === 0 && <div className="px-2 py-2 text-xs text-fg-muted">No skills yet. Add some in Settings, under Skills.</div>}
        </div>
        {p.skillsOverride && (
          <div className="mt-1 border-t border-line pt-1">
            <button className={optionClass} onClick={() => p.setSkillsOverride(null)}>
              Reset to {p.agent?.skills ? `${p.agent.title}'s assignment` : "all enabled"}
            </button>
          </div>
        )}
      </>
    );
  }
  return null;
}
