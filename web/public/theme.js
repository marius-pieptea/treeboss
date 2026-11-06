// Set the theme before first paint so there is no flash. External (not inline) because the CSP forbids inline script.
// Mirrors resolveTheme() in src/lib/theme.ts.
try {
  var t = localStorage.getItem("trb.theme");
  var sysDark = !window.matchMedia("(prefers-color-scheme: light)").matches;
  var dark = t === "dark" || t === "catppuccin-mocha" || t === "spritecraft-dark" ? true : t === "light" || t === "catppuccin-latte" || t === "spritecraft" ? false : sysDark;
  var cat = t === "catppuccin" || t === "catppuccin-latte" || t === "catppuccin-mocha";
  var sprite = t === "spritecraft" || t === "spritecraft-dark";
  document.documentElement.classList.toggle("dark", dark);
  if (sprite) document.documentElement.setAttribute("data-theme", "spritecraft");
  if (cat) document.documentElement.setAttribute("data-theme", "catppuccin");
  // Desktop shell with an OS material behind the window: translucent chrome unless the user turned it off.
  if (window.treebossDesktop && window.treebossDesktop.glass && localStorage.getItem("trb.glass") !== "off") document.documentElement.setAttribute("data-vibrancy", "on");
} catch (e) {}
