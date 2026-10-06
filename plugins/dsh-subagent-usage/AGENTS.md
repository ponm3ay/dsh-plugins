# AGENTS.md — dsh-subagent-usage

Maintainer briefing: what this package is, the exact DSH contracts it rests on,
the invariants that break it silently, and how to prove a change is safe.
Human-facing usage lives in [README.md](README.md); both halves are commented
where the reasoning matters, so the code is the third document.

## What it is

A third-party DSH plugin that answers one question per session: *which model ran,
at which reasoning effort, and what did it cost?* It is built for subagent
conversations — open a child and the answer is on screen — and it deliberately
has no other product surface.

| Half | File | Job |
|---|---|---|
| Host (Node) | `entry.js` | Registers ONE session-projection unit (`subagentUsage`) folding route + durable usage out of the session's own committed log |
| Browser | `src/client.js` → `lib/client.js` | Reads that projection and renders two additive seats: a header chip, and a per-turn line with an expandable breakdown |

There is no settings page, no tool, no HTTP route, no message, and no dependency:
`entry.js` imports nothing at all, which is why it resolves from this directory
without a `node_modules`.

### The two DSH facts everything rests on

1. **`ctx.sessionProjections.register(definition)` is the only delivery path.**
   The registry subscribes to `session/event` once and drives every registered
   unit's synchronous `apply` eagerly. A definition carrying `wire` becomes
   client-visible; one without it stays host-only. `SessionProjectionValues` is
   `Partial<SessionProjectionMap> & Readonly<Record<string, SessionProjectionValue>>`
   — an OPEN record — so a key contributed here travels to the client exactly
   like a shipped key, and the client's `useProjection(key)` needs no
   registration of its own. Registration is an effect on the mounting fiber:
   unload the plugin and the key disappears.

2. **The authoritative model answer is the child's own frozen call config.**
   `request/header` carries `header.config = {provider, model, reasoningEffort,
   maxTokens}` — what the request actually went out as. That is strictly better
   than anything a delegation request says: the descriptor only records an
   *asked-for* override (`agentProvider`/`agentModel`/`agentReasoningEffort`), the
   session's `model/selection` only records *its own* choice, and an assembled
   `assistant/message` records which route *served* it. The fold keeps all of
   them, in that priority order, and the client shows the best one it has.

   A real example from this deployment: a one-shot child reported "reasoning
   unknown" in its own prose while its `request/header` said `max`. Reading the
   log rather than the conversation is the whole point.

## The fold contract

- **Whole values only.** Every state field is plain JSON. `checkpoint()` calls
  `structuredClone`, `stateSchema.parse` runs over persisted rows, and the view
  crosses the wire as JSON — so no functions, no class instances, no `undefined`
  holes (unknown text is `null`, never absent).
- **Reference discipline.** An event this unit does not care about returns the
  SAME state reference; the registry's `Object.is` gate then does zero view work
  and publishes nothing. `wire.view` is memoized per state object in a `WeakMap`
  for the same reason. A state change that is internal-only (an open step's
  start time) still produces a new view object and therefore one frame; that is
  the documented behavior of the seam and is cheap by design.
- **The descriptor RESETS the accumulators.** A forked child's log opens with its
  ancestor's seed, which contains that ancestor's turns and usage. The child's own
  `subagent/descriptor` is the authoritative origin of its own work — the same
  discipline `subagentTiming` uses — so everything before it is discarded.
- **Retries ADD.** `llm/retry-started` clears the last-sample slot, so a retried
  attempt accumulates beside the failed one instead of overwriting it. Both really
  spent quota; this matches the shipped `tokenUsage` unit.
- **Usage is four disjoint buckets** (`input` = uncached input, `output`,
  `cacheRead`, `cacheWrite`), summed exactly the way the shipped subagent catalog
  sums them, so the two numbers agree on screen. `reasoning` is a SUBSET of output
  and is never added into a total.

## Invariants that fail silently

