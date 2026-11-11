import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { INSPECTOR_JS } from "../../src/preview/inspector";
import { DIALOG_STEPS, MAX_STEPS, MAX_TITLE, initialDraft, isStepMessage, moveItem, pushStep, stepLine, stepLines, type Step } from "../../web/src/features/browser/logic";

describe("stepLine", () => {
  test("renders each kind of step as a sentence", () => {
    const lines = (s: Step[]) => s.map(stepLine);
    expect(
      lines([
        { kind: "navigate", url: "/checkout" },
        { kind: "click", target: 'button "Pay now"' },
        { kind: "click", target: "#app > div.card:nth-of-type(2)" },
        { kind: "input", target: 'field "Search"', value: "abc" },
        { kind: "input", target: 'field "Password"', value: null },
        { kind: "input", target: 'checkbox "Remember me"', value: "on" },
        { kind: "input", target: 'checkbox "Remember me"', value: "off" },
        { kind: "input", target: 'select "Size"', value: "Large" },
        { kind: "input", target: "form input.q", value: "x" },
        { kind: "submit", target: 'form "Checkout"' },
        { kind: "submit", target: "form#signup" },
        { kind: "key", key: "Enter", target: 'field "Search"' },
        { kind: "key", key: "Escape", target: "body" },
      ]),
    ).toEqual([
      "Go to /checkout",
      'Click "Pay now" button',
      "Click #app > div.card:nth-of-type(2)",
      'Type "abc" into "Search"',
      'Fill in "Password" (value not recorded)',
      'Check "Remember me"',
      'Uncheck "Remember me"',
      'Select "Large" in "Size"',
      'Type "x" into form input.q',
      'Submit "Checkout" form',
      "Submit form#signup",
      'Press Enter in "Search"',
      "Press Escape",
    ]);
  });

  test("a value with line breaks stays on one line", () => {
    expect(stepLine({ kind: "input", target: 'field "Notes"', value: "a\nb" })).toBe('Type "a b" into "Notes"');
  });
});

describe("isStepMessage", () => {
  const ok = { type: "trb-step", step: { kind: "click", target: 'button "Go"' } };
  test("accepts each step shape", () => {
    for (const step of [{ kind: "navigate", url: "/" }, { kind: "click", target: "a" }, { kind: "input", target: "a", value: null }, { kind: "input", target: "a", value: "v" }, { kind: "submit", target: "f" }, { kind: "key", key: "Enter", target: "a" }, { kind: "key", key: "Escape", target: "a" }]) {
      expect(isStepMessage({ type: "trb-step", step })).toBe(true);
    }
    expect(isStepMessage(ok)).toBe(true);
  });
  test("rejects other messages and malformed steps", () => {
    for (const bad of [null, "x", {}, { type: "trb-pick", step: ok.step }, { type: "trb-step" }, { type: "trb-step", step: null }, { type: "trb-step", step: { kind: "drag", target: "a" } }, { type: "trb-step", step: { kind: "click" } }, { type: "trb-step", step: { kind: "click", target: 3 } }, { type: "trb-step", step: { kind: "navigate", url: 4 } }, { type: "trb-step", step: { kind: "input", target: "a" } }, { type: "trb-step", step: { kind: "input", target: "a", value: 5 } }, { type: "trb-step", step: { kind: "key", key: "Tab", target: "a" } }]) {
      expect(isStepMessage(bad)).toBe(false);
    }
  });
});

describe("pushStep", () => {
  test("keeps the newest 50, oldest first", () => {
    let ring: Array<{ step: Step; at: number }> = [];
    for (let i = 0; i < 60; i++) ring = pushStep(ring, { kind: "navigate", url: `/${i}` }, i);
    expect(ring).toHaveLength(MAX_STEPS);
    expect(ring[0]).toEqual({ step: { kind: "navigate", url: "/10" }, at: 10 });
    expect(ring.at(-1)!.step).toEqual({ kind: "navigate", url: "/59" });
  });
});

