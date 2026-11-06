/**
 * Image dimensions read from file headers, with no dependency. Only PNG and JPEG: those are the formats the app
 * stores accept for screenshots.
 */
export interface ImageSize {
  format: "png" | "jpeg";
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The JPEG start-of-frame markers carry the size. C4 (huffman table), C8 (reserved) and CC (arithmetic table) do not. */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** The size in the header, or null when the bytes are not a PNG or a JPEG, or the header is cut short. */
export function imageSize(b: Buffer): ImageSize | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG_SIGNATURE) && b.toString("ascii", 12, 16) === "IHDR") {
    return { format: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = b.readUInt16BE(i + 2);
    if (isSof(marker)) {
      if (i + 9 > b.length) return null;
      return { format: "jpeg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** App Store iPhone screenshot sizes (portrait, width by height; landscape swaps them): 6.9, 6.7 and 6.5 inch displays. */
const IPHONE_SIZES: ReadonlyArray<readonly [number, number]> = [
  [1320, 2868],
  [1290, 2796],
  [1260, 2736],
  [1284, 2778],
  [1242, 2688],
];
export const IPHONE_SIZES_TEXT = IPHONE_SIZES.map(([w, h]) => `${w}x${h}`).join(", ");

export const isIphoneSize = (s: ImageSize): boolean => IPHONE_SIZES.some(([w, h]) => (s.width === w && s.height === h) || (s.width === h && s.height === w));

/** Google Play phone screenshots: each side 320 to 3840 px, and the long side at most twice the short side. */
export function fitsPlay(s: ImageSize): boolean {
  const lo = Math.min(s.width, s.height);
  const hi = Math.max(s.width, s.height);
  return lo >= 320 && hi <= 3840 && hi <= lo * 2;
}
/** Google Play wants at least two screenshots. */
export const PLAY_MIN_SHOTS = 2;
