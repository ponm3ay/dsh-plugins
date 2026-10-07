// Offline black-box test for the browser half: no browser, no jsdom.
//
// It stubs the two globals the loader contract needs (`window.__ModuleLoader__`
// and `document`), evaluates the BUILT artifact (lib/client.js), and checks the
// observable effects: the module registration, the injected sheet, its exact
// selectors, both palette colors, and the effect disposer.
//
//   node verify/client-test.mjs      （或 npm test）
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok   ' + name)
  } else {
    failed += 1
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail))
  }
}

/** Minimal document stub: enough for createElement/head/getElementById/remove. */
function makeDocument() {
  const head = {
    children: [],
    appendChild(node) {
      this.children.push(node)
      node.parentNode = this
    },
  }
  return {
    head,
    createElement(tag) {
      return {
        tagName: tag,
        id: '',
        attributes: {},
        textContent: '',
        parentNode: null,
        setAttribute(name, value) {
          this.attributes[name] = value
        },
        getAttribute(name) {
          return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
        },
        remove() {
          const at = head.children.indexOf(this)
          if (at >= 0) head.children.splice(at, 1)
          this.parentNode = null
        },
      }
    },
    getElementById(id) {
      const hit = head.children.find((node) => node.id === id)
      return hit === undefined ? null : hit
    },
  }
}

/** Evaluate the bundle with stubbed globals and return its exports. */
function loadBundle() {
  const document = makeDocument()
  let registration = null
  const sandbox = {
    document,
    globalThis: {},
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          registration = { id, exports: factory(() => ({})), document, sandbox }
        },
      },
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(bundle, sandbox, { filename: 'lib/client.js' })
  return registration
}

console.log('dsh-provider-accent · client half')

const registration = loadBundle()
check('registers under its package id', registration.id === 'dsh-provider-accent', String(registration.id))

const api = registration.exports
check('exports apply', typeof api.apply === 'function')
check('declares no required service', Array.isArray(api.inject) && api.inject.length === 0)

api.apply({})

const sheet = registration.document.getElementById('dsh-provider-accent-style')
check('injects exactly one style element', registration.document.head.children.length === 1)
check('style element carries the plugin marker', sheet !== null && sheet.getAttribute('data-plugin') === 'dsh-provider-accent')
check('style is inserted once, not twice', registration.document.head.children.length === 1)
api.apply({})
check('re-apply is idempotent', registration.document.head.children.length === 1)

const css = sheet === null ? '' : sheet.textContent
check('targets the composer model menu heading', css.includes('section[data-menu-group]:has(> [role="menuitemradio"]) > [data-menu-group-heading]'))
check('targets the /model popup heading', css.includes('[role="listbox"][aria-label^="/model"] section[data-menu-group] > [data-menu-group-heading]'))
check('light palette uses the high-contrast violet', css.includes('color:#7c3aed'))
check('dark palette uses the light violet', css.includes('body[data-ds-dark-theme]') && css.includes('color:#a78bfa'))
check('lifts the heading weight', css.includes('font-weight:600'))
check('leaves the shipped tertiary token alone', !css.includes('--dsw-alias-label-tertiary'))
check('no !important needed', !css.includes('!important'))
check('no shorthand that would clobber the shipped font-size', !css.includes('font:'))
check('balanced braces per rule', (css.match(/\{/g) || []).length === 2 && (css.match(/\}/g) || []).length === 2)
check('four selector groups (2 surfaces x 2 palettes)', (css.match(/section\[data-menu-group\]/g) || []).length === 4)

// Second instance with an effect-capable ctx: the sheet must be disposed with it.
const second = loadBundle()
let disposer = null
second.exports.apply({
  effect(factory) {
    disposer = factory()
  },
})
check('uses ctx.effect when available', typeof disposer === 'function')
check('sheet present while the effect is live', second.document.getElementById('dsh-provider-accent-style') !== null)
if (typeof disposer === 'function') disposer()
check('disposer removes the sheet', second.document.getElementById('dsh-provider-accent-style') === null)
const hook = second.sandbox.__dshProviderAccent
check('devtools hook is published with colors and selectors', typeof hook === 'object' && hook !== null && hook.colors.light === '#7c3aed' && Array.isArray(hook.selectors) && hook.selectors.length === 2)

console.log('')
console.log(failed === 0 ? `all ${passed} checks passed` : `${failed} of ${passed + failed} checks failed`)
process.exit(failed === 0 ? 0 : 1)
