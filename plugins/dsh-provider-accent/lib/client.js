window.__ModuleLoader__.load({ id: "dsh-provider-accent", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// dsh-provider-accent — browser half.
//
// While you are switching models, the PROVIDER is the thing you actually choose
// between. The shipped pickers paint the provider (their menu group heading) in
// the dim tertiary label color, so vendors read as decoration. This half
// repaints exactly those headings in a high-contrast purple and lifts the weight
// one step — nothing else about the menus changes.
//
// Both surfaces belong to @deepseek-ai/dsh-client-ui-model-selection and are
// addressed through the shipped accessibility skeleton; no hashed CSS-module
// class name is referenced anywhere:
//
//   1. the composer's model menu — every provider is a MenuGroup
//      `section[data-menu-group]` whose rows are `[role="menuitemradio"]`;
//   2. the `/model` command popup — a `[role="listbox"]` labelled
//      `/<command> options`, whose provider groups are the same MenuGroup.
//
// Deliberately NOT repainted: the shared command-palette groups (`/help` …) —
// their rows are not `menuitemradio` and their listbox is not labelled `/model`,
// so they keep the shipped tertiary color.
//
// Discipline: one <style> element in <head>, no react, no DOM observers, no
// host state, nothing written to settings. If a selector ever stops matching,
// the menus simply keep the shipped color — this half cannot break them.

var STYLE_ID = "dsh-provider-accent-style";
var SOURCE = "dsh-provider-accent";

/** Provider heading color on the light palette (violet-600 on a light menu). */
var LIGHT_COLOR = "#7c3aed";
/** Provider heading color on the dark palette (violet-400 on a dark menu). */
var DARK_COLOR = "#a78bfa";
/** The shipped heading is 500 @ 11px; one step up makes it read as a label. */
var HEADING_WEIGHT = 600;

/** Selectors for the provider group headings of the two model pickers. */
var HEADING_SELECTORS = [
  'section[data-menu-group]:has(> [role="menuitemradio"]) > [data-menu-group-heading]',
  '[role="listbox"][aria-label^="/model"] section[data-menu-group] > [data-menu-group-heading]',
];

/** One rule per palette; the dark palette is marked on <body> by ui-theme. */
function ruleFor(prefix, color) {
  var selector = HEADING_SELECTORS.map(function (part) {
    return prefix + part;
  }).join(",");
  return selector + "{color:" + color + ";font-weight:" + String(HEADING_WEIGHT) + "}";
}

var CSS = ruleFor("", LIGHT_COLOR) + ruleFor("body[data-ds-dark-theme] ", DARK_COLOR);

/** Insert the sheet once; returns the element (or null outside a document). */
function ensureStyle() {
  if (typeof document === "undefined") return null;
  var existing = document.getElementById(STYLE_ID);
  if (existing !== null) return existing;
  var element = document.createElement("style");
  element.id = STYLE_ID;
  element.setAttribute("data-plugin", SOURCE);
  element.textContent = CSS;
  document.head.appendChild(element);
  return element;
}

function apply(ctx) {
  if (typeof document === "undefined") return;
  if (typeof ctx === "object" && ctx !== null && typeof ctx.effect === "function") {
    ctx.effect(function () {
      var element = ensureStyle();
      return function () {
        if (element !== null && element.parentNode !== null) element.remove();
      };
    }, SOURCE + ": provider headings");
  } else {
    ensureStyle();
  }
  // Manual re-assert from devtools: __dshProviderAccent.apply()
  globalThis.__dshProviderAccent = {
    apply: ensureStyle,
    colors: { light: LIGHT_COLOR, dark: DARK_COLOR },
    selectors: HEADING_SELECTORS,
  };
}

exports.apply = apply;
exports.inject = [];

return module.exports; } });
