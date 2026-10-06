/**
 * dsh-whale-memory —— 「鲸鱼娘长期记忆区」宿主插件（host 侧，无 client 半体）
 *
 * 目标：让跨会话的记忆不再被上下文窗口卡死。三件事：
 *
 * 1. 捕获（session/event）：
 *    把每个「顶层会话」的表面事件（用户消息 / 助手回复 / 工具调用与结果 / 回合标记）
 *    以 JSONL 流水形式追加到 `$DSH_HOME/memory/journal/<sessionId>.jsonl`。
 *    写盘走内存缓冲 + 定时批量 flush（默认 2 秒），不阻塞会话事件回路；
 *    单行与单文件都设上限，防止无限膨胀。捕获只追加、只读事件对象，绝不改动会话日志。
 *
 * 2. 回忆（system-prompt/assemble 瀑布）：
 *    在每个系统提示词装配完成后，追加一节 `whale-memory`：
 *    最近 N 条会话摘要（digests/）+ 长期记忆索引（index.md）+ 维护指引。
 *    总长默认 ≤ 4.2KB，对便宜子代理模型也无压力。
 *
 * 3. 整理（session/disposed + 启动兜底扫描）：
 *    顶层会话离开注册表、且其流水 ≥ 阈值（默认 8KB）时，调用配置的便宜模型
 *    （默认 xiaomi/mimo-v2.6-flash，走 DSH 凭证库）把流水压缩成 ≤400 字中文摘要，
 *    写入 `digests\<sessionId>.md`。失败只记日志、不抛出，可交给 memory 技能手动兜底。
 *
 * 配置：`$DSH_HOME/memory/plugin.json`（改完下次读配置生效，无需重启）。
 * 依赖纪律：只 import node 内置模块，目录内自解析，无 node_modules。
 *
 * @module dsh-whale-memory
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize } from 'node:path'

/** Cordis 插件名（与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'whale-memory'

/** 硬依赖：llm 服务（用于摘要整理）。⚠️ 严格注入制：未 inject 的服务连读属性都抛错，故定时器用全局 setInterval，不用 ctx.timer。 */
export const inject = ['llm']

//#region 路径与常量

const HOME = normalize(process.env.DSH_HOME || join(homedir(), '.dsh'))
const ROOT = normalize(process.env.DSH_MEMORY_DIR || join(HOME, 'memory'))
const JOURNAL_DIR = join(ROOT, 'journal')
const DIGEST_DIR = join(ROOT, 'digests')
const INDEX_FILE = join(ROOT, 'index.md')
const MEMORY_FILE = join(ROOT, 'memory.md')
const PERSONA_FILE = join(ROOT, 'persona.md')
const CONFIG_FILE = join(ROOT, 'plugin.json')
const STATE_FILE = join(ROOT, 'state.json')
const LOG_FILE = join(ROOT, 'plugin-log.txt')

const LOG_CAP = 64 * 1024
const STATE_VERSION = 1
const RECALL_CACHE_MS = 15_000
const DIGEST_LLM_TIMEOUT_MS = 180_000
const STARTUP_SWEEP_DELAY_MS = 15_000

const DEFAULT_CONFIG = {
  capture: {
    enabled: true,
    topLevelOnly: true,
    journalCapBytes: 512 * 1024,
    flushIntervalMs: 2000,
    maxLineChars: 8192,
    toolResultChars: 4096,
  },
  recall: {
    enabled: true,
    maxPersonaChars: 2600,
    recentDigests: 2,
    maxBlockChars: 5200,
    maxIndexChars: 1400,
    maxDigestChars: 1400,
  },
  digest: {
    enabled: true,
    minJournalBytes: 8 * 1024,
    journalSliceBytes: 300 * 1024,
    provider: 'xiaomi',
    model: 'mimo-v2.6-flash',
    maxTokens: 900,
    keepJournals: 40,
    keepDigests: 60,
  },
}

//#endregion

//#region 小工具

const isObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const pad = (n) => String(n).padStart(2, '0')

