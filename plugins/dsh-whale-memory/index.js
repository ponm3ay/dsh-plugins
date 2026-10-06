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
 *    总长默认 ≤ 8KB（footer 永远保留，超预算按优先级收缩）。
 *
 * 3. 整理（session/disposed + 启动兜底扫描）：
 *    顶层会话离开注册表、且其流水 ≥ 阈值（默认 8KB）时，调用配置的便宜模型
 *    （默认 xiaomi/mimo-v2.6-flash，走 DSH 凭证库）把流水压缩成 ≤400 字中文摘要，
 *    写入 `digests\<sessionId>.md`。失败只记日志、不抛出，可交给 memory 技能手动兜底。
 *
 * v9（2026-10-06 晚，同日）：日志与调用同源——`resolveDigestRoute()` 一次解析
 *   生效路由（面板槽 > plugin.json），「开始整理」行与 `[v8] 覆盖生效` 行不再错位
 *   （v8 实测时首行仍印旧默认，容易误判）。
 *
 * v8（2026-10-06 晚，配合设置页「辅助模型」面板 dsh-aux-models）：
 *   压缩槽真接线——`callDigestLlm` 前现读 `orchestra/aux-models.json` 的
 *   compression 槽，custom 时覆盖 provider/model/超时（面板保存后下一次摘要
 *   即生效，无需重载）；auto/缺档/坏档一律回落 plugin.json 默认。
 *
 * v7（2026-10-06，借鉴 Hermes `tools/memory_tool.py` + `threat_patterns.py` 的实证设计）：
 *   ① 注入前威胁快照扫描：经典注入句式命中 → **该节**替换为 `[BLOCKED:…]` 占位；
 *      不可见 Unicode 字符从注入快照剥离。两者都只影响注入，**原文件一律不动**
 *      （照 Hermes 的 frozen-snapshot 原则：live 文件保留原文，用户能看到并处理）。
 *   ② 每会话冻结快照：同一会话内记忆区块字节稳定 → 保住前缀缓存（Hermes 的
 *      frozen snapshot 模式）；新摘要 / persona 编辑下个会话才进入区块
 *      （编辑内容本身已在当轮上下文里，不会丢）。
 *   ③ 分节用量指示：每节标注 `字数/上限`，预算去向一眼可见（Hermes 的
 *      `[% — current/limit chars]` 惯例）。
 *
 * 入口命名：发布版入口是 `index.js`（本文件内容与其一致）；开发期用带版本号的文件名
 *   （`index.v9.js`）是为了绕开「模块缓存按 URL 记」——改代码免重启生效须同时换文件名与
 *   patch 行 id。两条纪律的来龙去脉见 README「热重载与入口命名」。
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

//#region 注入防护（v7，借鉴 Hermes threat_patterns.py 的 context scope 子集）

/**
 * 不可见 Unicode（Hermes INVISIBLE_CHARS 同款集合）：零宽/方向覆盖这类字符
 * 能把攻击文本藏进注入快照，对人类读者完全隐形。单趟集合求交即可检出。
 */
const INVISIBLE_CHARS = new Set([
  '\u200B', '\u200C', '\u200D', '\u2060', '\u2062', '\u2063', '\u2064', '\uFEFF', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069'
])

/**
 * 威胁模式（JS 子集，scope=context 口径）：锚在攻击行为词汇上，不锚在
 * 「you must」这类 bossy 英文上（合法指令文件天天出现，锚了必误伤）。
 * 有界填充 `(?:\w+\s+){0,N}` 防对手塞词绕过，同时避免正则回溯炸弹。
 */
