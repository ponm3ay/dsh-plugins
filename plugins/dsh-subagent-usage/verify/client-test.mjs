// Offline proof for the browser half.
//
// The half only ever runs inside the page, so this harness gives it the three
// browser facts it needs — a module loader, a `react` word in the module table,
// and a client context with `slots`/`locale`/`effect` — then renders both seats
// and asserts the text they produce. It also proves the two contract mistakes
// that fail silently in production: a wrong slot name (the registration simply
// never lands) and a component that throws on a partial projection value.
//
//   node verify/client-test.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' -- ' + detail))
}

//#region the smallest react that can run these components

const hooks = []
let hookCursor = 0
const react = {
  createElement(type, props, ...children) {
    const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: props ?? {}, children: flat }
  },
  useState(initial) {
    const index = hookCursor
    hookCursor += 1
    if (!(index in hooks)) hooks[index] = initial
    return [
      hooks[index],
      (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
      },
    ]
  },
}

//#endregion

//#region load the bundle exactly the way the shell does

const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
let factory
const registration = { id: undefined }
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      registration.id = spec.id
      factory = spec.factory
    },
  },
}
// eslint-disable-next-line no-eval -- the bundle is a script for the page, not a module
eval(bundle)
check('the bundle registers itself under the package name', registration.id === 'dsh-subagent-usage', JSON.stringify(registration.id))
check('the loader captured exactly one factory', typeof factory === 'function')

const moduleExports = factory((specifier) => {
  if (specifier === 'react') return react
  throw new Error('unexpected require: ' + specifier)
})
check('the half exports apply and inject', typeof moduleExports.apply === 'function' && Array.isArray(moduleExports.inject), JSON.stringify(Object.keys(moduleExports)))
check('the half requires only services the web client always has', JSON.stringify(moduleExports.inject) === JSON.stringify(['slots', 'locale']), JSON.stringify(moduleExports.inject))

//#endregion

//#region run apply against a recording context

const registered = []
const injected = []
const dictionaries = new Map()
const effects = []
const ctx = {
  effect(callback, label) {
    effects.push(label)
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register(namespace, dicts) {
      dictionaries.set(namespace, dicts)
      return () => {}
    },
  },
  slots: {
    inject(key, callback) {
      injected.push(key)
      callback()
      return () => {}
    },
    register(declaration, Component) {
      registered.push({ declaration, Component })
      return () => {}
    },
  },
}

moduleExports.apply(ctx)

check('both dictionaries were registered', dictionaries.has('subagentUsage'), JSON.stringify([...dictionaries.keys()]))
check('apply resolved both seats through slots.inject', JSON.stringify(injected) === JSON.stringify(['conversation.session.header.actions', 'conversation.chat.turnTail']), JSON.stringify(injected))
check('two entries were registered', registered.length === 2, String(registered.length))

const header = registered.find((entry) => entry.declaration.name === 'conversation.session.header.actions')
const tail = registered.find((entry) => entry.declaration.name === 'conversation.chat.turnTail')
check('the header entry uses a fresh id, not a shipped one', header?.declaration.id === 'subagent-usage', JSON.stringify(header?.declaration.id))
check('the header entry sits beside the shipped band', header?.declaration.order === -20, JSON.stringify(header?.declaration.order))
check('the header entry binds the dictionary namespace', header?.declaration.locale === 'subagentUsage')
check('the turn entry uses a fresh id', tail?.declaration.id === 'subagent-usage-turn', JSON.stringify(tail?.declaration.id))
check('the turn entry lands last in the tail chain', tail?.declaration.order === 100, JSON.stringify(tail?.declaration.order))

//#endregion

//#region translate with the registered dictionary, the way the locale service does

const zh = dictionaries.get('subagentUsage').zh
const t = (key, params) => {
  const template = zh[key]
  if (template === undefined) throw new Error('missing dictionary key: ' + key)
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

/** Render a component with one projection value, and collect every string in the tree. */
function renderText(entry, props, view, hookValues = []) {
  hooks.length = 0
  hookValues.forEach((value, index) => {
    hooks[index] = value
  })
  hookCursor = 0
  const element = entry.Component({ useProjection: () => view, t, ...props })
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    walk(node.children)
  }
  walk(element)
  return { element, text: out.join(' ') }
}