const truncate = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…(截断)` : text)

/** 会话 id 落盘前消毒，只保留安全字符。 */
const safeId = (sid) => String(sid).replace(/[^A-Za-z0-9._-]/g, '_')

const journalFileOf = (sid) => join(JOURNAL_DIR, `${safeId(sid)}.jsonl`)

const digestFileOf = (sid) => join(DIGEST_DIR, `${safeId(sid)}.md`)

function ensureDirs() {
  for (const dir of [ROOT, JOURNAL_DIR, DIGEST_DIR]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* 忽略：只读盘/竞态均不影响捕获继续 */
    }
  }
}

function logLine(kind, message) {
  try {
    ensureDirs()
    const stamp = new Date().toISOString()
    const line = `${stamp} [${kind}] ${String(message)}\n`
    appendFileSync(LOG_FILE, line)
    // 日志封顶：超过上限保留后半段
    try {
      if (statSync(LOG_FILE).size > LOG_CAP) {
        const text = readFileSync(LOG_FILE, 'utf8').slice(-(LOG_CAP * 0.8))
        writeFileSync(LOG_FILE, text)
      }
    } catch {
      /* 忽略 */
    }
  } catch {
    /* 日志失败绝不影响主流程 */
  }
}

function loadJson(file, fallback) {
  try {
    if (existsSync(file)) {
      // ⚠️ Windows 下记事本 / PowerShell 5.1 的 "UTF8" 会写 BOM，
      // JSON.parse 会因此失败并静默退回默认值；这里先剥掉 BOM 再解析。
      const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
      return JSON.parse(text)
    }
  } catch (err) {
    logLine('warn', `loadJson ${file}: ${err?.message ?? err}`)
  }
  return fallback
}

function saveJson(file, value) {
  try {
    ensureDirs()
    writeFileSync(file, JSON.stringify(value, null, 2))
  } catch (err) {
    logLine('warn', `saveJson ${file}: ${err?.message ?? err}`)
  }
}

/** 读配置：文件值按节覆盖默认值。 */
function loadConfig() {
  const file = loadJson(CONFIG_FILE, {})
  if (!isObj(file)) return structuredClone(DEFAULT_CONFIG)
  const merged = structuredClone(DEFAULT_CONFIG)
  for (const section of Object.keys(DEFAULT_CONFIG)) {
    if (isObj(file[section])) Object.assign(merged[section], file[section])
  }
  return merged
}

//#endregion

//#region 运行时状态

/** 宿主上下文（apply 时注入；callDigestLlm 等模块级函数从这里取 llm 服务）。 */
let hostCtx = null

let config = loadConfig()
let state = loadJson(STATE_FILE, { version: STATE_VERSION, journals: {}, digested: {} })
if (!isObj(state.journals)) state.journals = {}
if (!isObj(state.digested)) state.digested = {}
let stateDirty = false

/** 待写盘的流水缓冲：sessionId → 行数组（每行是完整 JSONL 记录，含换行符）。 */
const buffers = new Map()
/** 防重复摘要：进行中 / 本进程已摘要的会话。 */
const digesting = new Set()

function saveState() {
  state.version = STATE_VERSION
  saveJson(STATE_FILE, state)
  stateDirty = false
}

//#endregion

//#region 捕获：事件 → 流水行

/** 从内容块数组里抽取文本与附件标记（跳过 reasoning，只留最终内容）。 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!isObj(block)) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text)
    else if (block.type === 'image') parts.push('[图片]')
    else if (block.type === 'file') parts.push(`[文件: ${block.attachment?.name ?? ''}]`)
    else if (block.type === 'tool-call') parts.push(`[工具调用: ${block.name ?? ''}]`)
  }
  return parts.join('\n')
}

/**
 * 判断一条 user 消息是否 DSH 的系统注入（不是用户真实发言）。
 *
 * DSH 会把若干内部消息也记成 user 角色，已知两类：
 * ① `<system-reminder>` 包裹的指令/文件更新提醒；
 * ② 子代理通知（"Agent <id> sent a message: …"、"Background subagent <id> finished …"）。
 * 不滤掉它们，摘要的「首条用户消息」和正文都会被系统噪声污染。
 */
function isSystemInjection(text) {
  if (text.startsWith('<system-reminder>')) return true
  const head = text.slice(0, 200)
  if (/^(Agent|Background subagent)\s+\S/.test(head)) {
    return /(sent a message:|finished|will do no further work)/.test(text.slice(0, 800))
  }
  return false
}

/** 把一个会话事件转成一行 JSONL 记录；不关心的类型返回 null。 */
function lineOf(event) {
  const data = event.data
  if (!isObj(data)) return null
  const time = typeof event.time === 'number' ? event.time : Date.now()
  const turn = Number.isSafeInteger(data.turn) ? data.turn : 0
  const caps = config.capture
  const stamp = (kind, text) => {
    if (typeof text !== 'string' || text.length === 0) return null
    return `${JSON.stringify({ t: time, k: kind, x: truncate(text, caps.maxLineChars) })}\n`
  }
  switch (event.type) {
    case 'turn/start':
      return turn > 0 ? `${JSON.stringify({ t: time, k: 'mark', x: `—— 回合 ${turn} ——` })}\n` : null
    case 'turn/end':
      return null
    case 'user/message': {
      const text = textOf(data.content)
      if (!text || isSystemInjection(text)) return null
      return stamp('user', text)
    }
    case 'assistant/message': {
      const text = textOf(data.message?.content)
      if (!text) return null
      const usage = isObj(data.usage)
        ? `[用量 in=${data.usage.inputTokens ?? '?'} out=${data.usage.outputTokens ?? '?'}] `
        : ''
      return stamp('assistant', usage + text)
    }
    case 'tool/call': {
      const args =
        typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {})
      return stamp('tool', `[工具调用] ${data.name ?? '?'}(${truncate(args, 400)})`)
    }
    case 'tool/result': {
      const text = textOf(data.message?.content)
      const body = text ? truncate(text, caps.toolResultChars) : ''
      const err =
        isObj(data.error) && data.error.code ? ` [出错: ${String(data.error.code)}]` : ''
      if (!body && !err) return null
      return stamp('tool', `[工具结果${err}] ${body}`)
    }
    default:
      return null
  }
}

/** 顶层会话判定：没有父会话、没有委派深度。 */
function isTopLevelSession(session) {
  const header = session?.header
  if (!isObj(header)) return false
  return header.parentSession === undefined && header.delegationDepth === undefined
}

function captureEvent(session, event) {
  if (!config.capture.enabled) return
  if (config.capture.topLevelOnly && !isTopLevelSession(session)) return
  const line = lineOf(event)
  if (line === null) return
  const sid = String(session.id)
  if (!isObj(state.journals[sid])) state.journals[sid] = { first: '', cwd: '' }
  const journal = state.journals[sid]
  if (event.type === 'user/message' && !journal.first) {
    const text = textOf(event.data?.content)
    if (text) journal.first = truncate(text.replace(/\s+/g, ' '), 120)
    stateDirty = true
  }
  if (session.header?.cwd && journal.cwd !== session.header.cwd) {
    journal.cwd = session.header.cwd
    stateDirty = true
  }
  let buf = buffers.get(sid)
  if (buf === undefined) {
    buf = []
    buffers.set(sid, buf)
  }
  buf.push(line)
}

//#endregion

//#region 落盘

/** 单个会话的流水修剪：超过上限时只保留后半段。 */
function trimJournal(file) {
  try {
    const stat = statSync(file)
    if (stat.size <= config.capture.journalCapBytes) return
    const text = readFileSync(file, 'utf8')
    const cap = Math.floor(config.capture.journalCapBytes * 0.6)
    const kept = text.slice(-cap)
    const start = kept.indexOf('\n')
    writeFileSync(file, start === -1 ? kept : kept.slice(start + 1))
  } catch (err) {
    logLine('warn', `trimJournal ${file}: ${err?.message ?? err}`)
  }
}

function flushSession(sid) {
  const buf = buffers.get(sid)
  if (buf === undefined || buf.length === 0) return
  buffers.delete(sid)
  const file = journalFileOf(sid)
  try {
    ensureDirs()
    appendFileSync(file, buf.join(''))
    trimJournal(file)
  } catch (err) {
    logLine('warn', `flush ${sid}: ${err?.message ?? err}`)
  }
}

function flushAll() {
  for (const sid of Array.from(buffers.keys())) flushSession(sid)
  if (stateDirty) saveState()
}

//#endregion

//#region 回忆：系统提示词注入

/** 按修改时间倒序取最近 N 条摘要正文。 */
function recentDigests(count) {
  try {
    ensureDirs()
    const rows = []
    for (const entry of readdirSync(DIGEST_DIR)) {
      if (!entry.endsWith('.md')) continue
      const file = join(DIGEST_DIR, entry)
      try {
        const stat = statSync(file)
        rows.push({ file, mtime: stat.mtimeMs })
      } catch {
        /* 忽略 */
      }
    }
    rows.sort((a, b) => b.mtime - a.mtime)
    const picked = rows.slice(0, Math.max(0, count))
    return picked.map(({ file }) => {
      try {
        return truncate(readFileSync(file, 'utf8').trim(), config.recall.maxDigestChars)
      } catch {
        return ''
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

/** 尚未生成摘要的流水总量（KB 取整），用于注入提示。 */
function pendingJournalKb() {
  try {
    ensureDirs()
    let bytes = 0
    for (const entry of readdirSync(JOURNAL_DIR)) {
      if (!entry.endsWith('.jsonl')) continue
      const sid = entry.slice(0, -'.jsonl'.length)
      if (state.digested[sid]) continue
      try {
        bytes += statSync(join(JOURNAL_DIR, entry)).size
      } catch {
        /* 忽略 */
      }
    }
    return Math.round(bytes / 1024)
  } catch {
    return 0
  }
}

let recallCache = { at: 0, text: '' }

function buildMemoryBlock() {
  if (!config.recall.enabled) return ''
  const now = Date.now()
  if (now - recallCache.at < RECALL_CACHE_MS) return recallCache.text
  try {
    const parts = []
    // ① 最高优先级：人格养成区（长期对话养成的人格预期/思维逻辑/行为习惯）
    if (existsSync(PERSONA_FILE)) {
      try {
        const persona = truncate(readFileSync(PERSONA_FILE, 'utf8').trim(), config.recall.maxPersonaChars)
        if (persona) parts.push(`《人格养成区（最优先）· persona.md》\n${persona}`)
      } catch {
        /* 忽略 */
      }
    }
    // ② 最近会话摘要（项目/事实类，次要）
    const digests = recentDigests(config.recall.recentDigests)
    if (digests.length > 0) {
      parts.push(`《最近会话摘要》\n${digests.join('\n\n')}`)
    }
    // ③ 长期记忆索引
    if (existsSync(INDEX_FILE)) {
      try {
        const idx = truncate(readFileSync(INDEX_FILE, 'utf8').trim(), config.recall.maxIndexChars)
        if (idx) parts.push(`《长期记忆索引》\n${idx}`)
      } catch {
        /* 忽略 */
      }
    }
    const pendingKb = pendingJournalKb()
    // v4 修复：摘要被关掉时不再宣称「会自动整理」（此前只判阈值，会误导）
    if (config.digest.enabled && pendingKb >= 32) {
      parts.push(`⚠️ 有约 ${pendingKb}KB 会话流水尚未整理成摘要，会话结束时会自动整理。`)
    }
    const footer =
      `【鲸鱼娘长期记忆区】存储目录: ${ROOT}。` +
      `persona.md 是主人养成的第一优先级记忆（人格预期/思维逻辑/行为习惯/纠正史），会话里必须遵守并在被纠正时当天追加；` +
      `项目事实在 memory/memory.md（grep 检索）；会话流水在 journal/（自动捕获），摘要自动进 digests/（自动注入最近${config.recall.recentDigests}条）。` +
      `用户说「记住/别忘了/以后都」→ 人格类写 persona.md、事实类写 memory.md，都按日期行，并同步 index.md；` +
      `会话结束前若 journal/ 有流水而 digests/ 缺对应摘要，用便宜子代理按 memory 技能整理补写。`
    let block = parts.length > 0 ? parts.join('\n\n') + '\n\n' + footer : footer
    if (block.length > config.recall.maxBlockChars) {
      block = `${block.slice(0, config.recall.maxBlockChars)}…(截断)`
    }
    recallCache = { at: now, text: block }
    return block
  } catch (err) {
    logLine('warn', `buildMemoryBlock: ${err?.message ?? err}`)
    return ''
  }
}

//#endregion

//#region 整理：摘要生成

function buildDigestPrompt(journal, title, cwd) {
  return [
    '你是「鲸鱼娘长期记忆区」的整理助手。下面是一个 DeepSeek Harness 会话的流水日志（JSONL，每行一个事件）：',
    'k=user 是用户消息，k=assistant 是助手回复，k=tool 是工具调用/结果（内容有截断），k=mark 是回合标记。',
    '请只依据日志写一份中文记忆摘要，直接输出摘要正文，不要标题、不要解释、不要客套。',
    '按重要性排序，重点放在人格养成上：',
    '1) 人格与习惯（最重要）：用户对助手人格/语气/称谓的期望、表扬或纠正；助手被要求养成或改变的思维逻辑、行为习惯、相处方式',
    '2) 关键结论与决策、用户偏好',
    '3) 产出：新建/修改的文件、配置、脚本（尽量列出路径）',
    '4) 未完成事项与待办',
    '5) 值得长期记住的事实（若有）',
    '控制在 400 字以内；日志里没有的不要编造。',
    `会话首条用户消息：${title || '（无）'}`,
    `工作区：${cwd || '（未知）'}`,
    '=== 流水日志开始 ===',
    journal,
    '=== 流水日志结束 ===',
  ].join('\n')
}

/** 调便宜模型做摘要；失败抛错由调用方记录。 */
async function callDigestLlm(prompt) {
  if (hostCtx?.llm?.stream === undefined) {
    throw new Error('llm 服务不可用（hostCtx 未初始化或未注入 llm）')
  }
  const chunks = hostCtx.llm.stream({
    provider: config.digest.provider,
    model: config.digest.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: config.digest.maxTokens,
    purpose: 'compaction',
    signal: AbortSignal.timeout(DIGEST_LLM_TIMEOUT_MS),
  })
  let out = ''
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') out += chunk.text
    else if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        throw new Error(`llm finish ${kind}: ${chunk.reason?.failure?.message ?? ''}`)
      }
    }
  }
  return out.trim()
}

function firstOfFile(file) {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 64 * 1024)
    for (const line of head.split('\n')) {
      if (!line) continue
      try {
        const rec = JSON.parse(line)
        if (rec.k === 'user' && typeof rec.x === 'string' && rec.x) return truncate(rec.x.replace(/\s+/g, ' '), 120)
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    /* 忽略 */
  }
  return ''
}

/** 清理：流水与摘要各保留最近 N 份。 */
function prune() {
  try {
    const pruneDir = (dir, keep, suffix) => {
      const rows = []
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(suffix)) continue
        try {
          rows.push({ file: join(dir, entry), mtime: statSync(join(dir, entry)).mtimeMs })
        } catch {
          /* 忽略 */
        }
      }
      rows.sort((a, b) => b.mtime - a.mtime)
      for (const row of rows.slice(keep)) {
        try {
          unlinkSync(row.file)
        } catch {
          /* 忽略 */
        }
      }
    }
    pruneDir(JOURNAL_DIR, Math.max(5, config.digest.keepJournals), '.jsonl')
    pruneDir(DIGEST_DIR, Math.max(5, config.digest.keepDigests), '.md')
  } catch {
    /* 忽略 */
  }
}

/** 为一个已结束的会话生成摘要（失败只记日志，流水保留待手动整理）。 */
async function runDigest(sid) {
  const file = journalFileOf(sid)
  try {
    if (!existsSync(file)) return
    const size = statSync(file).size
    if (size < config.digest.minJournalBytes) return
    // 幂等保护：摘要文件不比流水旧就跳过，避免 state 丢失后重复调用付费模型
    const existing = digestFileOf(sid)
    if (existsSync(existing)) {
      try {
        const doneAt = statSync(existing).mtimeMs
        if (doneAt >= statSync(file).mtimeMs) {
          state.digested[sid] = doneAt
          stateDirty = true
          saveState()
          logLine('digest', `会话 ${sid} 摘要已是最新，跳过`)
          return
        }
      } catch {
        /* 忽略：继续走正常整理 */
      }
    }
    const journal = readFileSync(file, 'utf8').slice(-config.digest.journalSliceBytes)
    const info = state.journals[sid] || {}
    const title = info.first || firstOfFile(file)
    const prompt = buildDigestPrompt(journal, title, info.cwd)
    logLine('digest', `开始整理会话 ${sid}（流水 ${size} 字节 → ${config.digest.provider}/${config.digest.model}）`)
    const summary = await callDigestLlm(prompt)
    if (!summary) {
      logLine('digest', `会话 ${sid} 摘要为空，跳过`)
      return
    }
    const now = new Date()
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const head = [
      `# 会话记忆摘要 · ${date}`,
      '',
      `- 会话: \`${sid}\``,
      `- 工作区: \`${info.cwd || '（未知）'}\``,
      `- 首条消息: ${title || '（无）'}`,
      '',
      '',
    ].join('\n')
    ensureDirs()
    writeFileSync(digestFileOf(sid), head + summary + '\n')
    state.digested[sid] = Date.now()
    stateDirty = true
    saveState()
    prune()
    logLine('digest', `会话 ${sid} 摘要已写入 digests/（${summary.length} 字）`)
  } catch (err) {
    logLine('digest', `会话 ${sid} 整理失败: ${err?.message ?? err}（流水已保留，可用 memory 技能手动整理）`)
  } finally {
    digesting.delete(sid)
  }
}

