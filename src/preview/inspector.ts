/**
 * The script the preview proxy injects into every HTML page it serves. It does two things:
 *
 *  1. Reports console errors/warnings, uncaught errors, and failed fetch/XHR requests to the proxy it came
 *     from (`/__trb/log`, same origin), which keeps them in a buffer the operator and the agent can read.
 *  2. On request from the app (postMessage "trb-pick-mode"), highlights the element under the pointer and,
 *     on click, posts a description of it back to the parent window ("trb-pick").
 *  3. Posts the page's location to the parent ("trb-location") on load and on every in-page navigation, so the
 *     preview's address bar can follow it. This runs whether or not Inspect is on.
 *
 *  4. Posts the operator's clicks, typed values, form submits, Enter/Escape and navigations to the parent
 *     ("trb-step"), so a bug report can list how to reproduce it. Password, hidden and card fields never carry a value.
 *
 * It is a plain string: no build step, no dependency, and it works in any page. It only ever talks to
 * `window.parent` and to its own origin.
 */
export const INSPECTOR_PATH = "/__trb/inspector.js";
export const LOG_PATH = "/__trb/log";

export const INSPECTOR_JS = String.raw`(function () {
  if (window.__trbInspector) return;
  window.__trbInspector = true;
  var queue = [];
  var timer = null;
  function flush() {
    timer = null;
    if (!queue.length) return;
    var body = JSON.stringify({ entries: queue.splice(0, 50) });
    try { (window.__trbRealFetch || fetch).call(window, "/__trb/log", { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true }).catch(function () {}); } catch (e) {}
  }
  function report(level, text, url) {
    queue.push({ level: level, text: String(text).slice(0, 600), url: url ? String(url).slice(0, 300) : undefined, page: location.pathname });
    if (!timer) timer = setTimeout(flush, 250);
  }
  function fmt(args) {
    return Array.prototype.map.call(args, function (a) {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(" ");
  }
  ["error", "warn"].forEach(function (k) {
    var orig = console[k];
    console[k] = function () { try { report(k === "warn" ? "warning" : "error", fmt(arguments)); } catch (e) {} return orig.apply(this, arguments); };
  });
  window.addEventListener("error", function (e) {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) { report("failed-request", "load " + (e.target.src || e.target.href), e.target.src || e.target.href); return; }
    report("page-error", (e.message || "Error") + (e.filename ? " (" + e.filename + ":" + e.lineno + ")" : ""));
  }, true);
  window.addEventListener("unhandledrejection", function (e) { report("page-error", "Unhandled rejection: " + (e.reason && (e.reason.stack || e.reason.message) || e.reason)); });

  var realFetch = window.fetch;
  window.__trbRealFetch = realFetch;
  if (realFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = (init && init.method) || (input && input.method) || "GET";
      return realFetch.apply(this, arguments).then(function (res) {
        if (res.status >= 400 && url.indexOf("/__trb/") === -1) report("failed-request", method + " " + url + " -> " + res.status, url);
        return res;
      }, function (err) {
        if (url.indexOf("/__trb/") === -1) report("failed-request", method + " " + url + " (" + (err && err.message || "network error") + ")", url);
        throw err;
      });
    };
  }
  var XHR = window.XMLHttpRequest;
  if (XHR) {
    var open = XHR.prototype.open;
    XHR.prototype.open = function (m, u) {
      var self = this;
      this.addEventListener("loadend", function () {
        if ((self.status === 0 || self.status >= 400) && String(u).indexOf("/__trb/") === -1) report("failed-request", m + " " + u + " -> " + (self.status || "network error"), u);
      });
      return open.apply(this, arguments);
    };
  }

  /* ---- picking ---- */
  var picking = false, box = null, hovered = null;
  function esc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }
  function selectorOf(el) {
    if (el.id && document.querySelectorAll("#" + esc(el.id)).length === 1) return "#" + esc(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id && document.querySelectorAll("#" + esc(node.id)).length === 1) { parts.unshift("#" + esc(node.id)); break; }
      var cls = (node.getAttribute("class") || "").split(/\s+/).filter(function (c) { return c && !/^(\d|css-|sc-|jsx-)/.test(c) && c.length < 40; }).slice(0, 2);
      if (cls.length) part += "." + cls.map(esc).join(".");
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      var candidate = parts.join(" > ");
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (e) {}
      node = parent;
    }
    return parts.join(" > ");
  }
  function trimmedHtml(el) {
    var c = el.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll("script, style, svg, noscript"), function (n) { n.replaceWith(document.createComment(n.tagName.toLowerCase())); });
    (function cut(n, d) { if (d >= 4) { n.textContent = "…"; return; } Array.prototype.forEach.call(n.children, function (k) { cut(k, d + 1); }); })(c, 0);
    var out = c.outerHTML.replace(/\s{2,}/g, " ");
    return out.length > 2000 ? out.slice(0, 2000) + "…" : out;
  }
  var STYLE_PROPS = ["display", "position", "width", "height", "margin", "padding", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "border", "border-radius", "opacity", "z-index", "flex", "gap", "text-align"];
  function stylesOf(el) {
    var cs = getComputedStyle(el), out = {};
    STYLE_PROPS.forEach(function (p) { var v = cs.getPropertyValue(p); if (v) out[p] = v; });
    return out;
  }
  function ensureBox() {
    if (box) return box;
    box = document.createElement("div");
    box.setAttribute("data-trb-overlay", "1");
    box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4f8cff;background:rgba(79,140,255,.15);border-radius:2px;display:none;transition:all 60ms";
    document.documentElement.appendChild(box);
    return box;
  }
  function move(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box) return;
    hovered = el;
    var r = el.getBoundingClientRect(), b = ensureBox();
    b.style.display = "block"; b.style.left = r.left + "px"; b.style.top = r.top + "px"; b.style.width = r.width + "px"; b.style.height = r.height + "px";
  }
  function stop() {
    picking = false; hovered = null;
    if (box) box.style.display = "none";
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("mousedown", swallow, true);
    document.removeEventListener("keydown", key, true);
    document.documentElement.style.cursor = "";
  }
  function swallow(e) { e.preventDefault(); e.stopPropagation(); }
  function click(e) {
    e.preventDefault(); e.stopPropagation();
    var el = hovered || e.target;
    var r = el.getBoundingClientRect();
    var msg = {
      type: "trb-pick",
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || "").trim().slice(0, 160),
      html: trimmedHtml(el),
      styles: stylesOf(el),
      box: { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) },
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      path: location.pathname + location.search,
      title: document.title
    };
    stop();
    window.parent.postMessage(msg, "*");
  }
  function key(e) { if (e.key === "Escape") { stop(); window.parent.postMessage({ type: "trb-pick-cancel" }, "*"); } }
  function start() {
    if (picking) return;
    picking = true;
    document.documentElement.style.cursor = "crosshair";
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("mousedown", swallow, true);
    document.addEventListener("keydown", key, true);
  }
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent || !e.data) return;
    if (e.data.type === "trb-pick-mode") { if (e.data.on) start(); else stop(); }
  });
  /* ---- steps: what the operator did, so a bug report can say how to reproduce it. Runs with Inspect off. ---- */
  var pending = null, pendingTimer = null, lastPosted = null, lastNav = null;
  function postStep(step) {
    if (step.kind !== "input") lastPosted = null;
    try { window.parent.postMessage({ type: "trb-step", step: step }, "*"); } catch (e) {}
  }
  function flushInput() {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (!pending) return;
    var p = pending;
    pending = null;
    if (lastPosted && lastPosted.el === p.el && lastPosted.value === p.value) return;
    lastPosted = p;
    postStep({ kind: "input", target: p.target, value: p.value });
  }
  function ours(el) { return !!(el && el.closest && el.closest("[data-trb-overlay]")); }
  function words(s, n) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function roleOf(el) {
    var r = el.getAttribute("role");
    if (r) return r;
    var t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "button" || t === "summary") return "button";
    if (t === "select") return "select";
    if (t === "textarea") return "field";
    if (t === "form") return "form";
    if (t === "input") {
      var ty = (el.type || "text").toLowerCase();
      if (ty === "checkbox" || ty === "radio") return ty;
      if (ty === "button" || ty === "submit" || ty === "reset" || ty === "image") return "button";
      return "field";
    }
    return "";
  }
  function nameOf(el) {
    var n = el.getAttribute("aria-label");
    var by = !n && el.getAttribute("aria-labelledby");
    if (by && document.getElementById) { var l = document.getElementById(by.split(" ")[0]); if (l) n = l.textContent; }
    if (!n && el.labels && el.labels.length) n = el.labels[0].textContent;
    if (!n) n = el.getAttribute("placeholder") || el.getAttribute("alt") || el.getAttribute("title");
    var t = el.tagName.toLowerCase();
    if (!n && t !== "input" && t !== "textarea" && t !== "select" && t !== "form") n = el.innerText || el.textContent;
    if (!n && t === "input" && /^(button|submit|reset)$/i.test(el.type || "")) n = el.value;
    if (!n) n = el.getAttribute("name");
    return words(n, 40).replace(/"/g, "'");
  }
  function describe(el) {
    var role = roleOf(el), name = nameOf(el);
    return role && name ? role + ' "' + name + '"' : selectorOf(el);
  }
  function valueOf(el) {
    var ty = (el.type || "").toLowerCase();
    if (ty === "file" || isSensitive(el)) return null;
    if (ty === "checkbox" || ty === "radio") return el.checked ? "on" : "off";
    if (el.tagName === "SELECT") return String((el.options && el.options[el.selectedIndex] && el.options[el.selectedIndex].text) || el.value || "").replace(/\s+/g, " ").trim().slice(0, 60);
    return String(el.value == null ? "" : el.value).replace(/\s+/g, " ").trim().slice(0, 60);
  }
  function onValue(e, final) {
    var el = e.target;
    if (!el || !el.tagName || ours(el) || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    if (pending && pending.el !== el) flushInput();
    pending = { el: el, target: describe(el), value: valueOf(el) };
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    if (final) flushInput(); else pendingTimer = setTimeout(flushInput, 700);
  }
  var INTERACTIVE = "a,button,summary,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=switch],[onclick]";
  window.addEventListener("click", function (e) {
    if (picking) return;
    var el = e.target && e.target.closest ? e.target.closest(INTERACTIVE) : null;
    if (!el || ours(el)) return;
    var t = el.tagName, ty = (el.type || "").toLowerCase();
    if (t === "TEXTAREA" || t === "SELECT" || (t === "INPUT" && !/^(button|submit|reset|image)$/.test(ty))) return;
    flushInput();
    postStep({ kind: "click", target: describe(el) });
  }, true);
  window.addEventListener("input", function (e) { onValue(e, false); }, true);
  window.addEventListener("change", function (e) { onValue(e, true); }, true);
  function isSensitive(el) {
    var ty = (el.type || "").toLowerCase();
    return ty === "password" || ty === "hidden" || /(^|\s)(cc-[a-z-]+|one-time-code|[a-z]+-password)(\s|$)/i.test(el.getAttribute("autocomplete") || "");
  }
  window.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || !f.tagName || ours(f)) return;
    flushInput();
    postStep({ kind: "submit", target: describe(f) });
  }, true);
  window.addEventListener("keydown", function (e) {
    if (picking || e.isComposing || (e.key !== "Enter" && e.key !== "Escape")) return;
    var el = e.target;
    if (!el || !el.tagName || ours(el)) return;
    if (e.key === "Enter" && (el.tagName === "TEXTAREA" || /^(button|link)$/.test(roleOf(el)))) return;
    flushInput();
    postStep({ kind: "key", key: e.key, target: describe(el) });
  }, true);
  function navigated() {
    var url = location.pathname + (location.hash || "");
    if (url === lastNav) return;
    lastNav = url;
    flushInput();
    postStep({ kind: "navigate", url: url });
  }

  /* ---- location: lets the app's address bar follow the page ---- */
  function sendLocation(replace) {
    try { window.parent.postMessage({ type: "trb-location", href: location.href, replace: !!replace }, "*"); navigated(); } catch (e) {}
  }
  ["pushState", "replaceState"].forEach(function (k) {
    var orig = history[k];
    history[k] = function () { var r = orig.apply(this, arguments); sendLocation(k === "replaceState"); return r; };
  });
  window.addEventListener("popstate", function () { sendLocation(false); });
  window.addEventListener("hashchange", function () { sendLocation(false); });
  sendLocation(false);
  window.parent.postMessage({ type: "trb-ready" }, "*");
})();
`;
