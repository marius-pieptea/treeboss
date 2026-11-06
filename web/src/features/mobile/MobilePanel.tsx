import { useState } from "react";
import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { Badge, Empty, Section, Spinner } from "@/components/ui/misc";
import { useWorkspace } from "@/lib/workspace";
import { type MobileBuild, type MobilePlatform, usePreview, useMobile, useMobileActions } from "./data";

const IN_FLIGHT = ["new", "in_queue", "in_progress"];
const PLATFORM_LABEL: Record<MobilePlatform, string> = { ios: "iOS", android: "Android" };

/** The status word always comes with the color: green, amber and red carry meaning only with a word beside them. */
function StatusBadge({ status }: { status: string }) {
  const word = status.replace(/_/g, " ");
  if (IN_FLIGHT.includes(status))
    return (
      <Badge tone="amber">
        <Spinner className="size-2.5" />
        {word}
      </Badge>
    );
  if (status === "finished") return <Badge tone="green">{word}</Badge>;
  if (status === "errored") return <Badge tone="red">{word}</Badge>;
  return <Badge>{word}</Badge>;
}

function BuildRow({ build }: { build: MobileBuild }) {
  const version = [build.version, build.buildNumber ? `(${build.buildNumber})` : null].filter(Boolean).join(" ");
  return (
    <li className="flex items-center gap-2 rounded-md border border-line bg-raised px-3 py-2 text-xs">
      <span className="w-16 shrink-0 font-medium text-fg">{PLATFORM_LABEL[build.platform]}</span>
      <span className="font-mono text-fg-muted">{build.profile}</span>
      <StatusBadge status={build.status} />
      {version && <span className="font-mono text-fg-faint">{version}</span>}
      <span className="ml-auto flex items-center gap-2">
        {build.artifactUrl && (
          <a href={build.artifactUrl} target="_blank" rel="noreferrer" className="text-fg underline underline-offset-2">
            Download
          </a>
        )}
        <span className="font-mono text-fg-faint" title={build.easBuildId ?? undefined}>
          {(build.easBuildId ?? build.id).slice(-8)}
        </span>
      </span>
    </li>
  );
}

