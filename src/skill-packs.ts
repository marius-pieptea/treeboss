/**
 * The skill packs as the operator sees them: which packs ship with trb, what each one's pack.json says, and how many of
 * its skills are in the store and on. The Skills page (GET /api/skills/packs, POST /api/skills/packs/:id/enabled) and
 * `trb skill packs` / `trb skill pack` both read and change them through here.
 *
 * A pack skill counts as installed only while the store holds it as a built-in of that pack. A skill of yours that shares
 * its name is neither counted nor touched, and a pack skill you deleted stays deleted until "Restore built-in skills".
 */
import { db } from "./db";
import { builtinSkills, isBuiltin } from "./skills/builtin";
import { packSkillNames, packsRoot, readPacks, type PackManifest } from "./skills/packs";
import { SkillStore, type SkillRecord } from "./skills/store";

export interface SkillPack {
  id: string;
  title: string;
  version: string;
  author: string;
  license: string;
  upstream: string;
  commit: string;
  /** The skills its manifest lists: the vendored ones, then the ones written in this repo. */
  skills: string[];
  /** How many of them are in the store as this pack's built-ins. */
  installed: number;
  /** How many of those are on. */
  enabled: number;
}

/** What a change to a pack reports back: the same counts the list shows. */
export interface SkillPackCounts {
  id: string;
  installed: number;
  enabled: number;
}

/** Every pack that ships at least one skill, by title. */
export function listSkillPacks(): SkillPack[] {
  return shippingPacks()
    .map(({ manifest: m, skills, installed }) => ({
      id: m.id,
      title: m.title || m.id,
      version: m.version,
      author: m.author,
      license: m.license,
      upstream: m.upstream,
      commit: m.commit,
      skills,
      installed: installed.length,
      enabled: installed.filter((r) => r.enabled).length,
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** Turns every installed skill of a pack on or off, in one transaction. Null when no pack has that id. */
export function setSkillPackEnabled(id: string, enabled: boolean): SkillPackCounts | null {
  const pack = shippingPacks().find((p) => p.manifest.id === id);
  if (!pack) return null;
  db().transaction(() => {
    for (const r of pack.installed) SkillStore.setEnabled(r.name, enabled);
  })();
  return { id, installed: pack.installed.length, enabled: enabled ? pack.installed.length : 0 };
}

/** A pack that ships at least one skill: its manifest, the skills it lists, and the store's records for those it has. */
interface ShippingPack {
  manifest: PackManifest;
  skills: string[];
  installed: SkillRecord[];
}

/**
 * The packs that ship, from the one manifest reader (readPacks). A skill the manifest lists whose folder is missing still
 * appears in `skills`, but it is never installed, so it is never counted. The loader has already reported any pack it
 * skipped when the daemon started, so this read stays quiet rather than repeating that on every request.
 */
function shippingPacks(): ShippingPack[] {
  const packOf = new Map<string, string>();
  for (const b of builtinSkills()) if (b.pack) packOf.set(b.name, b.pack);
  const out: ShippingPack[] = [];
  for (const { manifest } of readPacks(packsRoot(), () => {})) {
    const skills = packSkillNames(manifest);
    if (!skills.some((n) => packOf.get(n) === manifest.id)) continue;
    out.push({ manifest, skills, installed: installedOf(manifest.id, skills, packOf) });
  }
  return out;
}

/** The store's records for a pack's skills, keeping only those that are a built-in of this pack. */
function installedOf(id: string, names: string[], packOf: Map<string, string>): SkillRecord[] {
  return names.flatMap((name) => {
    const rec = SkillStore.get(name);
    return rec && isBuiltin(rec) && packOf.get(name) === id ? [rec] : [];
  });
}
