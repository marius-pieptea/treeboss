import { describe, expect, test } from "bun:test";
// The root package has no react; the web workspace does (its types live there too, hence the ignores).
// @ts-ignore
import { createElement } from "../../web/node_modules/react";
// @ts-ignore
import { renderToStaticMarkup } from "../../web/node_modules/react-dom/server";
import { CheckRow } from "../../web/src/features/practices/CheckRow";

const html = (props: { label: string; checked: boolean; mono?: boolean; className?: string }) => renderToStaticMarkup(createElement(CheckRow, { onChange: () => {}, ...props }));

describe("CheckRow: a rule or a check id beside its box", () => {
  test("draws the text, and names the checkbox with the same words", () => {
    const out = html({ label: "Prefer a plain function to a class.", checked: true });
    // The bug this guards: Checkbox alone drew a bare box, with the text only as an aria-label.
    expect(out).toContain(">Prefer a plain function to a class.</span>");
    expect(out).toContain('aria-label="Prefer a plain function to a class."');
    expect(out).toContain('role="checkbox"');
    expect(out).toContain('aria-checked="true"');
  });

  test("the row is a label, so the text toggles the box", () => {
    const out = html({ label: "no-any", checked: false });
    expect(out.startsWith("<label")).toBe(true);
    expect(out).toContain('aria-checked="false"');
  });

  test("a check id is set in mono; a rule is not", () => {
    expect(html({ label: "no-any", checked: true, mono: true })).toContain("font-mono");
    expect(html({ label: "Keep it simple.", checked: true })).not.toContain("font-mono");
  });

  test("a class from the caller lands on the row, so a pack that is off dims the whole row", () => {
    expect(html({ label: "Keep it simple.", checked: true, className: "opacity-60" })).toContain("opacity-60");
  });
});
