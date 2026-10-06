window.__ModuleLoader__.load({ id: "dsh-subagent-usage", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// dsh-subagent-usage — browser half.
//
// Reads ONE session projection (`subagentUsage`, registered by this package's
// host half) and renders it in two additive seats, so opening a subagent's
// conversation shows what it ran on and what it cost:
//
//   1. `conversation.session.header.actions` (fresh id, order -20) — a compact
//      chip beside the session title: model · reasoning effort · total tokens,
//      with a live dot while the turn is open. It is the always-there answer.
//   2. `conversation.chat.turnTail` (fresh id, order 100) — one line after every
//      completed turn: that turn's route and cost, expandable into the full
//      bucket breakdown and the session totals.
//
// Contract notes, each of which cost a debugging session somewhere:
//
//   * A session-scoped slot component receives STANDARD props — `sessionId`,
//     `useProjection`, `useSession`, `useSessions`, `useConversation`, ... — plus
//     the slot owner's own props and `t` once the registration carries
//     `locale: NS`. Nothing else is passed, and no service access is needed to
//     read a projection.
//   * `ctx.slots.inject(key, callback)` waits for the slot OWNER, which is what
//     orders this bundle after the conversation UI that declares the seats. The
//     only services this half requires are `slots` and `locale`; both are web
//     client core.
//   * This bundle is materialized as a closure factory
//     (`window.__ModuleLoader__.load({ id, factory })`): `require` is the shell's
//     module table, and `react` is a baseline word every dynamic bundle may ask
//     for, so no dependency declaration is needed.
//   * No backtick may appear inside a CSS blob: the sheet below is a plain
//     concatenation, and the surrounding convention exists because a stray
//     backtick has already ended one build string early in this deployment.
//   * No JSX and no bundler: `React.createElement` is the whole build step, so
//     `lib/client.js` is this file wrapped in the loader call.

const react = require('react')

/** Projection key registered by the host half. */
const PROJECTION_KEY = 'subagentUsage'

/** Client dictionary namespace this half registers its copy under. */
const NS = 'subagentUsage'

/** The seat beside the session title. */
const HEADER_SLOT = 'conversation.session.header.actions'

/** The seat after a completed turn, inside the conversation flow. */
const TAIL_SLOT = 'conversation.chat.turnTail'

/** Style element id, so a second activation cannot duplicate the sheet. */
const STYLE_ID = 'dsh-subagent-usage-style'

/** Bucket labels, in the order the details panel lists them. */
const BUCKETS = ['input', 'cacheRead', 'cacheWrite', 'output']

const zh = {
  'chip.aria': '模型与用量：{model}，推理等级 {effort}，共 {tokens} tokens',
  'chip.none': '尚未发起模型请求',
  'model.label': '模型',
  'model.unknown': '未知',
  'effort.label': '推理等级',
  'effort.default': '默认',
  'provider.label': '提供方',
  'mode.label': '类型',
  'mode.oneShot': '一次性子代理',
  'mode.continuable': '可继续子代理',
  'mode.parent': '主会话',
  'tokens.total': '合计',
  'tokens.input': '未缓存输入',
  'tokens.cacheRead': '缓存读',
  'tokens.cacheWrite': '缓存写',
  'tokens.output': '输出',
  'tokens.reasoning': '其中推理',
  'turn.prefix': '本轮',
  'turn.none': '本轮无模型用量',
  'session.total': '会话累计',
  'requests.label': '模型请求',
  'requests.value': '{count} 次',
  'steps.label': '步数',
  'steps.value': '{count} 步',
  'llm.label': '模型耗时',
  'window.label': '上下文窗口',
  'stop.label': '结束原因',
  'stop.completed': '正常完成',
  'stop.aborted': '已中止',
  'stop.blocked': '被阻断',
  'stop.error': '出错',
  'stop.max-tokens': '触及上限',
  'stop.interrupted': '被打断',
  'stop.forked': '已分叉',
  'status.running': '正在运行',
  'status.idle': '已停止',
  'detail.show': '详情',
  'detail.hide': '收起',
  'chip.hint': '（详见本轮对话末尾的用量行）',
  'label.expand': '展开本轮用量详情',
  'label.collapse': '收起本轮用量详情',
}

const en = {
  'chip.aria': 'Model and usage: {model}, reasoning {effort}, {tokens} tokens',
  'chip.none': 'No model request yet',
  'model.label': 'Model',
  'model.unknown': 'unknown',
  'effort.label': 'Reasoning',
  'effort.default': 'default',
  'provider.label': 'Provider',
  'mode.label': 'Kind',
  'mode.oneShot': 'one-shot subagent',
  'mode.continuable': 'continuable subagent',
  'mode.parent': 'main session',
  'tokens.total': 'Total',
  'tokens.input': 'Uncached input',
  'tokens.cacheRead': 'Cache read',
  'tokens.cacheWrite': 'Cache write',
  'tokens.output': 'Output',
  'tokens.reasoning': 'of which reasoning',
  'turn.prefix': 'This turn',
  'turn.none': 'No model usage this turn',
  'session.total': 'Session total',
  'requests.label': 'Model requests',
  'requests.value': '{count}',
  'steps.label': 'Steps',
  'steps.value': '{count}',
  'llm.label': 'Model time',
  'window.label': 'Context window',
  'stop.label': 'Last stop',
  'stop.completed': 'completed',
  'stop.aborted': 'aborted',
  'stop.blocked': 'blocked',
  'stop.error': 'error',
  'stop.max-tokens': 'max tokens',
  'stop.interrupted': 'interrupted',
  'stop.forked': 'forked',
  'status.running': 'running',
  'status.idle': 'stopped',
  'detail.show': 'details',
  'detail.hide': 'hide',
  'chip.hint': '(see the usage line at the end of this turn)',
  'label.expand': 'Show this turn usage details',
  'label.collapse': 'Hide this turn usage details',
}

// No backticks below: this is a plain string concatenation on purpose.
const CSS = [
  '.dsu-chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;',
  'border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:999px;',
  'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));',
  'color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));',
  'font-size:12px;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums;',
  'max-width:46ch;overflow:hidden;text-overflow:ellipsis;cursor:default;user-select:none}',
  '.dsu-chip[data-state="running"]{border-color:var(--dsw-alias-brand-primary,rgba(79,157,217,.6))}',
  '.dsu-whale{font-size:12px;line-height:1}',
  '.dsu-model{color:var(--dsw-alias-label-primary,inherit);font-weight:600;',
  'overflow:hidden;text-overflow:ellipsis}',
  '.dsu-sep{opacity:.45}',
  '.dsu-dot{width:6px;height:6px;border-radius:50%;flex:none;',
  'background:var(--dsw-alias-label-tertiary,rgba(127,127,127,.7))}',
  '.dsu-dot[data-state="running"]{background:var(--dsw-alias-brand-primary,#4f9dd9);',
  'animation:dsu-pulse 1.4s ease-in-out infinite}',
  '@keyframes dsu-pulse{0%,100%{opacity:1}50%{opacity:.25}}',
  '.dsu-tail{margin:6px 0 2px;font-size:12px;line-height:1.6;',
  'color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));font-variant-numeric:tabular-nums}',
  '.dsu-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  // 2026-10-02 用户反馈「详情按钮太丑，要像链接」：把 button 的浏览器/系统外观整个按死
  // （appearance / background / border / box-shadow / padding / 高度全 !important），
  // 用 `button.dsu-toggle` 提升特异性，免得被应用级的 button 样式盖回去。
  'button.dsu-toggle{appearance:none!important;-webkit-appearance:none!important;',
  'background:none!important;border:0!important;border-radius:0!important;box-shadow:none!important;',
  'padding:0!important;margin:0!important;height:auto!important;min-height:0!important;width:auto!important;',
  'font:inherit!important;color:var(--dsw-alias-brand-primary,#4f9dd9)!important;cursor:pointer;',
  'text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}',
  'button.dsu-toggle:hover{color:var(--dsw-alias-brand-primary,#4f9dd9);text-decoration-thickness:2px}',
  'button.dsu-toggle:active{opacity:.65}',
  'button.dsu-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f9dd9);outline-offset:2px}',
  '.dsu-panel{margin:8px 0 2px;padding:10px 12px;border-radius:10px;',
  'border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));',
  'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05));',
  'display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:4px 18px}',
  '.dsu-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;',
  'font-size:12px;line-height:1.6;font-variant-numeric:tabular-nums}',
  '.dsu-k{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85))}',
  '.dsu-v{color:var(--dsw-alias-label-primary,inherit);text-align:right;',
  'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
].join('')

/** Inject the sheet once; a second activation finds the element already there. */
function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const element = document.createElement('style')
  element.id = STYLE_ID
  element.textContent = CSS
  document.head.appendChild(element)
}

/** Compact count in the same shape the shipped subagent catalog uses. */
function formatTokens(value) {
  const scaled = (next) => (next >= 100 ? String(Math.round(next)) : String(Math.round(next * 10) / 10))
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(Math.round(value))
  if (value < 1000000) return scaled(value / 1000) + 'K'
  return scaled(value / 1000000) + 'M'
}

/** Exact count with thousands separators, for the details panel. */
function exact(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '0'
}

/** Wall time, shrinking precision as it grows. */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return String(total) + 's'
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return String(minutes) + 'm' + String(seconds).padStart(2, '0') + 's'
  const hours = Math.floor(minutes / 60)
  return String(hours) + 'h' + String(minutes % 60).padStart(2, '0') + 'm'
}

