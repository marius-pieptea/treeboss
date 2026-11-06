/**
 * How agents should do design work, written once and used twice: in the prompts of design sessions
 * (sessions.ts) and in the skills that ship with trb (skills/builtin.ts), so the two never drift.
 *
 * The habits (ask only what changes the result, offer directions instead of one answer, extract real values
 * from a reference instead of recalling them, critique before finishing) are adapted from open-design
 * (https://github.com/nexu-io/open-design, Apache-2.0); see NOTICE. The text and the direction library are
 * trb's own.
 */
import { DESIGN_FILE, TOKENS_FILE } from "./contract";

export const DIRECTIONS_FILE = "design/directions.html";

/** A starting point for a direction: a genre, not a brand. The agent adapts it to the product. */
export interface Direction {
  id: string;
  name: string;
  mood: string;
  type: string;
  palette: string;
  posture: string;
  fitsFor: string;
}

export const DIRECTION_LIBRARY: Direction[] = [
  { id: "quiet-product", name: "Quiet product", mood: "Calm, exact, trustworthy; the data is the loudest thing on screen.", type: "One neo-grotesk family for display and body (Inter, Geist, IBM Plex Sans), tabular numerals.", palette: "Cool or neutral grays, one saturated accent used for action only.", posture: "Hairline borders over shadows, compact density, 6-8px radii, strict grid.", fitsFor: "SaaS, dashboards, internal tools, developer products." },
  { id: "editorial", name: "Editorial", mood: "Literate and considered, like a well-set magazine.", type: "A characterful serif for display (Fraunces, Newsreader, Instrument Serif) over a quiet sans body.", palette: "Paper and ink with one restrained accent; neutral paper, not beige wash, unless the brand calls for warmth.", posture: "Generous margins, long comfortable measure, rules instead of cards, nearly square corners.", fitsFor: "Content, publishing, portfolios, considered marketing pages." },
  { id: "technical", name: "Technical utility", mood: "Precise, instrument-like, built for experts.", type: "A monospace or grotesk-mono pairing (JetBrains Mono, Space Mono with a grotesk) for labels and numbers.", palette: "Near-black or off-white canvas, one signal color, status colors that mean something.", posture: "Dense tables, visible structure, small radii, keyboard-first states.", fitsFor: "Developer tools, terminals, data products, infrastructure." },
  { id: "bold-graphic", name: "Bold graphic", mood: "Loud, direct, confident; nothing soft or vague.", type: "A heavy grotesk display at large sizes (Space Grotesk, Archivo, Bricolage Grotesque), tight tracking.", palette: "Black and white with one electric accent used as a highlighter.", posture: "Thick borders, square corners, hard offset shadows, overlapping elements allowed.", fitsFor: "Launches, campaigns, creative tools, youth-oriented products." },
  { id: "soft-friendly", name: "Soft and friendly", mood: "Warm, encouraging, safe to explore.", type: "A rounded or humanist sans (Nunito, Manrope, Plus Jakarta Sans) with heavier headings.", palette: "Light tinted surfaces, a gentle primary and a cheerful secondary for progress.", posture: "Generous radii, soft shadows, airy spacing, celebratory micro-moments.", fitsFor: "Consumer apps, onboarding, health and habit products, education." },
  { id: "luxe-dark", name: "Luxe dark", mood: "Premium, cinematic, quiet confidence.", type: "A refined display serif or wide grotesk (Cormorant, Syne) with a light-weight body.", palette: "Deep near-black surfaces, warm metallic or jewel-tone accent used sparingly.", posture: "Large imagery, slow motion, thin rules, plenty of negative space.", fitsFor: "Premium services, hospitality, fashion, high-end consumer products." },
];

export function directionLibraryMarkdown(): string {
  return DIRECTION_LIBRARY.map((d) => `- **${d.name}**: ${d.mood} Type: ${d.type} Palette: ${d.palette} Posture: ${d.posture} Fits: ${d.fitsFor}`).join("\n");
}

/** Asking before building: what to ask, how, and when not to. */
export const DISCOVERY_RULES = `Ask only what would change the result. Use the code, the brief and anything attached first; a missing detail is not a reason to ask. At most five questions. Give every question your recommended answer, so the user can reply "go with your defaults" and still get a sound system. Good questions cover: who uses it and in what context (device, frequency, mood), the one feeling it must create, how dense the screens are, constraints that are fixed (existing brand color, logo, fonts, accessibility needs), and references the user likes or hates. Skip any question the brief already answers.`;

/** Two or three directions side by side, written as one static page. */
export const DIRECTIONS_PAGE = `Write ${DIRECTIONS_FILE}: ONE self-contained static HTML file (inline CSS, no JavaScript, no external requests except Google Fonts, and a full fallback stack for every font, since previews may not load web fonts) showing two or three clearly different directions side by side, labelled A, B and C. Differ on more than color: change the type personality, density and shape too. Each direction shows: its name and a one-line mood, the palette as labelled swatches (background, surface, text, muted text, primary, accent) with hex values, the display and body fonts as live samples, a sample card with a heading, body text and a primary and secondary button, and one line on why it fits this product. Use real copy from the product, never lorem ipsum. Mark the direction you recommend.`;

/** Getting values from a reference instead of from memory. */
export const EXTRACTION_RULES = `Extract, never guess. Fetch the reference page and its stylesheets (with browser tools: screenshots at desktop and mobile widths and computed styles of headings, body text, buttons, inputs, cards and navigation). Pull the actual values: colors (hex, rgb, hsl, oklch) with how often each appears, font families and sizes, spacing steps, radii, border widths, shadows and transition timings. Rank colors by frequency to find background, text and accent. Never fill a gap from what you remember about a brand: mark it unknown and choose deliberately. Then say the system you will use in one sentence (canvas, accent, type) before writing files.`;

/** The anti-generic checklist. */
export const ANTI_GENERIC = [
  "Purple-to-blue or violet gradient backgrounds, or a gradient on every surface.",
  "Generic emoji or an icon in front of every heading and feature.",
  "Cards with a thick colored left border as the main decoration.",
  "Inter, Roboto or Arial as the display face of an expressive brand (fine for body and for quiet product UI).",
  "Display and body set in the same family by default (keep it only for a deliberately single-family, technical direction).",
  "Invented metrics or testimonials (\"10x faster\", \"99.9% uptime\") and filler copy (Feature one, lorem ipsum).",
  "Beige, cream or peach page backgrounds chosen by default rather than by the brand.",
  "More than one accent color, or the accent used more than twice per screen.",
  "Three competing flourishes; one decisive one is enough.",
];

export function antiGenericMarkdown(): string {
  return ANTI_GENERIC.map((x) => `- ${x}`).join("\n");
}

/** The five-dimension self-critique. */
export const CRITIQUE = `Score the work 1-5 on each, silently, before you finish:
1. **Philosophy**: does the visual posture match what was asked, or did it drift to a default?
2. **Hierarchy**: does the eye land in one obvious place per screen?
3. **Execution**: type, spacing, alignment and contrast exactly right, not just close?
4. **Specificity**: is every word, color and choice specific to this product, with no filler?
5. **Restraint**: one accent, one decisive flourish, nothing competing?
Fix the weakest dimension and score again until every one is at least 3. Then check the anti-generic list.`;

/** What the second turn of a brainstorm does with the user's reply. */
export const AFTER_PICK = `When the user replies with a pick (a letter, a mix, or changes), write ${DESIGN_FILE} and ${TOKENS_FILE} for that direction, following everything above. Then delete ${DIRECTIONS_FILE}: it was for choosing, not for keeping.`;