/** The Expo app of the workspace: its platforms, EAS builds, store submissions, OTA updates, listing checks and the Expo Go preview. */
export function MobilePanel() {
  const { root } = useWorkspace();
  const q = useMobile(root);
  const actions = useMobileActions(root);
  const [profile, setProfile] = useState("production");
  const [submitPlatform, setSubmitPlatform] = useState<MobilePlatform>("ios");
  const [submitProfile, setSubmitProfile] = useState("");
  const [branch, setBranch] = useState("");
  const [message, setMessage] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const preview = usePreview(root, showPreview);

  if (q.isLoading) return <Empty icon={<Spinner />} title="Reading the project" />;
  if (q.isError) return <Empty icon={<Smartphone />} title="Could not read the mobile project" hint={q.error.message} />;
  const s = q.data;
  if (!s) return null;
  if (!s.detect.isExpo)
    return <Empty icon={<Smartphone />} title="Not an Expo app" hint="Mobile builds need an expo dependency, an app.json with an expo key, an app.config.* file or an eas.json." />;

  const d = s.detect;
  const latest = (p: MobilePlatform) => s.builds.find((b) => b.platform === p);
  const submitTo = submitProfile || d.submitProfiles[0] || "";
  const builds = (p: MobilePlatform | "all") => actions.build.mutate({ platform: p, profile });

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-3">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-fg">{d.name ?? "Expo app"}</h2>
          {d.sdkVersion && <Badge tone="blue">expo {d.sdkVersion}</Badge>}
        </div>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono text-xs text-fg-muted">
          <dt>bundle id</dt>
          <dd>{d.bundleId ?? <span className="text-fg-faint">not set</span>}</dd>
          <dt>android</dt>
          <dd>{d.androidPackage ?? <span className="text-fg-faint">not set</span>}</dd>
          <dt>platforms</dt>
          <dd>{d.platforms.map((p) => PLATFORM_LABEL[p]).join(", ") || <span className="text-fg-faint">none</span>}</dd>
        </dl>
        {d.notes.map((n) => (
          <p key={n} className="text-xs text-fg-faint">
            {n}
          </p>
        ))}
      </header>

      <Section title="Builds" count={s.builds.length}>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Profile">
              <Select value={profile} onChange={setProfile} options={(d.profiles.length ? d.profiles : ["production"]).map((p) => ({ value: p, label: p }))} aria-label="Build profile" />
            </Field>
            <Button size="sm" variant="primary" disabled={actions.build.isPending} onClick={() => builds("ios")}>
              Build iOS
            </Button>
            <Button size="sm" variant="outline" disabled={actions.build.isPending} onClick={() => builds("android")}>
              Build Android
            </Button>
            <Button size="sm" variant="outline" disabled={actions.build.isPending} onClick={() => builds("all")}>
              Build both
            </Button>
          </div>
          {s.builds.length === 0 ? (
            <p className="text-xs text-fg-faint">No builds yet. A build runs on EAS and returns at once; its status updates here.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {s.builds.slice(0, 12).map((b) => (
                <BuildRow key={b.id} build={b} />
              ))}
            </ul>
          )}
          <div className="flex gap-3 text-xs text-fg-faint">
            {d.platforms.map((p) => (
              <span key={p}>
                Latest {PLATFORM_LABEL[p]}: {latest(p) ? <StatusBadge status={latest(p)!.status} /> : "none"}
              </span>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Store submission" count={s.submissions.length}>
        {d.submitProfiles.length === 0 ? (
          <p className="text-xs text-fg-faint">Add a submit profile to eas.json to send a build to TestFlight or the Play internal track.</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Platform">
                <Select
                  value={submitPlatform}
                  onChange={(v) => setSubmitPlatform(v as MobilePlatform)}
                  options={d.platforms.map((p) => ({ value: p, label: PLATFORM_LABEL[p] }))}
                  aria-label="Submit platform"
                />
              </Field>
              <Field label="Submit profile">
                <Select value={submitTo} onChange={setSubmitProfile} options={d.submitProfiles.map((p) => ({ value: p, label: p }))} aria-label="Submit profile" />
              </Field>
              <Button size="sm" variant="outline" disabled={actions.submit.isPending || !submitTo} onClick={() => actions.submit.mutate({ platform: submitPlatform, profile: submitTo })}>
                Submit latest
              </Button>
            </div>
            {s.submissions.slice(0, 5).map((x) => (
              <p key={x.id} className="flex items-center gap-2 text-xs text-fg-muted">
                <Badge tone={x.status === "submitted" ? "green" : "red"}>{x.status}</Badge>
                <span>
                  {PLATFORM_LABEL[x.platform]} ({x.profile})
                </span>
                {x.status === "failed" && x.detail && <span className="truncate text-fg-faint">{x.detail.split("\n")[0]}</span>}
              </p>
            ))}
          </div>
        )}
      </Section>

      <Section title="Over-the-air update">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            actions.update.mutate({ branch: branch.trim(), message: message.trim() }, { onSuccess: () => setMessage("") });
          }}
        >
          <Field label="Branch">
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="production" className="w-36 font-mono" />
          </Field>
          <Field label="Message">
            <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What changed" className="w-64" />
          </Field>
          <Button size="sm" type="submit" variant="primary" disabled={actions.update.isPending || !branch.trim() || !message.trim()}>
            Publish update
          </Button>
        </form>
      </Section>

      <Section title="Store listing" count={s.metadata.issues.length}>
        {!s.metadata.present ? (
          <p className="text-xs text-fg-faint">No {s.metadata.path} yet.</p>
        ) : s.metadata.issues.length === 0 ? (
          <p className="flex items-center gap-2 text-xs text-fg-muted">
            <Badge tone="green">ok</Badge> The listing meets the store limits.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {s.metadata.issues.map((i) => (
              <li key={`${i.field}:${i.problem}`} className="flex gap-2">
                <Badge tone="amber">{i.field}</Badge>
                <span className="text-fg-muted">{i.problem}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Android emulator">
        <div className="flex flex-col gap-2">
          <p className="text-xs text-fg-muted">Run the app in treeboss's Android emulator and watch it in the Emulator tab.</p>
          <Button size="sm" variant="outline" className="self-start" disabled={actions.runOnEmulator.isPending} onClick={() => actions.runOnEmulator.mutate()}>
            Run on emulator
          </Button>
        </div>
      </Section>

      <Section title="Expo Go preview">
        {!showPreview ? (
          <Button size="sm" variant="outline" className="self-start" onClick={() => setShowPreview(true)}>
            Show QR code
          </Button>
        ) : preview.isLoading ? (
          <p className="flex items-center gap-2 text-xs text-fg-faint">
            <Spinner className="size-3" /> Starting the tunnel. This can take a minute.
          </p>
        ) : preview.isError ? (
          <p className="text-xs text-red">{preview.error.message}</p>
        ) : preview.data ? (
          <div className="flex items-start gap-3">
            <img alt="QR code for the Expo Go URL" className="size-40 rounded-lg border border-line" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.data.svg)}`} />
            <div className="flex min-w-0 flex-col gap-1 text-xs">
              <span className="font-mono break-all text-fg">{preview.data.url}</span>
              <span className="text-fg-faint">Scan with Expo Go. {preview.data.started ? "The tunnel is new." : "The tunnel was already running."}</span>
            </div>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
