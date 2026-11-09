import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { SegTabs } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { useSpecs } from "@/features/specs/data";
import type { NewPlanInput } from "./api";
import { pathOf, sourceOf, type FromKind } from "./logic";

const KINDS: Array<{ value: FromKind; label: string }> = [
  { value: "page", label: "This page" },
  { value: "spec", label: "A spec" },
  { value: "diff", label: "This branch's changes" },
  { value: "text", label: "A description" },
  { value: "manual", label: "Blank" },
];

type Mode = "draft" | "explore";

/**
 * A new plan: drafted from a source by an agent that reads it, or explored by an agent that drives the app in its own
 * browser, logs the bugs it meets and writes its walk as steps.
 */
export function NewPlanDialog({ root, currentUrl, open, onOpenChange, busy, onSubmit }: { root: string; currentUrl: string | null; open: boolean; onOpenChange: (o: boolean) => void; busy: boolean; onSubmit: (input: NewPlanInput) => void }) {
  const page = currentUrl ? pathOf(currentUrl) : null;
  const specs = useSpecs(root);
  const dirs = specs.data?.features.map((f) => f.dir) ?? [];
  const [mode, setMode] = React.useState<Mode>("draft");
  const [title, setTitle] = React.useState("");
  const [kind, setKind] = React.useState<FromKind>("manual");
  const [dir, setDir] = React.useState("");
  const [base, setBase] = React.useState("main");
  const [note, setNote] = React.useState("");
  const [appUrl, setAppUrl] = React.useState("");
  React.useEffect(() => {
    if (!open) return;
    setMode("draft");
    setTitle("");
    setKind(page ? "page" : "manual");
    setDir("");
    setNote("");
    setAppUrl("");
  }, [open]);

  const explore = mode === "explore";
  // An exploration always has something to go on: a blank source becomes the title and the note.
  const effective: FromKind = explore && kind === "manual" ? "text" : kind;
  const from = sourceOf({ kind: effective, page, dir: dir.trim(), base: base.trim() });
  const ok = title.trim() !== "" && (explore || effective !== "text" || note.trim() !== "") && (effective === "manual" || effective === "text" || from !== null);
  const submit = () =>
    ok &&
    onSubmit({
      title: title.trim(),
      ...(from ? { from } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(explore ? { explore: true, ...(appUrl.trim() ? { baseUrl: appUrl.trim() } : {}) } : {}),
    });
  const kinds = explore ? KINDS.filter((k) => k.value !== "manual").map((k) => (k.value === "text" ? { ...k, label: "What I describe" } : k)) : KINDS;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New QA plan"
      description={explore ? "An agent uses the app in its own browser, logs the bugs it finds, and suggests the steps it took as the plan." : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok || busy} onClick={submit}>
            {explore ? "Start exploring" : kind === "manual" ? "Create" : "Draft plan"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <SegTabs
          value={mode}
          onChange={(m) => setMode(m as Mode)}
          items={[
            { value: "draft", label: "Write the steps" },
            { value: "explore", label: "Explore with an agent" },
          ]}
        />
        <Field label="Title">
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Checkout flow" />
        </Field>
        <Field label={explore ? "Explore" : "Draft from"}>
          <Select value={effective} onChange={(v) => setKind(v as FromKind)} options={kinds.map((k) => ({ value: k.value, label: k.label, disabled: k.value === "page" && !page, hint: k.value === "page" ? (page ?? "no page open") : undefined }))} />
        </Field>
        {effective === "spec" && (
          <Field label="Spec folder">
            {dirs.length > 0 ? <Select value={dir} onChange={setDir} placeholder="Pick a spec" options={dirs.map((d) => ({ value: d, label: <span className="font-mono">{d}</span> }))} /> : <Input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="specs/001-checkout" className="font-mono" />}
          </Field>
        )}
        {effective === "diff" && (
          <Field label="Compared with" hint="The plan covers what changed since this branch or commit.">
            <Input value={base} onChange={(e) => setBase(e.target.value)} className="font-mono" />
          </Field>
        )}
        {effective !== "manual" && (
          <Field label={effective === "text" ? (explore ? "What to explore" : "Description") : "Note"} hint={effective === "text" && !explore ? undefined : "Optional. Anything the agent should focus on."}>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={effective === "text" ? (explore ? "Test the invite flow in Settings: invite, resend, revoke." : "What the feature does and who uses it.") : undefined} />
          </Field>
        )}
        {explore && (
          <Field label="App address" hint="Optional. Without it the agent finds the running dev server, or starts it.">
            <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="http://localhost:3000" className="font-mono" />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