const FILLER = '(?:\\w+\\s+){0,8}'
const THREAT_PATTERNS = [
  [new RegExp(`ignore\\s+${FILLER}(previous|all|above|prior)\\s+${FILLER}instructions`, 'i'), 'prompt_injection'],
  [new RegExp(`disregard\\s+${FILLER}(your|all|any)\\s+${FILLER}(instructions|rules|guidelines)`, 'i'), 'disregard_rules'],
  [/system\s+prompt\s+override/i, 'sys_prompt_override'],
  [new RegExp(`(?:output|reveal|print)\\s+${FILLER}(system|initial)\\s+prompt`, 'i'), 'leak_system_prompt'],
  [/<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/i, 'html_comment_injection'],
  [new RegExp(`do\\s+not\\s+${FILLER}tell\\s+${FILLER}the\\s+user`, 'i'), 'deception_hide'],
  [new RegExp(`you\\s+are\\s+${FILLER}now\\s+(?:a|an|the)\\s+`, 'i'), 'role_hijack'],
  [new RegExp(`(?:you|you're)\\s+${FILLER}(?:have\\s+no|don't\\s+have)\\s+${FILLER}(restrictions|rules|limits)`, 'i'), 'bypass_restrictions'],
  // 外泄：curl/wget 带密钥变量名（KEY/TOKEN/SECRET 结尾才命中，避免误伤普通 env）
  [/curl\s+[^\n]{0,512}\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD)S?\b/i, 'exfil_curl'],
  [/wget\s+[^\n]{0,512}\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD)S?\b/i, 'exfil_wget'],
  // C2 框架品牌词（几乎零误伤；不做通用英文词）
  [/\b(?:cobalt\s*strike|sliver|havoc|metasploit|brainworm)\b/i, 'known_c2_framework'],
  [/\bc2\s+(?:server|channel|beacon)\b/i, 'c2_explicit'],
  // 会话上下文外泄
  [new RegExp(`(?:include|output|print)\\s+${FILLER}(conversation\\s+history|full\\s+context|entire\\s+context)`, 'i'), 'context_exfil'],
  // 硬编码密钥形状
  [/(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}/, 'hardcoded_secret'],
  // ── 中文注入句式（我们的记忆与摘要都是中文，Hermes 原版纯英文扫不到）──
  // 锚在「忽略/无视 + 指令/规则/设定」的攻击搭配上，不锚普通「忽略」（日志里天天出现）。
  // 中间词用有界重复 {0,4}（Hermes 的 _FILLER 思路）：塞几个词绕不过，也不会回溯爆炸。
  [/(?:忽略|无视|不(?:要)?理会|跳过)(?:(?:以上|之前|前面|先前|所有|全部|的|条|这些|那些|一切){0,4})(?:指令|规则|提示|设定|要求|限制)/, 'zh_prompt_injection'],
  [/(?:忘记|忘掉|抛弃|放弃)(?:你|您)(?:之前|以上|所有)?(?:的)?(?:设定|指令|规则|身份|人格)/, 'zh_role_reset'],
  [/(?:系统提示词|系统指令|初始提示词|system\s*prompt)(?:内容)?(?:全部|原样|一字不差)?(?:输出|打印|泄露|暴露|给我|发给我)/i, 'zh_leak_prompt'],
  [/不准?(?:告诉|提及|汇报|透露)(?:给)?(?:用户|主人|人类)/, 'zh_deception_hide'],
  [/(?:你现在|从此刻起|从现在起)(?:是|变成|作为)(?:一个|一名)?(?:没有|不受).{0,12}(?:限制|约束|规则)/, 'zh_bypass'],
  // 记忆库里最不该出现的东西：把密钥写下来的形状（strict 口径同 Hermes）
  [/(?:api[_-]?key|apikey|token|secret|password|密钥|密码)\s*[=:：]\s*["']?[A-Za-z0-9+/=_-]{24,}/i, 'zh_hardcoded_secret'],
]

/** 扫描上限（与 Hermes MAX_SCAN_CHARS 同理：扫描是哨兵不是存档）。 */
const THREAT_SCAN_CHARS = 64 * 1024

/**
 * 返回两类发现：`invisible`（不可见字符，剥离即可）与模式 id（整节拉黑）。
 * 分开是为了执行不同的处置——Hermes 同样区分（invisible 单独报 codepoint）。
 * 只用于**注入快照**，不写文件、不改原文——处置权在用户。
 */
function scanThreats(text) {
  if (!text) return { invisible: [], patterns: [] }
  const sample = text.length > THREAT_SCAN_CHARS ? text.slice(0, THREAT_SCAN_CHARS) : text
  const invisible = []
  for (const ch of new Set(sample)) {
    if (INVISIBLE_CHARS.has(ch)) invisible.push(`U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
  }
  const patterns = []
  for (const [re, id] of THREAT_PATTERNS) {
    if (re.test(sample)) patterns.push(id)
  }
  return { invisible, patterns }
}

/** 剥离不可见字符（单遍拼接，不动其余内容）。 */
function stripInvisible(text) {
  let out = ''
  for (const ch of text) out += INVISIBLE_CHARS.has(ch) ? '' : ch
  return out
}

/**
 * 快照节清洗：
 * - 模式命中 → 整节替换为占位（Hermes 的 [BLOCKED: …] 惯例，原文件保留原文，
 *   用户能看到、能删——静默丢弃会让攻击隐形）；
 * - 只有不可见字符 → 剥离后正常注入（那是隐写载体，剥掉内容本身仍可读）。
 * 返回 { text, hits }。
 */
function sanitizeSection(text, label) {
  if (!text) return { text: '', hits: [] }
  const { invisible, patterns } = scanThreats(text)
  if (patterns.length > 0) {
    logLine('warn', `注入防护：「${label}」命中 [${patterns.join(', ')}]${invisible.length ? ` + 隐形字符 ${invisible.join(',')}` : ''}，本节以占位注入（原文件未动）`)
    return { text: `[BLOCKED: ${label} 检出注入特征 ${patterns.join(', ')}；原文在磁盘上，请人工检查后删除或改写]`, hits: patterns }
  }
  if (invisible.length > 0) {
    logLine('warn', `注入防护：「${label}」含隐形字符 ${invisible.join(',')}，注入快照已剥离（原文件未动）`)
    return { text: stripInvisible(text), hits: [] }
  }
  return { text, hits: [] }
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

/**
 * v7 每会话冻结快照（借鉴 Hermes memory_tool 的 frozen snapshot）：
 * 同一会话内记忆区块**字节稳定** → 前缀缓存不被打碎；persona 编辑、
 * 新摘要都在**下个会话**才进区块（编辑内容本身已在当轮上下文，不丢）。
 * key=会话 id；无 id 的作用域退回 15 秒全局缓存（旧行为）。
 */
const sessionSnapshots = new Map()
const SESSION_SNAPSHOT_MAX = 200

/** 分节用量指示（Hermes `[% — current/limit chars]` 惯例）：标题里带 `字数/上限`。 */
function usageTag(len, limit) {
  const pct = limit > 0 ? Math.min(100, Math.round((len / limit) * 100)) : 0
  return `〔${len.toLocaleString('en-US')}/${limit.toLocaleString('en-US')} 字 · ${pct}%〕`
}

function buildMemoryBlock(sid) {
  if (!config.recall.enabled) return ''
  // 已有该会话的冻结快照 → 原样返回（字节稳定）
  if (sid && sessionSnapshots.has(sid)) return sessionSnapshots.get(sid)
  const now = Date.now()
  if (!sid && now - recallCache.at < RECALL_CACHE_MS) return recallCache.text
  try {
    const parts = []
    // ① 最高优先级：人格养成区（长期对话养成的人格预期/思维逻辑/行为习惯）
    if (existsSync(PERSONA_FILE)) {
      try {
        const raw = readFileSync(PERSONA_FILE, 'utf8').replace(/^\uFEFF/, '').trim()
        const persona = truncate(raw, config.recall.maxPersonaChars)
        if (persona) {
          // v7：注入前威胁快照扫描——命中则该节以占位注入，原文件不动
          const clean = sanitizeSection(persona, 'persona.md')
          const shown = clean.text
          parts.push({ prio: 1, text: `《人格养成区（最优先）· persona.md》${usageTag(shown.length, config.recall.maxPersonaChars)}\n${shown}` })
        }
      } catch {
        /* 忽略 */
      }
    }
    // ② 最近会话摘要（项目/事实类，次要）
    const digests = recentDigests(config.recall.recentDigests)
    if (digests.length > 0) {
      const merged = digests.join('\n\n')
      const clean = sanitizeSection(merged, '会话摘要 digests/')
      parts.push({ prio: 2, text: `《最近会话摘要》${usageTag(clean.text.length, config.recall.maxDigestChars * config.recall.recentDigests)}\n${clean.text}` })
    }
    // ③ 长期记忆索引
    if (existsSync(INDEX_FILE)) {
      try {
        const raw = readFileSync(INDEX_FILE, 'utf8').replace(/^\uFEFF/, '').trim()
        const idx = truncate(raw, config.recall.maxIndexChars)
        if (idx) {
          const clean = sanitizeSection(idx, 'index.md')
          parts.push({ prio: 3, text: `《长期记忆索引》${usageTag(clean.text.length, config.recall.maxIndexChars)}\n${clean.text}` })
        }
      } catch {
        /* 忽略 */
      }
    }
    const pendingKb = pendingJournalKb()
    // v4 修复：摘要被关掉时不再宣称「会自动整理」（此前只判阈值，会误导）
    if (config.digest.enabled && pendingKb >= 32) {
      parts.push({ prio: 4, text: `⚠️ 有约 ${pendingKb}KB 会话流水尚未整理成摘要，会话结束时会自动整理。` })
    }
    const footer =
      `【鲸鱼娘长期记忆区】存储目录: ${ROOT}。` +
      `persona.md 是主人养成的第一优先级记忆（人格预期/思维逻辑/行为习惯/纠正史），会话里必须遵守并在被纠正时当天追加；` +
      `项目事实在 memory/memory.md（grep 检索）；会话流水在 journal/（自动捕获），摘要自动进 digests/（自动注入最近${config.recall.recentDigests}条）。` +
      `用户说「记住/别忘了/以后都」→ 人格类写 persona.md、事实类写 memory.md，都按日期行，并同步 index.md；` +
      `会话结束前若 journal/ 有流水而 digests/ 缺对应摘要，用便宜子代理按 memory 技能整理补写。`
    // v7 预算装配（修 v6 老毛病：整块硬截把 footer 指引天天切掉）——
    // footer 永远保留；正文按优先级填充（1=persona 最高，2=摘要，3=索引），
    // 超预算时从**低优先级尾部**收缩，砍到哪节就在哪节标「预算截断」。
    const cap = Math.max(200, config.recall.maxBlockChars)
    const sep = '\n\n'
    let remaining = cap - footer.length
    if (remaining < 0) {
      // 预算被 footer 单独打爆（配置被改小）：footer 自身截断，正文让路
      return `${footer.slice(0, Math.max(50, cap - 10))}…(预算截断)`
    }
    parts.sort((x, y) => x.prio - y.prio)
    const kept = []
    for (const part of parts) {
      const room = remaining - sep.length * (kept.length > 0 ? 1 : 0)
      if (room <= 20) continue
      if (part.text.length <= room) {
        kept.push(part.text)
        remaining -= part.text.length + (kept.length > 1 ? sep.length : 0)
      } else {
        // 该节放不下：截到刚好放下（若首节能容下一部分才截，否则整节让路）
        const need = 12
        if (room > need + 40) {
          kept.push(`${part.text.slice(0, room - need)}…(预算截断)`)
          remaining = 0
        }
      }
    }
    let block = kept.length > 0 ? kept.join(sep) + sep + footer : footer
    // 兜底（理论上到不了）：仍超限则保 footer 截正文
    if (block.length > cap) {
      const tail = sep + footer
      block = block.slice(0, cap - tail.length) + tail
    }
    // 落快照：会话级冻结（有 sid）/ 15 秒全局缓存（无 sid）
    if (sid) {
      sessionSnapshots.set(sid, block)
      if (sessionSnapshots.size > SESSION_SNAPSHOT_MAX) {
        const oldest = sessionSnapshots.keys().next().value
        if (oldest !== undefined) sessionSnapshots.delete(oldest)
      }
    } else {
      recallCache = { at: now, text: block }
    }
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

/**
 * 读辅助模型面板的「上下文压缩」槽（`orchestra/aux-models.json`，
 * 由设置页「辅助模型」dsh-aux-models 写入）。custom → 覆盖 provider/model/超时；
 * auto 或文件缺失 → 返回 null 维持 plugin.json 默认。
 * 每次摘要现读（文件 <2KB、摘要低频），面板保存后下一次摘要即生效，无需重载。
 * 任何异常都返回 null——面板档坏了绝不让摘要罢工。
 */
function loadCompressionOverride() {
  try {
    const file = join(HOME, 'orchestra', 'aux-models.json')
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
    const slot = raw && raw.tasks ? raw.tasks.compression : null
    if (!slot || slot.mode !== 'custom') return null
    const provider = String(slot.provider || '').trim()
    const model = String(slot.model || '').trim()
    if (!provider || !model) return null
    const timeoutSec = Number(slot.timeout)
    return {
      provider,
      model,
      timeoutMs: Number.isFinite(timeoutSec) && timeoutSec > 0
        ? Math.min(600, timeoutSec) * 1000
        : DIGEST_LLM_TIMEOUT_MS,
    }
  } catch {
    return null
  }
}

/** 解析摘要实际路由（v9：日志与调用同源，别再出现「日志印旧默认、实际走面板」的错位）。 */
function resolveDigestRoute() {
  const override = loadCompressionOverride()
  return {
    provider: override ? override.provider : config.digest.provider,
    model: override ? override.model : config.digest.model,
    timeoutMs: override ? override.timeoutMs : DIGEST_LLM_TIMEOUT_MS,
    source: override ? 'panel' : 'config',
  }
}

/** 调便宜模型做摘要；失败抛错由调用方记录。v8：压缩槽面板覆盖优先。 */
async function callDigestLlm(prompt) {
  if (hostCtx?.llm?.stream === undefined) {
    throw new Error('llm 服务不可用（hostCtx 未初始化或未注入 llm）')
  }
  const route = resolveDigestRoute()
  if (route.source === 'panel') {
    logLine('digest', `[v8] 压缩槽面板覆盖生效：${route.provider}/${route.model}（超时 ${Math.round(route.timeoutMs / 1000)}s）`)
  }
  const chunks = hostCtx.llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: config.digest.maxTokens,
    purpose: 'compaction',
    signal: AbortSignal.timeout(route.timeoutMs),
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
    const route = resolveDigestRoute()
    logLine('digest', `开始整理会话 ${sid}（流水 ${size} 字节 → ${route.provider}/${route.model}${route.source === 'panel' ? ' · 面板槽' : ''}）`)
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
    // v7：先解析 scope/会话 id → 冻结快照按会话缓存（同一会话字节稳定）
    const scope = (context && typeof context.scope === 'object' && context.scope) ? context.scope : undefined
    const sid = scope && typeof scope.id === 'string' ? scope.id : ''
    const block = buildMemoryBlock(sid)
    if (block) {
      out.sections.push({ name: 'whale-memory', text: block, interpolate: false })
      if (!scope || !assemblyLoggedScopes.has(scope)) {
        if (scope) {
          assemblyLoggedScopes.add(scope)
          if (!assemblyScopeLabels.has(scope)) assemblyScopeLabels.set(scope, '#' + (++assemblyScopeSeq))
        }
        logLine('recall', `[v7] 已向系统提示词注入记忆区块（${block.length} 字，${sid ? `会话 ${sid} · 冻结快照` : scope ? `scope ${assemblyScopeLabels.get(scope)} · 15s 缓存` : '未知作用域'}${scope ? `；scope keys=[${Object.keys(scope).slice(0, 6).join(',')}]` : ''}）`)
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
  // v7：注入防护与快照
  scanThreats,
  sanitizeSection,
  usageTag,
  buildMemoryBlock,
  // v8/v9：辅助模型面板压缩槽覆盖
  loadCompressionOverride,
  resolveDigestRoute,
}