/** 会话结束时的入口：符合条件才入队整理。 */
function maybeDigest(session) {
  if (!config.digest.enabled) return
  if (config.capture.topLevelOnly && !isTopLevelSession(session)) return
  const sid = String(session.id)
  if (state.digested[sid] || digesting.has(sid)) return
  try {
    const file = journalFileOf(sid)
    if (!existsSync(file)) return
    if (statSync(file).size < config.digest.minJournalBytes) return
  } catch {
    return
  }
  digesting.add(sid)
  runDigest(sid).catch((err) => {
    logLine('digest', `会话 ${sid} 整理异常: ${err?.message ?? err}`)
    digesting.delete(sid)
  })
}

/** 启动兜底：为上次退出前来不及整理的流水补摘要。 */
function startupSweep(onDispose) {
  const handle = setTimeout(async () => {
    try {
      ensureDirs()
      const files = []
      for (const entry of readdirSync(JOURNAL_DIR)) {
        if (!entry.endsWith('.jsonl')) continue
        const sid = entry.slice(0, -'.jsonl'.length)
        if (state.digested[sid]) continue
        const file = join(JOURNAL_DIR, entry)
        try {
          if (statSync(file).size >= config.digest.minJournalBytes) files.push(sid)
        } catch {
          /* 忽略 */
        }
      }
      files.sort()
      for (const sid of files) {
        if (digesting.has(sid) || state.digested[sid]) continue
        digesting.add(sid)
        await runDigest(sid) // 串行，避免并发烧钱
      }
    } catch (err) {
      logLine('digest', `启动兜底扫描异常: ${err?.message ?? err}`)
    }
  }, STARTUP_SWEEP_DELAY_MS)
  onDispose(() => clearTimeout(handle))
}