| Rule | What happens if it is broken |
|---|---|
| The client half registers with a FRESH `id` in each seat (`subagent-usage`, `subagent-usage-turn`). | Reusing a shipped id (`subagent-catalog`, `@deepseek-ai/dsh-client-ui-deliverables`) puts this entry in THAT cell and REPLACES the shipped one — the shipped control disappears with no error. |
| Both registrations go through `ctx.slots.inject(key, callback)`. | Registering a slot the owner has not declared yet is simply lost; `inject` waits for the owner, which is also what orders this bundle after the conversation UI. |
| The client half requires only `slots` and `locale`. | A service the web client does not compose leaves the fiber PENDING, `apply` never runs, and both seats stay empty with no error anywhere. |
| No backtick inside the CSS blob. | The string ends early; the artifact is built from the wrong place and the change looks like it had no effect. |
| `entry.js` must import nothing. | A static import must resolve from this directory; there is no `node_modules` here, so the fiber fails to load. |
| Never let `wire.view` build a fresh object per call. | Structurally equal is still a change: the wire would publish on every state transition, including internal-only ones. |
| The projection key must not collide with a shipped one. | Registrants sharing a key SHARE one unit (ref-counted, no error) — two folds would write into one state and corrupt both. Taken keys: `tokenUsage`, `contextPressure`, `contextBreakdown`, `sessionStats`, `subagent`, `subagentTiming`, `subagentCatalog`, `plan`, `goal`, `todos`, `inbox`, `title`, `imageLimits`, `sessionListMetadata`. |
| `stateVersion` must be bumped whenever state fields or fold semantics change. | A persisted checkpoint row at the old version is discarded and refolded, which is the intended repair; without the bump an old row reaches `stateSchema.parse` and either throws or restores nonsense. |
| Read/write CJK-bearing files with the file tools, never PowerShell `Set-Content`. | Windows PowerShell 5.1 decodes BOM-less UTF-8 as GBK and destroys every Chinese character on the round-trip. |
| Install EITHER as a profile patch row OR as a bundle — never both. | Two inserted rows share one id, and the client-modules table refuses a package that resolves from multiple active loader sources. |

## Change → what to run

| Changed | To see it |
|---|---|
| `src/client.js` | `node build-client.mjs`, then reload the page (the client HMR receiver picks a changed bundle up, but a new artifact revision is not guaranteed to be re-fetched in place). |
| `entry.js` | Nothing manual: the profile patch is watched and the tree recomposes. Check the entry's `fiberPhase` is `active`; restart DSH only if it stays inactive. |
| `stateVersion` / state fields | Bump `stateVersion` first — old checkpoint rows are then discarded instead of misread. |
| Docs only | Nothing. |

## Verifying a change

Both suites are runnable together, offline, with no DSH process and no fixtures
checked in:

```sh
node verify/fold-test.mjs [path/to/session.v4.jsonl.zstd]
node verify/client-test.mjs
```

- `fold-test.mjs` replays a REAL session log (the largest under `$DSH_HOME/sessions`
  when no path is given) through the unit's own `init`/`apply` and checks:
  the reference gate, that a model and reasoning effort come out of the log alone,
  that the usage totals equal an independent single-pass recount, that per-turn
  rows add up to the session totals, that a JSON round-trip through
  `stateSchema.parse` reproduces the same view, and — on synthetic logs — that a
  forked seed is reset by the child's own descriptor and that a continuable
  descriptor's `agent*` fields are read as the requested route while its
  `provider` is NOT mistaken for the LLM provider.
- `client-test.mjs` gives the browser half the three facts it needs (a module
  loader, a `react` word in the module table, a context with `slots`/`locale`/
  `effect`), runs `apply`, and renders both seats against a realistic projection
  value: the model, the reasoning effort, the four-bucket total, the subagent
  tag, the per-turn number, the expanded breakdown, the empty-session case, and
  a partial value from a host that does not know a field yet.

Neither suite needs the network, a browser, a fixed port, or an interactive
prompt. The log decoder cuts zstd frames apart on the magic number because a
session log is a concatenation of independent frames — Node's one-shot decoder
stops after the first, which looks exactly like a one-line session.

What the suites cannot prove, and a human must: that the client half is actually
served to a page. Check it with the Inspect providers —

```text
cordis_inspect_query(platform: "client", provider: "Slots", method: "listSubTree",
  input: { root: "conversation.session.header.actions" })
```

— and look for `{ "id": "subagent-usage", "order": -20, "active": true }` between
`subagent-catalog` and `agent-preset`. The same query against
`conversation.chat.turnTail` must show `subagent-usage-turn`.

## Install

Two routes exist — **pick exactly one**:

| Route | How | Notes |
|---|---|---|
| Bundle (recommended) | put the package name into the profile's `dsh.profile.bundles`, then `pnpm install` | ships its own `cordis.patch.yml`; hot-loads without a restart |
| Profile patch row | append `- insert: [{ id: subagent-usage, name: dsh-subagent-usage }]` to the profile's `cordis.patch.yml` | for profiles that mount third-party plugins by hand |

⚠️ **Never both at once**: two inserted rows share one id, and the client-modules
table refuses a package that resolves from multiple active loader sources.

On some deployments `dsh plugin --profile <name> add <dir>` fails at the last step with
`EPERM ... rename package.json` (the running process holds the profile manifest);
pnpm has already written the dependency and the `node_modules` link by then, so
finishing the manifest by hand is the equivalent operation, not a workaround that
skips something.

The repo-level installer does all of this for you:
`pwsh -File scripts/install.ps1 -Profile <name> -Plugin dsh-subagent-usage`
(see [`docs/install.md`](../../docs/install.md)).
