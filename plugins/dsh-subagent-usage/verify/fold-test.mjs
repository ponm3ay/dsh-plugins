// Offline proof for the `subagentUsage` projection unit.
//
// It replays a REAL session log through the unit's own fold and checks the
// properties the client relies on:
//
//   1. unrelated events return the SAME state reference (the registry's
//      `Object.is` gate is what keeps the wire quiet);
//   2. the model and reasoning effort come out of the log, not out of a request;
//   3. the usage totals equal an independent recount of the log;
//   4. per-turn rows add up to the session totals;
//   5. a checkpoint round-trip (JSON clone -> stateSchema.parse) reproduces the
//      same view, which is the path a persisted projection cache takes;
//   6. a forked child's inherited seed is NOT counted as the child's own cost.
//
//   node verify/fold-test.mjs [path/to/session.v4.jsonl.zstd]
//
// With no argument it picks the largest session log under $DSH_HOME/sessions.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { subagentUsageProjectionDefinition } from '../entry.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' -- ' + detail))
}

/** Decode a DSH session log: one zstd frame per flush, cut apart on the magic. */
function decodeLog(path) {
  const bytes = readFileSync(path)
  const cuts = []
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 0x28 && bytes[i + 1] === 0xb5 && bytes[i + 2] === 0x2f && bytes[i + 3] === 0xfd) cuts.push(i)
  }
  let raw = Buffer.alloc(0)
  for (let i = 0; i < cuts.length; i += 1) {
    try {
      raw = Buffer.concat([raw, zstdDecompressSync(bytes.subarray(cuts[i], cuts[i + 1] ?? bytes.length))])
    } catch (error) {
      console.error('  warn  frame ' + String(i) + ' undecodable: ' + error.message)
    }
  }
  return raw
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((row) => row !== null && typeof row === 'object' && typeof row.type === 'string')
}

/** The largest session log below `$DSH_HOME/sessions`. */
function findLog() {
  const home = process.env.DSH_HOME
  if (home === undefined) return undefined
  const sessions = join(home, 'sessions')
  let best
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.v4.jsonl.zstd') {
        const size = statSync(path).size
        if (best === undefined || size > best.size) best = { path, size }
      }
    }
  }
  walk(sessions)
  return best?.path
}

/** Provider usage from one settlement, mirroring the unit's own source preference. */
function usageOf(event) {
  if (event.data?.usage !== undefined) return event.data.usage
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

const bucketsOf = (usage) => ({
  input: usage.inputTokens ?? 0,
  output: usage.outputTokens ?? 0,
  cacheRead: usage.cacheReadTokens ?? 0,
  cacheWrite: usage.cacheWriteTokens ?? 0,
  reasoning: usage.reasoningTokens ?? 0,
})

const totalOf = (usage) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite

/**
 * Independent recount of the durable usage in a log.
 *
 * Written as a straight single-pass accumulation rather than by reusing the
 * unit's helpers, so it is the fold's bookkeeping that is under test.
 */
function recount(events) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  let sample
  for (const event of events) {
    if (event.type === 'llm/retry-started') {
      if (sample !== undefined && sample.turn === event.data.turn && sample.step === event.data.step) sample = undefined
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const usage = usageOf(event)
    if (usage === undefined) continue
    const next = bucketsOf(usage)
    const previous = sample !== undefined && sample.turn === event.data.turn && sample.step === event.data.step ? sample.buckets : undefined
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) continue
    if (previous !== undefined) {
      for (const key of Object.keys(totals)) totals[key] -= previous[key]
    }
    for (const key of Object.keys(totals)) totals[key] += next[key]
    sample = { turn: event.data.turn, step: event.data.step, buckets: next }
  }
  return totals
}

/** Naive upper bound: every settlement counted, retries included, nothing replaced. */
function naiveCeiling(events) {
  let sum = 0
  for (const event of events) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const usage = usageOf(event)
    if (usage === undefined) continue
    sum += totalOf(bucketsOf(usage))
  }
  return sum
}

/** Replay a log through the registered unit. */
function replay(events) {
  const definition = subagentUsageProjectionDefinition
  let state = definition.init({}, 0)
  for (const event of events) state = definition.apply(state, event)
  return { state, view: definition.wire.view(state) }
}

/** The first path at which two JSON-shaped values differ, for a readable failure. */
function firstDifference(left, right, path = '$') {
  if (left === right) return undefined
  if (typeof left !== typeof right) return path + ': ' + JSON.stringify(left) + ' vs ' + JSON.stringify(right)
  if (typeof left !== 'object' || left === null || right === null) {
    return path + ': ' + JSON.stringify(left) + ' vs ' + JSON.stringify(right)
  }
  if (Array.isArray(left) !== Array.isArray(right)) return path + ': array shape differs'
  if (Array.isArray(left)) {
    if (left.length !== right.length) return path + ': length ' + String(left.length) + ' vs ' + String(right.length)
    for (let i = 0; i < left.length; i += 1) {
      const nested = firstDifference(left[i], right[i], path + '[' + String(i) + ']')
      if (nested !== undefined) return nested
    }
    return undefined
  }
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
  if (Object.keys(left).join(',') !== Object.keys(right).join(',')) {
    return path + ': key order ' + Object.keys(left).join(',') + ' vs ' + Object.keys(right).join(',')
  }
  for (const key of keys) {
    const nested = firstDifference(left[key], right[key], path + '.' + key)
    if (nested !== undefined) return nested
  }
  return undefined
}

const path = process.argv[2] ?? findLog()
if (path === undefined) {
  console.error('fold-test: no session log found; pass one explicitly')
  process.exit(2)
}

const events = decodeLog(path)
console.log('== fold-test')
console.log('   log     ' + path)
console.log('   events  ' + String(events.length))

