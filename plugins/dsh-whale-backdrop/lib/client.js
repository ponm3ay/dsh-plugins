window.__ModuleLoader__.load({ id: "dsh-whale-backdrop", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// dsh-whale-backdrop — browser half.
//
// Paints the art behind the WHOLE app and lets the surfaces above it go
// translucent, so the picture reads through the panels instead of sitting next
// to them:
//
//   1. one <style> in <head>: the html background layers (tint + art), body
//      forced transparent;
//   2. theme.overrideTokens: base / layer-1 / layer-2 / sidebar fill become
//      translucent colours, stacked as one named layer over the active theme;
//   3. one manifest fetch, then one image picked per page load.
//
// Every knob is a constant below; nothing is written to settings and nothing
// touches the host half except the two routes it serves.
const STYLE_ID = 'dsh-whale-backdrop-style'
const SOURCE = 'dsh-whale-backdrop'
const ROUTE = '/plugins/dsh-whale-backdrop'
const MANIFEST = ROUTE + '/images.json'
const FALLBACK_IMAGE = ROUTE + '/image/backdrop.jpg'

/** Master switch. `false` leaves the app exactly as it was. */
const ENABLED = true
/** Pick a random image from ./assets per page load instead of the primary one. */
const RANDOM_PER_LOAD = true
/** Vignette painted over the art: top colour, bottom colour. */
const TINT_TOP = 'rgba(3, 8, 16, .62)'
const TINT_BOTTOM = 'rgba(2, 5, 12, .88)'
/**
 * Alpha of the translucent surfaces. Lower = more art, less contrast.
 * 2026-10-02 用户反馈「透明度太高」→ 四个值统一上调（≈ +0.26）：
 * 面板明显更实，画只在面板之间的缝隙里露出来。
 */
const TOKENS = {
  '--dsw-alias-bg-base': { light: 'rgba(247, 250, 255, .84)', dark: 'rgba(6, 12, 22, .78)' },
  '--dsw-alias-bg-layer-1': { light: 'rgba(255, 255, 255, .88)', dark: 'rgba(10, 18, 30, .82)' },
  '--dsw-alias-bg-layer-2': { light: 'rgba(255, 255, 255, .92)', dark: 'rgba(14, 24, 38, .88)' },
  '--dsw-specific-sidebar-fill': { light: 'rgba(240, 245, 252, .86)', dark: 'rgba(4, 9, 17, .80)' },
}

// Two background layers on <html>: the tint gradient and the art. The art URL
// arrives as a custom property (set by setImage) so the sheet itself never has
// to be rewritten; `none` keeps the rule valid before the first paint.
const CSS = [
  'html{background-color:transparent!important;',
  'background-image:linear-gradient(' + TINT_TOP + ',' + TINT_BOTTOM + '),var(--dsh-whale-image,none);',
  'background-size:cover,cover;',
  'background-position:center center,center center;',
  'background-repeat:no-repeat,no-repeat;',
  'background-attachment:fixed,fixed}',
  'body{background:transparent!important}',
].join('')

function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const element = document.createElement('style')
  element.id = STYLE_ID
  element.textContent = CSS
  document.head.appendChild(element)
}

function setImage(url) {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--dsh-whale-image', 'url("' + url + '")')
}

/** Paint immediately with the primary image, then refine once the manifest answers. */
function paint() {
  setImage(FALLBACK_IMAGE)
  if (typeof fetch !== 'function') return
  fetch(MANIFEST, { cache: 'no-store' })
    .then(response => (response.ok === true ? response.json() : null))
    .then(data => {
      if (data === null || Array.isArray(data.images) !== true || data.images.length === 0) return
      const pool = RANDOM_PER_LOAD === true
        ? data.images
        : data.images.filter(image => image.name === data.primary)
      const chosen = (pool.length === 0 ? data.images : pool)[Math.floor(Math.random() * (pool.length === 0 ? data.images.length : pool.length))]
      const revision = chosen.revision === undefined ? '' : '?v=' + encodeURIComponent(chosen.revision)
      setImage(ROUTE + '/image/' + encodeURIComponent(chosen.name) + revision)
    })
    .catch(() => {
      // The primary image is already up; a missing manifest is not worth a console error.
    })
}

const inject = ['theme']

function apply(ctx) {
  if (ENABLED !== true) return
  ensureStyle()
  paint()
  // One named layer over the active theme; the disposer rides the effect, so
  // unloading the plugin restores the untouched theme.
  ctx.effect(() => ctx.theme.overrideTokens(SOURCE, TOKENS), 'whale-backdrop: translucent tokens')
  // Manual re-roll from devtools: __dshWhaleBackdrop.paint()
  globalThis.__dshWhaleBackdrop = { paint, tokens: TOKENS }
}

exports.apply = apply
exports.inject = inject

return module.exports; } });