/** The four disjoint buckets, summed the way the shipped catalog sums them. */
function totalOf(usage) {
  if (usage === undefined || usage === null) return 0
  return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
}

/** The first non-empty value of one route field across the recorded candidates. */
function fieldOf(view, field) {
  const candidates = [view.config, view.effective, view.requested, view.selected]
  for (const route of candidates) {
    if (route === undefined || route === null) continue
    const value = route[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** The turn row whose number matches, else the newest row at or before it. */
function turnRowOf(view, turn) {
  const rows = Array.isArray(view.perTurn) ? view.perTurn : []
  if (rows.length === 0) return null
  const exactRow = rows.find((row) => row.turn === turn)
  if (exactRow !== undefined) return exactRow
  if (typeof turn !== 'number') return rows[rows.length - 1]
  let candidate = null
  for (const row of rows) {
    if (row.turn <= turn) candidate = row
  }
  return candidate ?? rows[rows.length - 1]
}

/** Translate a stop reason, falling back to the raw kind for one this build does not know. */
function stopLabel(t, kind) {
  if (kind === null || kind === undefined) return null
  const key = 'stop.' + kind
  // The Chinese dictionary is the key-set source of truth; a future reason must
  // render as itself rather than as a missing-key placeholder.
  return Object.prototype.hasOwnProperty.call(zh, key) ? t(key) : kind
}

/** One label/value row of the details panel. */
function row(label, value, key) {
  return react.createElement(
    'div',
    { className: 'dsu-row', key },
    react.createElement('span', { className: 'dsu-k' }, label),
    react.createElement('span', { className: 'dsu-v', title: String(value) }, value),
  )
}

/** The route summary shared by both seats: model · reasoning · tokens. */
function summarize(view, t) {
  const model = fieldOf(view, 'model') ?? t('model.unknown')
  const effort = fieldOf(view, 'reasoningEffort') ?? t('effort.default')
  const tokens = formatTokens(totalOf(view.usage))
  return { model, effort, tokens, route: fieldOf(view, 'provider') }
}

/** Every bucket line of one usage record, plus the reasoning subset. */
function bucketRows(usage, t, prefix) {
  const rows = BUCKETS.map((bucket) => {
    const value = usage?.[bucket] ?? 0
    return row(t('tokens.' + bucket), exact(value), prefix + bucket)
  })
  const reasoning = usage?.reasoning ?? 0
  if (reasoning > 0) rows.push(row(t('tokens.reasoning'), exact(reasoning), prefix + 'reasoning'))
  rows.push(row(t('tokens.total'), exact(totalOf(usage)), prefix + 'total'))
  return rows
}

/** The chip beside the session title: the always-available answer. */
function UsageChip(props) {
  const { useProjection, t } = props
  const view = useProjection(PROJECTION_KEY)
  if (view === undefined || view === null) return null

  const summary = summarize(view, t)
  const tokens = totalOf(view.usage)
  const mode = view.mode === 'one-shot' || view.mode === 'continuable' ? view.mode : null
  const nothing = view.config === null && view.effective === null && view.requested === null && view.selected === null
  if (nothing && tokens === 0) return null

  const parts = []
  if (mode !== null) parts.push(t(mode === 'one-shot' ? 'mode.oneShot' : 'mode.continuable'))
  parts.push(summary.model)
  parts.push(t('effort.label') + ' ' + summary.effort)
  if (view.requests > 0 || tokens > 0) parts.push(summary.tokens + ' tok')

  const hint = [
    t('provider.label') + ': ' + (summary.route ?? '—'),
    t('model.label') + ': ' + summary.model,
    t('effort.label') + ': ' + summary.effort,
    t('tokens.total') + ': ' + exact(tokens),
    t(mode === 'one-shot' ? 'mode.oneShot' : mode === 'continuable' ? 'mode.continuable' : 'mode.parent'),
    view.running ? t('status.running') : t('status.idle'),
    t('chip.hint'),
  ].join('\n')

  return react.createElement(
    'span',
    {
      className: 'dsu-chip',
      'data-state': view.running ? 'running' : 'idle',
      title: hint,
      'aria-label': t('chip.aria', { model: summary.model, effort: summary.effort, tokens: String(tokens) }),
    },
    react.createElement('span', { className: 'dsu-whale', 'aria-hidden': 'true' }, '\u{1F40B}'),
    react.createElement('span', { className: 'dsu-model' }, parts.join(' · ')),
    react.createElement('span', { className: 'dsu-dot', 'data-state': view.running ? 'running' : 'idle' }),
  )
}

/** The line after a completed turn, expandable into the full breakdown. */
function TurnUsage(props) {
  const { useProjection, turn, t } = props
  const view = useProjection(PROJECTION_KEY)
  const [open, setOpen] = react.useState(false)
  if (view === undefined || view === null) return null

  const summary = summarize(view, t)
  const rowData = turnRowOf(view, turn)
  const turnTokens = rowData === null ? 0 : totalOf(rowData)
  const nothing = rowData === null && totalOf(view.usage) === 0 && view.config === null && view.selected === null
  if (nothing) return null

  const headline = rowData === null
    ? t('turn.none')
    : t('turn.prefix') + ' ' + formatTokens(turnTokens) + ' tok'
  const stopKey = rowData?.stop ?? view.stop
  const stop = stopLabel(t, stopKey)

  const details = []
  details.push(row(t('model.label'), summary.model + (summary.route === null ? '' : ' · ' + summary.route), 'model'))
  details.push(row(t('effort.label'), summary.effort, 'effort'))
  if (rowData !== null) {
    details.push(row(t('turn.prefix'), formatTokens(turnTokens) + ' tok', 'turn-total'))
    if (rowData.ms > 0) details.push(row(t('llm.label'), formatDuration(rowData.ms), 'turn-ms'))
    if (rowData.steps > 0) details.push(row(t('steps.label'), t('steps.value', { count: String(rowData.steps) }), 'turn-steps'))
  }
  details.push(row(t('session.total'), formatTokens(totalOf(view.usage)) + ' tok', 'session-total'))
  details.push(row(t('requests.label'), t('requests.value', { count: String(view.requests) }), 'requests'))
  details.push(row(t('steps.label'), t('steps.value', { count: String(view.steps) }), 'steps'))
  if (view.llmMs > 0) details.push(row(t('llm.label'), formatDuration(view.llmMs), 'llm'))
  if (view.contextWindow !== null && view.contextWindow !== undefined) {
    details.push(row(t('window.label'), exact(view.contextWindow), 'window'))
  }
  if (stop !== null) details.push(row(t('stop.label'), stop, 'stop'))
  details.push(...bucketRows(view.usage, t, 'usage-'))

  return react.createElement(
    'div',
    { className: 'dsu-tail', 'data-subagent-usage': '' },
    react.createElement(
      'div',
      { className: 'dsu-line' },
      react.createElement('span', { className: 'dsu-whale', 'aria-hidden': 'true' }, '\u{1F40B}'),
      react.createElement('span', { className: 'dsu-model' }, summary.model),
      react.createElement('span', { className: 'dsu-sep' }, '·'),
      react.createElement('span', null, t('effort.label') + ' ' + summary.effort),
      react.createElement('span', { className: 'dsu-sep' }, '·'),
      react.createElement('span', null, headline),
      react.createElement(
        'button',
        {
          type: 'button',
          className: 'dsu-toggle',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': open ? t('label.collapse') : t('label.expand'),
          onClick: () => setOpen((value) => !value),
        },
        open ? t('detail.hide') : t('detail.show'),
      ),
    ),
    open ? react.createElement('div', { className: 'dsu-panel' }, details) : null,
  )
}

/** Required services: the slot table and the dictionary registry. */
const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the two additive seats.
 *
 * @param ctx - client root context.
 */
function apply(ctx) {
  ensureStyle()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'subagent-usage: dictionaries')
  ctx.slots.inject(HEADER_SLOT, () =>
    ctx.slots.register({ name: HEADER_SLOT, id: 'subagent-usage', order: -20, locale: NS }, UsageChip),
  )
  ctx.slots.inject(TAIL_SLOT, () =>
    ctx.slots.register({ name: TAIL_SLOT, id: 'subagent-usage-turn', order: 100, locale: NS }, TurnUsage),
  )
}

exports.apply = apply
exports.inject = inject

return module.exports; } });
