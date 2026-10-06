/**
 * dsh-subagent-usage — host half.
 *
 * One job: register a single session-projection unit that folds the model route
 * and the durable token usage of ONE session out of its own committed event log.
 * The web client half renders that value inside the session's conversation, so
 * opening a subagent conversation shows which model it really ran on, at which
 * reasoning effort, and what it cost — live while it runs, and still there after
 * it settles.
 *
 * Why a projection and not a message: a projection is a read model. It never
 * enters the model's context, never appends to the log, and is re-derived by the
 * registry from already-committed events — so nothing this plugin shows can
 * change what a subagent sees or what it costs.
 *
 * Two DSH facts this rests on:
 *
 * 1. `ctx.sessionProjections.register(definition)` drives a pure synchronous fold
 *    over every committed session event, and a definition carrying `wire` makes
 *    the value visible to clients (`SessionProjectionValues` is an OPEN record,
 *    so a key contributed by a plugin travels exactly like a shipped one).
 *    Registration is an effect on this plugin's fiber: unloading removes the key.
 * 2. The authoritative answer to "which model and reasoning effort" is not the
 *    delegation request, it is the child's own frozen call configuration —
 *    `request/header` carries `header.config = {provider, model, reasoningEffort,
 *    maxTokens}`. `model/selection` carries the session's own selection, and an
 *    assembled `assistant/message` carries the provider/model that actually
 *    served it. The fold records all three rather than trusting one.
 *
 * Dependency-free on purpose: the module imports nothing, so it resolves from
 * this directory alone (no node_modules, no pnpm install, no version skew).
 *
 * @module dsh-subagent-usage
 */

/** Cordis plugin name. */
export const name = 'subagent-usage'

/** The projection registry is the whole point; without it the fiber stays pending. */
export const inject = ['sessionProjections']

/** Projection key read by the client half as `useProjection('subagentUsage')`. */
export const PROJECTION_KEY = 'subagentUsage'

/** Bump whenever the state fields or the fold semantics change. */
const STATE_VERSION = 1

/** Per-turn detail is UI-scale; older turns beyond this are dropped. */
const PER_TURN_LIMIT = 200

/** Distinct routes remembered for the details panel. */
const ROUTE_LIMIT = 24

//#region small value helpers (no validation library is imported)

const isInt = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const isStr = (value) => typeof value === 'string'
const isFilled = (value) => typeof value === 'string' && value !== ''
const isObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A non-empty string or null — the only two shapes this fold stores for text. */
const textOrNull = (value) => (isFilled(value) ? value : null)

/**
 * Read one model route out of an event payload.
 *
 * The three payloads this reads do not share a field set, so every caller passes
 * the exact triple it owns: `model/selection` and `request/header.config` carry
 * `provider`/`model`/`reasoningEffort`, while a subagent descriptor carries
 * `agentProvider`/`agentModel`/`agentReasoningEffort` — and its plain `provider`
 * is the SUBAGENT provider name, never the LLM one, which is why that field is
 * read separately in {@link descriptorOf}.
 *
 * @param value - candidate payload.
 * @returns a route with null holes, or null when the payload names no route.
 */
function routeOf(value) {
  if (!isObj(value)) return null
  const provider = textOrNull(value.provider)
  const model = textOrNull(value.model)
  const reasoningEffort = textOrNull(value.reasoningEffort)
  if (provider === null && model === null && reasoningEffort === null) return null
  return { provider, model, reasoningEffort }
}

/** A frozen call configuration: a route plus the request's token ceiling. */
function configOf(value) {
  const route = routeOf(value)
  if (route === null) return null
  return { ...route, maxTokens: isObj(value) && isInt(value.maxTokens) ? value.maxTokens : null }
}

/** Where the delegation was asked to run, from the child's own durable descriptor. */
function requestedOf(value) {
  if (!isObj(value)) return null
  return routeOf({
    provider: value.agentProvider,
    model: value.agentModel,
    reasoningEffort: value.agentReasoningEffort,
  })
}

/** The child's durable descriptor identity, or null when the payload is unusable. */
function descriptorOf(value) {
  if (!isObj(value)) return null
  if (value.mode !== 'one-shot' && value.mode !== 'continuable') return null
  return {
    mode: value.mode,
    label: textOrNull(value.label),
    subProvider: textOrNull(value.provider),
    requested: requestedOf(value),
  }
}