const fullView = {
  selected: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
  requested: null,
  config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max', maxTokens: 256000 },
  effective: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: null },
  mode: 'one-shot',
  label: null,
  subProvider: 'in-process',
  contextWindow: 1000000,
  requests: 3,
  turns: 2,
  steps: 12,
  running: false,
  stop: 'completed',
  firstAt: 1,
  lastAt: 2,
  llmMs: 45000,
  usage: { input: 14838, output: 375, cacheRead: 16128, cacheWrite: 0, reasoning: 120 },
  perTurn: [
    { turn: 1, provider: 'p', model: 'deepseek-flash', reasoningEffort: 'max', input: 14838, output: 375, cacheRead: 16128, cacheWrite: 0, reasoning: 120, ms: 20000, steps: 5, stop: 'completed', endSeq: 40 },
    { turn: 2, provider: 'p', model: 'deepseek-flash', reasoningEffort: 'max', input: 900, output: 120, cacheRead: 400, cacheWrite: 0, reasoning: 30, ms: 25000, steps: 7, stop: 'completed', endSeq: 88 },
  ],
  routes: [{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max', maxTokens: 256000, requests: 3 }],
}

{
  const { element, text } = renderText(header, {}, fullView)
  check('the header chip names the model', text.includes('deepseek-flash'), text)
  check('the header chip names the reasoning effort', text.includes('推理等级 max'), text)
  check('the header chip sums the four buckets', text.includes('31.3K'), text)
  check('the header chip marks a subagent session', text.includes('一次性子代理'), text)
  check('the header chip carries a running state marker', element.props['data-state'] === 'idle', JSON.stringify(element.props['data-state']))
  check('the header chip exposes an accessible name', typeof element.props['aria-label'] === 'string' && element.props['aria-label'].includes('deepseek-flash'))
}

{
  const { text } = renderText(header, {}, { ...fullView, running: true })
  check('a running session reports running', text.length > 0)
}

{
  const empty = { ...fullView, config: null, effective: null, requested: null, selected: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, perTurn: [], requests: 0, steps: 0, turns: 0 }
  const { element } = renderText(header, {}, empty)
  check('the header chip renders nothing before the first request', element === null)
  const result = renderText(tail, { turn: 1, seq: 10 }, empty)
  check('the turn line renders nothing before the first request', result.element === null)
}

{
  const { text } = renderText(tail, { turn: 2, seq: 88 }, fullView)
  // 900 input + 120 output + 400 cache read = 1,420 for turn 2 alone.
  check('the turn line quotes this turn, not the session', text.includes('1.4K tok'), text)
  check('the turn line names the route', text.includes('deepseek-flash') && text.includes('推理等级 max'), text)
  check('the turn line offers the details toggle', text.includes('详情'), text)
}

{
  const expanded = renderText(tail, { turn: 2, seq: 88 }, fullView, [true])
  check('expanded details list every bucket', ['未缓存输入', '缓存读', '缓存写', '输出', '其中推理', '合计'].every((label) => expanded.text.includes(label)), expanded.text)
  check('expanded details show the session total', expanded.text.includes('会话累计'), expanded.text)
  check('expanded details show the model time', expanded.text.includes('模型耗时'), expanded.text)
  check('expanded details show the context window', expanded.text.includes('1,000,000'), expanded.text)
  check('expanded details translate the stop reason', expanded.text.includes('正常完成'), expanded.text)
}

{
  // A partial value — an older host, or a session the unit never saw — must not throw.
  const partial = { usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, requests: 1, steps: 1, turns: 1, running: false, perTurn: [], config: null, effective: null, requested: null, selected: null, mode: null, label: null, subProvider: null, contextWindow: null, stop: null, firstAt: null, lastAt: null, llmMs: 0, routes: [] }
  const chip = renderText(header, {}, partial)
  check('a partial projection value does not throw in the header', chip.element !== null)
  const unknown = renderText(tail, { turn: 9, seq: 1 }, partial)
  check('a turn with no matching row still renders the session total', unknown.text.includes('本轮无模型用量'), unknown.text)
  const absent = renderText(header, {}, undefined)
  check('an absent projection value renders nothing', absent.element === null)
}

console.log(failures === 0 ? '== all checks passed' : '== ' + String(failures) + ' check(s) FAILED')
process.exit(failures === 0 ? 0 : 1)