describe("dialog lines", () => {
  const ring = (n: number) => Array.from({ length: n }, (_, i) => ({ step: { kind: "navigate", url: `/${i}` } as Step, at: i }));
  test("start from the last 15 steps, newest last", () => {
    const lines = stepLines(ring(40));
    expect(lines).toHaveLength(DIALOG_STEPS);
    expect(lines[0]).toBe("Go to /25");
    expect(lines.at(-1)).toBe("Go to /39");
    expect(stepLines(ring(2))).toEqual(["Go to /0", "Go to /1"]);
    expect(stepLines([])).toEqual([]);
  });
  test("moveItem swaps neighbours and leaves the list alone at either end", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});

type El = Record<string, any>;
const el = (tag: string, attrs: Record<string, string> = {}, extra: El = {}): El => ({
  tagName: tag.toUpperCase(),
  type: attrs.type,
  getAttribute: (k: string) => attrs[k] ?? null,
  closest(this: El, sel: string) {
    return sel.includes("data-trb-overlay") ? (this.overlay ? this : null) : this;
  },
  ...extra,
});

function page() {
  const sent: any[] = [];
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const timers: Array<() => void> = [];
  const location = { href: "http://localhost:5555/", pathname: "/", search: "", hash: "" };
  const history = {
    pushState(_s: unknown, _t: string, url: string) { location.pathname = url; },
    replaceState(_s: unknown, _t: string, url: string) { location.pathname = url; },
  };
  const parent = { postMessage: (m: any) => sent.push(m) };
  const win: any = {
    parent,
    addEventListener: (k: string, f: (e: any) => void) => (listeners[k] ??= []).push(f),
    location, history, console: { error() {}, warn() {} },
    document: { title: "T", addEventListener() {}, removeEventListener() {}, documentElement: { style: {} } },
    setTimeout: (f: () => void) => timers.push(f),
    clearTimeout: (id: number) => { timers[id - 1] = () => {}; },
  };
  win.window = win;
  vm.runInNewContext(INSPECTOR_JS, { ...win, window: win });
  const fire = (type: string, e: El) => listeners[type]?.forEach((f) => f(e));
  return {
    steps: () => sent.filter((m) => m.type === "trb-step").map((m) => m.step),
    fire, history, location,
    tick: () => timers.splice(0).forEach((f) => f()),
    pick: (on: boolean) => fire("message", { source: parent, data: { type: "trb-pick-mode", on } }),
  };
}

describe("inspector step recording", () => {
  test("records the first load and each in-page navigation once", () => {
    const p = page();
    p.history.pushState({}, "", "/cart");
    p.history.replaceState({}, "", "/cart");
    p.fire("popstate", {});
    p.history.pushState({}, "", "/checkout");
    expect(p.steps()).toEqual([{ kind: "navigate", url: "/" }, { kind: "navigate", url: "/cart" }, { kind: "navigate", url: "/checkout" }]);
  });

  test("a click on a button names its role and text; clicks on text fields, plain areas and the overlay are not steps", () => {
    const p = page();
    p.fire("click", { target: el("button", {}, { innerText: "  Pay\n now " }) });
    p.fire("click", { target: el("input", { type: "text" }) });
    p.fire("click", { target: el("input", { type: "submit" }, { value: "Place order" }) });
    p.fire("click", { target: el("a", { "aria-label": "Home" }) });
    p.fire("click", { target: { tagName: "DIV", closest: () => null } });
    p.fire("click", { target: el("button", {}, { innerText: "Inspect", overlay: true }) });
    expect(p.steps().slice(1)).toEqual([{ kind: "click", target: 'button "Pay now"' }, { kind: "click", target: 'button "Place order"' }, { kind: "click", target: 'link "Home"' }]);
  });

  test("nothing is recorded while Inspect is picking an element, and recording resumes after", () => {
    const p = page();
    p.pick(true);
    p.fire("click", { target: el("button", {}, { innerText: "Pay" }) });
    p.fire("keydown", { key: "Escape", target: el("input", { type: "text", placeholder: "Search" }) });
    expect(p.steps()).toHaveLength(1);
    p.pick(false);
    p.fire("click", { target: el("button", {}, { innerText: "Pay" }) });
    expect(p.steps().at(-1)).toEqual({ kind: "click", target: 'button "Pay"' });
  });

  test("rapid inputs on one field become one step with the last value, flushed by the change event", () => {
    const p = page();
    const q = el("input", { type: "text", placeholder: "Search" }, { value: "" });
    for (const v of ["a", "ab", "abc"]) {
      q.value = v;
      p.fire("input", { target: q });
    }
    expect(p.steps()).toHaveLength(1);
    p.fire("change", { target: q });
    expect(p.steps().slice(1)).toEqual([{ kind: "input", target: 'field "Search"', value: "abc" }]);
  });

  test("a pause flushes the typed value once, and the change that follows does not repeat it", () => {
    const p = page();
    const q = el("input", { type: "text", "aria-label": "Name" }, { value: "Ana" });
    p.fire("input", { target: q });
    p.tick();
    p.fire("change", { target: q });
    expect(p.steps().slice(1)).toEqual([{ kind: "input", target: 'field "Name"', value: "Ana" }]);
  });

  test("a typed value is posted before the click that follows it", () => {
    const p = page();
    p.fire("input", { target: el("input", { type: "text", placeholder: "Email" }, { value: "a@b.c" }) });
    p.fire("click", { target: el("button", {}, { innerText: "Join" }) });
    expect(p.steps().slice(1).map((s) => s.kind)).toEqual(["input", "click"]);
  });

  test("password, hidden, card and one-time-code values are never sent", () => {
    const p = page();
    p.fire("change", { target: el("input", { type: "password", placeholder: "Password" }, { value: "hunter2" }) });
    p.fire("change", { target: el("input", { type: "hidden", name: "csrf" }, { value: "tok123" }) });
    p.fire("change", { target: el("input", { type: "text", placeholder: "Card", autocomplete: "cc-number" }, { value: "4242424242424242" }) });
    p.fire("change", { target: el("input", { type: "text", placeholder: "Code", autocomplete: "one-time-code" }, { value: "123456" }) });
    expect(p.steps().slice(1).map((s) => s.value)).toEqual([null, null, null, null]);
    expect(JSON.stringify(p.steps())).not.toMatch(/hunter2|tok123|4242|123456/);
  });

  test("a value is cut to 60 characters; checkboxes report on or off; selects report the chosen text", () => {
    const p = page();
    p.fire("change", { target: el("input", { type: "text", placeholder: "Bio" }, { value: "x".repeat(100) }) });
    p.fire("change", { target: el("input", { type: "checkbox", "aria-label": "Remember me" }, { checked: true }) });
    p.fire("change", { target: el("select", { "aria-label": "Size" }, { options: [{ text: "Small" }, { text: "Large" }], selectedIndex: 1, value: "l" }) });
    expect(p.steps().slice(1)).toEqual([
      { kind: "input", target: 'field "Bio"', value: "x".repeat(60) },
      { kind: "input", target: 'checkbox "Remember me"', value: "on" },
      { kind: "input", target: 'select "Size"', value: "Large" },
    ]);
  });

  test("submit and the Enter and Escape keys are steps; Enter on a button or in a textarea is not, and other keys are not", () => {
    const p = page();
    p.fire("submit", { target: el("form", { "aria-label": "Checkout" }) });
    p.fire("keydown", { key: "Enter", target: el("input", { type: "text", placeholder: "Search" }) });
    p.fire("keydown", { key: "Escape", target: el("input", { type: "text", placeholder: "Search" }) });
    p.fire("keydown", { key: "Enter", target: el("button", {}, { innerText: "Go" }) });
    p.fire("keydown", { key: "Enter", target: el("textarea", { placeholder: "Notes" }) });
    p.fire("keydown", { key: "a", target: el("input", { type: "text", placeholder: "Search" }) });
    p.fire("keydown", { key: "Enter", isComposing: true, target: el("input", { type: "text", placeholder: "Search" }) });
    expect(p.steps().slice(1)).toEqual([
      { kind: "submit", target: 'form "Checkout"' },
      { kind: "key", key: "Enter", target: 'field "Search"' },
      { kind: "key", key: "Escape", target: 'field "Search"' },
    ]);
  });
});

describe("secrets in the address", () => {
  test("a navigate step records the path and hash, never the query", () => {
    const p = page();
    p.location.pathname = "/gate";
    p.location.search = "?code=pin-4242-secret&q=shoes";
    p.location.hash = "#top";
    p.fire("popstate", {});
    expect(p.steps().at(-1)).toEqual({ kind: "navigate", url: "/gate#top" });
    expect(JSON.stringify(p.steps())).not.toContain("pin-4242");
  });
});

describe("initialDraft", () => {
  const prefill = { title: "Pay", kind: "functional" as const, steps: ["Open /cart", "Click Pay (recorded)"], expected: "A receipt", actual: "Blank" };
  test("a prefill becomes the dialog's fields as given", () => {
    expect(initialDraft(prefill, ["Go to /x"])).toEqual(prefill);
  });
  test("without one the dialog starts empty with the recorded steps", () => {
    expect(initialDraft(undefined, ["Go to /x"])).toEqual({ title: "", kind: "functional", steps: ["Go to /x"], expected: "", actual: "" });
  });
  test("a title over the limit is cut so the server does not reject the report", () => {
    expect(initialDraft({ ...prefill, title: "t".repeat(500) }, []).title).toHaveLength(MAX_TITLE);
    expect(initialDraft({ ...prefill, steps: Array.from({ length: 60 }, (_, i) => `s${i}`) }, []).steps).toHaveLength(50);
  });
});