/** The four disjoint provider buckets. `reasoning` is a subset of `output`, never added in. */
function bucketsOf(value) {
  const bucket = isObj(value) ? value : {}
  return {
    input: isInt(bucket.input) ? bucket.input : 0,
    output: isInt(bucket.output) ? bucket.output : 0,
    cacheRead: isInt(bucket.cacheRead) ? bucket.cacheRead : 0,
    cacheWrite: isInt(bucket.cacheWrite) ? bucket.cacheWrite : 0,
    reasoning: isInt(bucket.reasoning) ? bucket.reasoning : 0,
  }
}

/** Provider usage as the log records it (`TokenUsage`) in this fold's bucket names. */
function bucketsFrom(usage) {
  return {
    input: isInt(usage.inputTokens) ? usage.inputTokens : 0,
    output: isInt(usage.outputTokens) ? usage.outputTokens : 0,
    cacheRead: isInt(usage.cacheReadTokens) ? usage.cacheReadTokens : 0,
    cacheWrite: isInt(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0,
    reasoning: isInt(usage.reasoningTokens) ? usage.reasoningTokens : 0,
  }
}

const sameBuckets = (left, right) =>
  left.input === right.input &&
  left.output === right.output &&
  left.cacheRead === right.cacheRead &&
  left.cacheWrite === right.cacheWrite &&
  left.reasoning === right.reasoning

/** Sum buckets, optionally subtracting a superseded sample. Never returns a negative field. */
function addBuckets(total, part, sign) {
  const step = (sum, next) => Math.max(0, sum + sign * next)
  return {
    input: step(total.input, part.input),
    output: step(total.output, part.output),
    cacheRead: step(total.cacheRead, part.cacheRead),
    cacheWrite: step(total.cacheWrite, part.cacheWrite),
    reasoning: step(total.reasoning, part.reasoning),
  }
}

/** The provider usage of one assistant settlement: its own record, else the stream's last sample. */
function usageOf(event) {
  const data = event.data
  if (!isObj(data)) return null
  if (isObj(data.usage)) return data.usage
  if (!Array.isArray(data.stream)) return null
  for (let index = data.stream.length - 1; index >= 0; index -= 1) {
    const record = data.stream[index]
    if (!isObj(record) || record.type !== 'chunk') continue
    const chunk = record.chunk
    if (isObj(chunk) && chunk.type === 'usage' && isObj(chunk.usage)) return chunk.usage
  }
  return null
}

/** The provider and model that actually served an assembled message. */
function servedOf(event) {
  if (event.type !== 'assistant/message') return null
  const source = event.data?.message?.source
  if (!isObj(source) || source.kind !== 'model') return null
  return routeOf({ provider: source.provider, model: source.model })
}

const sameRoute = (left, right) =>
  left !== null &&
  right !== null &&
  left.provider === right.provider &&
  left.model === right.model &&
  left.reasoningEffort === right.reasoningEffort

//#endregion

//#region state shape

/** A fresh, empty fold state. */
function init() {
  return {
    /** `model/selection`: what the session itself selected. */
    sel: null,
    /** `request/header`: the frozen call configuration of the live request series. */
    cfg: null,
    /** `subagent/descriptor`: the delegation identity, when this session is a child. */
    desc: null,
    /** `assistant/message`: the route that actually served the last assembled message. */
    eff: null,
    /** `request/context`: the provider's context window for this session. */
    ctxWin: null,
    /** Request series opened (`request/header` count). */
    req: 0,
    /** Highest turn number entered. */
    turns: 0,
    /** Closed steps. */
    steps: 0,
    /** A turn is open. */
    running: false,
    /** How the last closed turn ended (`turn/end` reason kind). */
    stop: null,
    /** First and last event time this fold cared about. */
    firstAt: null,
    lastAt: null,
    /** Summed model wall time over settled steps. */
    llmMs: 0,
    /** Durable provider usage totals. */
    usage: bucketsOf(null),
    /** The last counted usage sample, so a retried attempt replaces instead of adding. */
    sample: null,
    /** The open step's model-time window. */
    openStep: null,
    /** Per-turn detail, oldest first. */
    perTurn: [],
    /** Distinct routes seen, most recently used last. */
    routes: [],
  }
}

/** Restore one per-turn row, or null when unusable. */
function turnOf(value) {
  if (!isObj(value) || !isInt(value.turn)) return null
  return {
    turn: value.turn,
    provider: textOrNull(value.provider),
    model: textOrNull(value.model),
    reasoningEffort: textOrNull(value.reasoningEffort),
    input: isInt(value.input) ? value.input : 0,
    output: isInt(value.output) ? value.output : 0,
    cacheRead: isInt(value.cacheRead) ? value.cacheRead : 0,
    cacheWrite: isInt(value.cacheWrite) ? value.cacheWrite : 0,
    reasoning: isInt(value.reasoning) ? value.reasoning : 0,
    ms: isNum(value.ms) ? value.ms : 0,
    steps: isInt(value.steps) ? value.steps : 0,
    stop: textOrNull(value.stop),
    endSeq: isInt(value.endSeq) ? value.endSeq : null,
  }
}

/** Restore one route row, or null when unusable. */
function routeRowOf(value) {
  if (!isObj(value)) return null
  const route = routeOf(value)
  if (route === null) return null
  return {
    ...route,
    maxTokens: isInt(value.maxTokens) ? value.maxTokens : null,
    requests: isInt(value.requests) ? value.requests : 0,
  }
}

/**
 * Rebuild a state from a persisted checkpoint row.
 *
 * Only rows written at {@link STATE_VERSION} reach this method, so it is a
 * boundary check rather than a migration: unknown or malformed fields fall back
 * to their empty value, and everything it returns is a fresh plain object.
 */
function normalizeState(value) {
  const state = init()
  if (!isObj(value)) return state
  state.sel = routeOf(value.sel)
  state.cfg = isObj(value.cfg) ? configOf(value.cfg) : null
  state.desc =
    isObj(value.desc) && (value.desc.mode === 'one-shot' || value.desc.mode === 'continuable')
      ? {
          mode: value.desc.mode,
          label: textOrNull(value.desc.label),
          subProvider: textOrNull(value.desc.subProvider),
          requested: requestedOf(value.desc.requested),
        }
      : null
  state.eff = routeOf(value.eff)
  state.ctxWin = isInt(value.ctxWin) ? value.ctxWin : null
  state.req = isInt(value.req) ? value.req : 0
  state.turns = isInt(value.turns) ? value.turns : 0
  state.steps = isInt(value.steps) ? value.steps : 0
  state.running = value.running === true
  state.stop = textOrNull(value.stop)
  state.firstAt = isNum(value.firstAt) ? value.firstAt : null
  state.lastAt = isNum(value.lastAt) ? value.lastAt : null
  state.llmMs = isNum(value.llmMs) ? value.llmMs : 0
  state.usage = bucketsOf(value.usage)
  state.sample =
    isObj(value.sample) && isInt(value.sample.turn) && isInt(value.sample.step)
      ? { turn: value.sample.turn, step: value.sample.step, buckets: bucketsOf(value.sample.buckets) }
      : null
  state.openStep =
    isObj(value.openStep) && isInt(value.openStep.turn) && isInt(value.openStep.step) && isNum(value.openStep.at)
      ? { turn: value.openStep.turn, step: value.openStep.step, at: value.openStep.at }
      : null
  state.perTurn = Array.isArray(value.perTurn) ? value.perTurn.map(turnOf).filter(Boolean) : []
  state.routes = Array.isArray(value.routes) ? value.routes.map(routeRowOf).filter(Boolean) : []
  return state
}

//#endregion

//#region fold

/** The best route this fold can name right now: what ran, else what was asked for. */
function displayRoute(state) {
  return state.cfg ?? state.eff ?? state.desc?.requested ?? state.sel ?? null
}

/** Insert or replace the turn row for `turn`, then write it back in place. */
function writeTurn(rows, turn, mutate) {
  const index = rows.findIndex((row) => row.turn === turn)
  const base =
    index === -1
      ? {
          turn,
          provider: null,
          model: null,
          reasoningEffort: null,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          ms: 0,
          steps: 0,
          stop: null,
          endSeq: null,
        }
      : rows[index]
  const next = mutate(base)
  const out = index === -1 ? [...rows, next] : rows.map((row, at) => (at === index ? next : row))
  return out.length > PER_TURN_LIMIT ? out.slice(out.length - PER_TURN_LIMIT) : out
}

/** Remember one request series; repeats of the same route only bump its count. */
function writeRoute(routes, route) {
  if (route === null) return routes
  const index = routes.findIndex((row) => sameRoute(row, route))
  if (index === -1) {
    return [...routes, { ...route, requests: 1 }].slice(-ROUTE_LIMIT)
  }
  const next = routes.map((row, at) => (at === index ? { ...row, requests: row.requests + 1 } : row))
  return next.length > ROUTE_LIMIT ? next.slice(next.length - ROUTE_LIMIT) : next
}

/**
 * Fold one committed event.
 *
 * Reference discipline: an event this unit does not care about returns the SAME
 * state reference, which is what keeps the registry's `Object.is` gate from
 * publishing a frame. Every branch that changes anything builds a new object.
 *
 * The `subagent/descriptor` branch RESETS the accumulators. A forked child's log
 * opens with its ancestor's seed, which contains that ancestor's turns and usage;
 * the child's own descriptor is the authoritative origin of its own work (the
 * same discipline `subagentTiming` uses), so everything before it is not this
 * session's cost.
 *
 * @param state - current fold state.
 * @param event - committed session event.
 * @returns the next state, or the same reference when nothing changed.
 */
function foldState(state, event) {
  const time = isNum(event.time) ? event.time : null
  const data = isObj(event.data) ? event.data : {}
  const turn = isInt(data.turn) ? data.turn : null
  const step = isInt(data.step) ? data.step : null
  const stamp = (next) => (time === null ? next : { ...next, lastAt: next.lastAt === null ? time : Math.max(next.lastAt, time) })

  switch (event.type) {
    case 'subagent/descriptor': {
      const desc = descriptorOf(data)
      if (desc === null) return state
      const fresh = init()
      return stamp({ ...fresh, desc, running: false })
    }
    case 'model/selection': {
      const sel = routeOf(data)
      if (sel === null || sameRoute(state.sel, sel)) return state
      return stamp({ ...state, sel })
    }
    case 'request/header': {
      const cfg = configOf(data.header?.config)
      if (cfg === null) return state
      return stamp({
        ...state,
        cfg,
        req: state.req + 1,
        routes: writeRoute(state.routes, cfg),
      })
    }
    case 'request/context': {
      const ctxWin = isInt(data.contextWindow) && data.contextWindow > 0 ? data.contextWindow : state.ctxWin
      // Some routes report their provider/model only here; keep the config usable.
      const cfg = state.cfg ?? configOf({ provider: data.provider, model: data.model })
      if (ctxWin === state.ctxWin && sameRoute(state.cfg, cfg)) return state
      return stamp({ ...state, ctxWin, cfg })
    }
    case 'step/start': {
      if (turn === null || step === null || time === null) return state
      return { ...state, openStep: { turn, step, at: time } }
    }
    case 'step/end':
      return stamp({ ...state, steps: state.steps + 1 })
    case 'turn/start': {
      if (turn === null) return state
      return stamp({ ...state, turns: Math.max(state.turns, turn), running: true, stop: null })
    }
    case 'turn/end': {
      const reason = isObj(data.reason) && isStr(data.reason.kind) ? data.reason.kind : null
      const next =
        turn === null
          ? state
          : {
              ...state,
              perTurn: writeTurn(state.perTurn, turn, (row) => ({
                ...row,
                stop: reason,
                endSeq: isInt(event.seq) ? event.seq : row.endSeq,
              })),
            }
      return stamp({ ...next, running: false, stop: reason, openStep: null })
    }
    case 'llm/retry-started': {
      const sample = state.sample
      if (sample === null || turn === null || step === null) return state
      if (sample.turn !== turn || sample.step !== step) return state
      // The retried attempt reports its own usage; clearing the slot makes the
      // replacement rule ADD the retry instead of overwriting the failed try.
      return { ...state, sample: null }
    }
    case 'assistant/message':
    case 'assistant/attempt': {
      let next = state
      let changed = false

      const served = servedOf(event)
      if (served !== null && !sameRoute(state.eff, served)) {
        next = { ...next, eff: served }
        changed = true
      }

      const open = state.openStep
      if (open !== null && turn !== null && step !== null && open.turn === turn && open.step === step) {
        const spent = time === null ? 0 : Math.max(0, time - open.at)
        next = {
          ...next,
          llmMs: next.llmMs + spent,
          openStep: null,
          perTurn: writeTurn(next.perTurn, turn, (row) => ({ ...row, ms: row.ms + spent, steps: row.steps + 1 })),
        }
        changed = true
      }

      const usage = usageOf(event)
      if (usage !== null && turn !== null && step !== null) {
        const buckets = bucketsFrom(usage)
        const previous =
          state.sample !== null && state.sample.turn === turn && state.sample.step === step ? state.sample.buckets : null
        if (previous === null || !sameBuckets(previous, buckets)) {
          const route = displayRoute(next)
          next = {
            ...next,
            usage: addBuckets(addBuckets(next.usage, previous ?? bucketsOf(null), -1), buckets, 1),
            perTurn: writeTurn(next.perTurn, turn, (row) => {
              const cleared = addBuckets(row, previous ?? bucketsOf(null), -1)
              const filled = addBuckets(cleared, buckets, 1)
              return {
                ...row,
                ...filled,
                provider: route?.provider ?? row.provider,
                model: route?.model ?? row.model,
                reasoningEffort: route?.reasoningEffort ?? row.reasoningEffort,
              }
            }),
            sample: { turn, step, buckets },
          }
          changed = true
        }
      }

      if (!changed) return state
      return stamp(next)
    }
    default:
      return state
  }
}

//#endregion

//#region wire view

/** The client-side view of one session's route and cost. */
function viewOf(state) {
  return {
    selected: state.sel,
    requested: state.desc?.requested ?? null,
    config: state.cfg,
    effective: state.eff,
    mode: state.desc?.mode ?? null,
    label: state.desc?.label ?? null,
    subProvider: state.desc?.subProvider ?? null,
    contextWindow: state.ctxWin,
    requests: state.req,
    turns: state.turns,
    steps: state.steps,
    running: state.running,
    stop: state.stop,
    firstAt: state.firstAt,
    lastAt: state.lastAt,
    llmMs: state.llmMs,
    usage: state.usage,
    perTurn: state.perTurn,
    routes: state.routes,
  }
}

/**
 * Reference-stable view cache.
 *
 * The registry compares consecutive raw views with `Object.is`, so a `view` that
 * built a fresh object on every call would publish a frame for every state
 * change — including internal-only ones. Keying the built view by the state
 * object identity keeps the wire quiet unless something visible moved.
 */
const views = new WeakMap()

/** The view for this state reference, built once per state object. */
function viewFor(state) {
  const cached = views.get(state)
  if (cached !== undefined) return cached
  const built = viewOf(state)
  views.set(state, built)
  return built
}

/** Reject a state that is not the plain JSON this unit stores; accept and rebuild the rest. */
const stateSchema = {
  parse(value) {
    const state = normalizeState(value)
    if (value !== undefined && value !== null && !isObj(value)) {
      throw new Error('subagent-usage: projection state must be a plain object')
    }
    return state
  },
}

/** The value the client receives. Its own builder is the contract, so this only guards. */
const viewSchema = {
  parse(value) {
    if (!isObj(value)) throw new Error('subagent-usage: projection view must be a plain object')
    return value
  },
}

//#endregion

/** The projection unit registered on `ctx.sessionProjections`. */
export const subagentUsageProjectionDefinition = {
  key: PROJECTION_KEY,
  stateVersion: STATE_VERSION,
  stateSchema,
  init,
  apply: foldState,
  wire: { viewSchema, view: viewFor },
}

/**
 * Register the unit. The registration rides this plugin's fiber, so unloading the
 * plugin removes the key and the client reads it as capability absence.
 *
 * @param ctx - host context carrying the projection registry.
 */
export function apply(ctx) {
  ctx.sessionProjections.register(subagentUsageProjectionDefinition)
}

/** Fold entry points exposed for the offline unit test. */
export const __test__ = { foldState, init, normalizeState, viewOf, VIEW_LIMIT: PER_TURN_LIMIT }