//#endregion

//#region 插件装配

/**
 * 每个会话首次注入时留一条日志（v4 起按会话记，不再每进程只记一次）：
 * 这样 plugin-log.txt 能证明「某个新会话确实注入过记忆区块」，而不只是「本进程注入过至少一次」。
 */
const assemblyLoggedScopes = new WeakSet()
const assemblyScopeLabels = new WeakMap()
let assemblyScopeSeq = 0

export function apply(ctx) {
  hostCtx = ctx
  ensureDirs()
  config = loadConfig()
  state = loadJson(STATE_FILE, { version: STATE_VERSION, journals: {}, digested: {} })
  if (!isObj(state.journals)) state.journals = {}
  if (!isObj(state.digested)) state.digested = {}

  // ① 捕获：fire-and-forget 追加流，绝不抛错影响会话提交
  ctx.on('session/event', (session, event) => {
    try {
      captureEvent(session, event)
    } catch (err) {
      logLine('warn', `session/event: ${err?.message ?? err}`)
    }
  })

  // ② 耐久性检查点：同步清空对应会话缓冲
  ctx.on('session/flush', (session) => {
    try {
      flushSession(String(session.id))
    } catch (err) {
      logLine('warn', `session/flush: ${err?.message ?? err}`)
    }
  })

  // ③ 定时批量落盘（全局定时器；dispose 时清理）
  const intervalMs = Math.max(500, Number(config.capture.flushIntervalMs) || 2000)
  const interval = setInterval(() => {
    try {
      flushAll()
    } catch (err) {
      logLine('warn', `flush interval: ${err?.message ?? err}`)
    }
  }, intervalMs)

  // ④ 卸载（含 HMR 模块替换）前清理定时器并把缓冲写盘
  ctx.on('dispose', () => {
    try {
      clearInterval(interval)
      flushAll()
    } catch {
      /* 忽略 */
    }
  })

  // ⑤ 回忆：系统提示词瀑布末尾追加记忆区块
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = await next()
    const block = buildMemoryBlock()
    if (block) {
      out.sections.push({ name: 'whale-memory', text: block, interpolate: false })
      // v6：AssembleContext 的官方契约只有 { scope?, signal? }（没有 id）→ 改按 scope 对象去重；
      const scope = (context && typeof context.scope === 'object' && context.scope) ? context.scope : undefined
      const sid = scope && typeof scope.id === 'string' ? scope.id : ''
      if (!scope || !assemblyLoggedScopes.has(scope)) {
        if (scope) {
          assemblyLoggedScopes.add(scope)
          if (!assemblyScopeLabels.has(scope)) assemblyScopeLabels.set(scope, '#' + (++assemblyScopeSeq))
        }
        logLine('recall', `[v6] 已向系统提示词注入记忆区块（${block.length} 字，${sid ? `会话 ${sid}` : scope ? `scope ${assemblyScopeLabels.get(scope)}` : '未知作用域'}${scope ? `；scope keys=[${Object.keys(scope).slice(0, 6).join(',')}]` : ''}）`)
      }
    }
    return out
  })

  // ⑥ 整理：会话离开注册表时入队摘要
  ctx.on('session/disposed', (session) => {
    try {
      flushSession(String(session.id))
      maybeDigest(session)
    } catch (err) {
      logLine('warn', `session/disposed: ${err?.message ?? err}`)
    }
  })

  // ⑦ 启动兜底扫描
  startupSweep((dispose) => ctx.on('dispose', dispose))

  logLine('boot', `长期记忆区已装配：${ROOT}`)
}

//#endregion

/** 离线自测入口（node 直接 import 本模块时可检查导出形态）。 */
export const __test__ = {
  lineOf,
  textOf,
  truncate,
  safeId,
  buildDigestPrompt,
  callDigestLlm,
  runDigest,
  isSystemInjection,
  loadJson,
}