// 1. reference discipline
{
  const { state } = replay(events)
  const ignored = [
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 1, callId: 'x', name: 'read', arguments: '{}' } },
    { type: 'user/message', seq: 2, time: 2, data: { role: 'user', id: 'm', content: [] } },
  ]
  let same = true
  for (const event of ignored) same = same && subagentUsageProjectionDefinition.apply(state, event) === state
  check('unrelated events keep the state reference', same)
}

// 2. the route is read out of the log
const { state, view } = replay(events)
{
  const model = view.config?.model ?? view.effective?.model ?? view.selected?.model ?? view.requested?.model
  check('a model is named from the log alone', typeof model === 'string' && model !== '', JSON.stringify(model))
  const effort = view.config?.reasoningEffort ?? view.selected?.reasoningEffort ?? view.requested?.reasoningEffort
  check('a reasoning effort is named from the log alone', typeof effort === 'string' && effort !== '', JSON.stringify(effort))
}

// 3. totals match an independent recount, and stay under the naive ceiling
{
  const expected = recount(events)
  const actual = { ...view.usage }
  check('usage totals equal the recount', JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify({ actual, expected }))
  const ceiling = naiveCeiling(events)
  check('totals never exceed the naive per-settlement sum', totalOf(actual) <= ceiling, String(totalOf(actual)) + ' <= ' + String(ceiling))
}

// 4. per-turn rows add up to the session totals
{
  const summed = view.perTurn.reduce(
    (carry, row) => ({
      input: carry.input + row.input,
      output: carry.output + row.output,
      cacheRead: carry.cacheRead + row.cacheRead,
      cacheWrite: carry.cacheWrite + row.cacheWrite,
      reasoning: carry.reasoning + row.reasoning,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  )
  check('per-turn rows sum to the session totals', JSON.stringify(summed) === JSON.stringify(view.usage), JSON.stringify({ summed, usage: view.usage }))
  check('every counted turn row carries a model', view.perTurn.every((row) => typeof row.model === 'string' && row.model !== ''))
}

// 5. checkpoint round-trip: persisted rows only ever reach parse()
{
  const cloned = JSON.parse(JSON.stringify(state))
  const restored = subagentUsageProjectionDefinition.stateSchema.parse(cloned)
  const restoredView = subagentUsageProjectionDefinition.wire.view(restored)
  const live = JSON.stringify(view)
  const after = JSON.stringify(restoredView)
  check('a JSON round-trip reproduces the same view', live === after, live === after ? undefined : firstDifference(view, restoredView))
  let threw = false
  try {
    subagentUsageProjectionDefinition.stateSchema.parse('not a state')
  } catch {
    threw = true
  }
  check('a non-object state is rejected', threw)
  check('stateVersion is a non-negative integer', Number.isSafeInteger(subagentUsageProjectionDefinition.stateVersion) && subagentUsageProjectionDefinition.stateVersion >= 0)
}

// 6. a forked child's inherited seed is reset by its own descriptor
{
  const seed = [
    { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 110, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 120,
      data: { turn: 1, step: 1, stream: [], usage: { inputTokens: 1000, outputTokens: 100 }, message: { source: { kind: 'model', provider: 'p', model: 'ancestor' } } },
    },
    { type: 'step/end', seq: 3, time: 121, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 122, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'subagent/descriptor', seq: 5, time: 200, data: { version: 1, mode: 'one-shot', provider: 'in-process' } },
    { type: 'turn/start', seq: 6, time: 210, data: { turn: 1 } },
    { type: 'request/header', seq: 7, time: 211, data: { header: { config: { provider: 'qianwen', model: 'qwen3.8-max', reasoningEffort: 'high' } } } },
    { type: 'step/start', seq: 8, time: 212, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 9,
      time: 260,
      data: { turn: 1, step: 1, stream: [], usage: { inputTokens: 500, outputTokens: 50 }, message: { source: { kind: 'model', provider: 'qianwen', model: 'qwen3.8-max' } } },
    },
    { type: 'step/end', seq: 10, time: 261, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 11, time: 262, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const child = replay(seed)
  check('only the child suffix is counted after its descriptor', totalOf(child.view.usage) === 550, JSON.stringify(child.view.usage))
  check('the child route comes from its own request header', child.view.config?.model === 'qwen3.8-max', JSON.stringify(child.view.config))
  check('the descriptor marks the session as a subagent', child.view.mode === 'one-shot', JSON.stringify(child.view.mode))
  check('model wall time is attributed to the settled step', child.view.llmMs === 48, String(child.view.llmMs))
  check('the last stop reason survives', child.view.stop === 'completed', JSON.stringify(child.view.stop))
}

// 7. a continuable descriptor's requested route is visible before any request
{
  const requested = replay([
    {
      type: 'subagent/descriptor',
      seq: 0,
      time: 1,
      data: { version: 1, mode: 'continuable', label: '扫描', provider: 'in-process', agentProvider: 'tokenhub', agentModel: 'hy3', agentReasoningEffort: 'low' },
    },
  ])
  check('requested route is read from agent* fields only', JSON.stringify(requested.view.requested) === JSON.stringify({ provider: 'tokenhub', model: 'hy3', reasoningEffort: 'low' }), JSON.stringify(requested.view.requested))
  check('the subagent provider is not mistaken for the LLM provider', requested.view.subProvider === 'in-process', JSON.stringify(requested.view.subProvider))
  check('the label is carried for the client', requested.view.label === '扫描', JSON.stringify(requested.view.label))
}

console.log(failures === 0 ? '== all checks passed' : '== ' + String(failures) + ' check(s) FAILED')
process.exit(failures === 0 ? 0 : 1)
