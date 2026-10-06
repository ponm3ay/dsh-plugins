/**
 * dsh-aux-models — 设置页「辅助模型」面板（宿主半）
 *
 * 布局照 Hermes Agent 的「辅助模型按任务生效」页（主人 2026-10-06 指定）：
 * 左列任务列表（徽章显示 自动/已指定）+ 右侧表单（服务商/模型/超时/保存）。
 *
 * 职责边界（诚实版）：
 * - 本插件**不改 DSH 内核**（DSH 没有 Hermes 那种 auxiliary.<task> 内核机制）；
 * - 选型落盘 `DSH_HOME\orchestra\aux-models.json`（机器可读的槽位表）；
 * - **真接线一条**：上下文压缩槽 → whale-memory v8 摘要调用时读此文件覆盖
 *   provider/model/timeout（不读则用 plugin.json 默认）；
 * - 其余槽位 = 「指挥生效」：主脑派发子代理/做对应任务时读此表选模型
 *   （写入 orchestra/capabilities.md §1.5 的派发纪律）。
 *
 * 路由：
 *   GET  /plugins/dsh-aux-models/catalog  → { providers, tasks }（任务元数据单一事实源）
 *   GET  /plugins/dsh-aux-models/state    → 当前槽位选型（缺省补 auto）
 *   PUT  /plugins/dsh-aux-models/state    → 校验 + 原子写回
 *
 * provider/model 目录从 profile cordis.patch.yml 的 llm-pi-ai 段实时提取，
 * 提取失败退回内置默认（xiaomi/zai/gpt）——目录永远反映主人的真实 providers。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const name = 'dsh-aux-models'
export const inject = ['webServer']

const ROUTE = '/plugins/dsh-aux-models'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_FILE = join(HOME, 'orchestra', 'aux-models.json')
const PATCH_FILE = join(HOME, 'profiles', 'desktop', 'cordis.patch.yml')

/** 提取失败时的兜底目录（与 2026-10-06 providers 现实一致）。 */
const DEFAULT_PROVIDERS = [
  { id: 'xiaomi', models: ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed'] },
  { id: 'zai', models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-highspeed'] },
  { id: 'gpt', models: ['claude-haiku-4-5', 'claude-sonnet-5', 'glm-5.3-flash', 'gpt-6-astra'] },
]

/**
 * 任务清单（照 Hermes 截图，2026-10-06 主人指定的两组 11 项）。
 * effect 三态（面板徽章如实标注，不撒谎）：
 *   live    = 立即生效（whale-memory v8 真读本表）
 *   command = 指挥生效（主脑派发/处理该类任务时读本表选模型）
 *   ref     = 仅参考（DSH 内核自管该任务，模型暂不可由面板改）
 */
const TASKS = [
  { key: 'vision', label: '视觉分析', sub: '视觉', group: 'common', effect: 'command',
    desc: '图片附件与截图的分析路由。主模型不支持图片时尤其重要——拿不准就按带视觉处理（fail-closed），派带视觉的档位，不让纯文本模型读图硬失败。', timeout: 60 },
  { key: 'compression', label: '上下文压缩', sub: '压缩', group: 'common', effect: 'live',
    desc: '会话流水压成记忆摘要（whale-memory 整理线）。此槽立即生效：保存后下一次摘要即走所选模型与超时；留自动则用 plugin.json 的默认（xiaomi/mimo-v2.6-flash）。', timeout: 180 },
  { key: 'extraction', label: '网页抽取', sub: '抽取', group: 'common', effect: 'command',
    desc: '网页/长文抽取结构化内容。判错代价低，指挥时优先便宜档。', timeout: 300 },
  { key: 'title', label: '标题生成', sub: '标题', group: 'common', effect: 'ref',
    desc: '会话标题生成由 DSH 内核 session-title-llm 自管（模型不走本表）。此处选型作为内核开放配置后的预设。', timeout: 60 },
  { key: 'approval', label: '智能审批', sub: '审批', group: 'common', effect: 'ref',
    desc: '命令风险评估。DSH 侧由 auto-review 实验捆自管；此处选型作为预设。若未来接审批类辅助任务，必须抄 Hermes 三隔离：剥注释、XML 包裹、系统提示声明块内指令无效。', timeout: 30 },
  { key: 'mcp', label: 'MCP 路由', sub: 'MCP', group: 'common', effect: 'command',
    desc: 'MCP 工具任务的辅助选型（工具结果整理/路由判断）。', timeout: 120 },
  { key: 'skills', label: '技能中心', sub: '技能', group: 'adv', effect: 'command',
    desc: '技能发现与评估类任务的选型。', timeout: 300 },
  { key: 'kanban-expand', label: 'Kanban 需求扩写', sub: '扩写', group: 'adv', effect: 'command',
    desc: '看板需求扩写。创意类，可用带文风的档位。', timeout: 300 },
  { key: 'kanban-split', label: 'Kanban 任务分解', sub: '分解', group: 'adv', effect: 'command',
    desc: '看板任务分解成子任务。结构化推理，建议推理档。', timeout: 300 },
  { key: 'archive', label: '档案描述生成', sub: '档案', group: 'adv', effect: 'command',
    desc: '档案/资料的描述生成。', timeout: 180 },
  { key: 'skill-review', label: 'Skill 审查', sub: '审查', group: 'adv', effect: 'command',
    desc: 'Skill 指令的审计与把关——判错代价高，指挥时用强档并由主脑复核。', timeout: 600 },
]

const TASK_BY_KEY = new Map(TASKS.map(t => [t.key, t]))

/** 默认态：全 auto（与 Hermes「自动·优先复用主模型」同语义）。 */
function defaultState() {
  const tasks = {}
  for (const t of TASKS) {
    tasks[t.key] = { mode: 'auto', provider: '', model: '', timeout: t.timeout }
  }
  return { version: 1, tasks }
}

/**
 * 从 profile patch 的 llm-pi-ai 段实时提取 providers/models 目录。
 * 纯正则（host 不能 import js-yaml——它在 app.asar 里，插件目录没有 node_modules）。
 * 失败任何一步都整体退回 DEFAULT_PROVIDERS。
 */
function extractProviders() {
  let text
  try {
    text = readFileSync(PATCH_FILE, 'utf8')
  } catch {
    return DEFAULT_PROVIDERS
  }
  try {
    const anchor = text.indexOf('- id: llm-pi-ai')
    if (anchor < 0) return DEFAULT_PROVIDERS
    const rest = text.slice(anchor)
    const end = rest.slice(1).search(/\n- id: /)
    const block = end >= 0 ? rest.slice(0, end + 1) : rest
    const providers = []
    // provider 名：6 穩缩进的 `      name:`；模型：10 穩缩进的 `          - id: xxx`
    const segRe = /^ {6}([\w][\w-]*):(?:\s*)$/gm
    const segs = []
    let m
    while ((m = segRe.exec(block)) !== null) segs.push({ name: m[1], at: m.index })
    for (let i = 0; i < segs.length; i++) {
      const body = block.slice(segs[i].at, i + 1 < segs.length ? segs[i + 1].at : block.length)
      const models = []
      const modelRe = /^ {10}- id: (\S+)/gm
      let mm
      while ((mm = modelRe.exec(body)) !== null) models.push(mm[1])
      providers.push({ id: segs[i].name, models })
    }
    return providers.length > 0 ? providers : DEFAULT_PROVIDERS
  } catch {
    return DEFAULT_PROVIDERS
  }
}

function readState() {
  const base = defaultState()
  try {
    if (!existsSync(STATE_FILE)) return base
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8').replace(/^﻿/, ''))
    if (raw && typeof raw === 'object' && raw.tasks && typeof raw.tasks === 'object') {
      for (const key of Object.keys(base.tasks)) {
        const got = raw.tasks[key]
        if (!got || typeof got !== 'object') continue
        const mode = got.mode === 'custom' ? 'custom' : 'auto'
        base.tasks[key] = {
          mode,
          provider: mode === 'custom' ? String(got.provider || '') : '',
          model: mode === 'custom' ? String(got.model || '') : '',
          timeout: clampTimeout(got.timeout, base.tasks[key].timeout),
        }
      }
    }
  } catch {
    /* 坏文件退回默认——绝不因面板坏档让插件罢工 */
  }
  return base
}

function clampTimeout(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(5, Math.min(600, Math.round(n)))
}

function writeState(value) {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, STATE_FILE)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读 PUT body（上限 64KB，防呆）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 65536) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 校验 PUT 载荷。白名单任务键、provider 必须在真实目录里、model/timeout 有界。
 * 返回 { ok, value } 或 { ok:false, error }。
 */
function validateState(payload, providers) {
  let parsed
  try {
    parsed = JSON.parse(payload)
  } catch {
    return { ok: false, error: '请求体不是合法 JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.tasks || typeof parsed.tasks !== 'object') {
    return { ok: false, error: '缺少 tasks 对象' }
  }
  const providerIds = new Set(providers.map(p => p.id))
  const value = defaultState()
  for (const key of Object.keys(value.tasks)) {
    const got = parsed.tasks[key]
    if (!got || typeof got !== 'object') continue
    if (got.mode !== 'custom') continue // auto：保留默认态（provider/model 清空）
    const provider = String(got.provider || '')
    if (!providerIds.has(provider)) {
      return { ok: false, error: `任务 ${key} 的服务商「${provider}」不在当前 providers 目录里` }
    }
    const model = String(got.model || '')
    if (model.length > 120) return { ok: false, error: `任务 ${key} 的模型名过长` }
    value.tasks[key] = {
      mode: 'custom',
      provider,
      model,
      timeout: clampTimeout(got.timeout, value.tasks[key].timeout),
    }
  }
  return { ok: true, value }
}

export function apply(ctx) {
  const server = ctx.webServer

  ctx.effect(() => server.register({
    kind: 'exact',
    path: ROUTE + '/catalog',
    handler: (req, res) => {
      sendJson(res, 200, { providers: extractProviders(), tasks: TASKS })
    },
  }), 'aux-models: catalog route')

  ctx.effect(() => server.register({
    kind: 'exact',
    path: ROUTE + '/state',
    handler: (req, res) => {
      if (req.method === 'PUT') {
        void (async () => {
          const body = await readBody(req)
          const check = validateState(body, extractProviders())
          if (!check.ok) {
            sendJson(res, 400, { error: check.error })
            return
          }
          writeState(check.value)
          sendJson(res, 200, check.value)
        })().catch(error => {
          ctx.logger?.error?.('aux-models: save failed', error)
          if (!res.headersSent) sendJson(res, 500, { error: '保存失败：' + (error?.message ?? '未知') })
        })
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      sendJson(res, 200, readState())
    },
  }), 'aux-models: state route')

  ctx.logger?.info?.('aux-models: 已装配（状态 ' + STATE_FILE + '）')
}
