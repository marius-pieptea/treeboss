/** QR codes for the pairing link: an SVG for the UI and unicode half-blocks for the terminal. */
import qrcode from "qrcode-generator";

function matrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

export function qrSvg(text: string, quiet = 4): string {
  const m = matrix(text);
  const size = m.length + quiet * 2;
  let d = "";
  m.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/** Two rows per text line, so the code is square in a terminal. */
export function qrText(text: string, quiet = 2): string {
  const m = matrix(text);
  const n = m.length + quiet * 2;
  const at = (r: number, c: number) => {
    const rr = r - quiet;
    const cc = c - quiet;
    return rr >= 0 && cc >= 0 && rr < m.length && cc < m.length && m[rr][cc];
  };
  const lines: string[] = [];
  for (let r = 0; r < n; r += 2) {
    let line = "";
    for (let c = 0; c < n; c++) {
      const top = at(r, c);
      const bottom = at(r + 1, c);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    // Black on white whatever the terminal theme is: scanners want dark modules on a light field.
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines.join("\n");
}
