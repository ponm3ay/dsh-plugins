# dsh-whale-memory —— 长期记忆区

> 属于 [dsh-plugins](https://github.com/ponm3ay/dsh-plugins) 仓库 · MIT · DSH 插件

给 DSH 装的「长期记忆」宿主插件：跨会话记忆不再被上下文窗口卡死。

## 三件事

| 环节 | 钩子 | 行为 |
|---|---|---|
| 捕获 | `session/event` | 顶层会话的表面事件（用户/助手/工具/回合）以 JSONL 追加到 `memory/journal/<sid>.jsonl`，内存缓冲 + 2 秒批量落盘，单行 8KB、单文件 512KB 封顶 |
| 回忆 | `system-prompt/assemble` | 每个系统提示词末尾注入 `whale-memory` 一节：最近 2 条会话摘要 + `index.md` 索引 + 维护指引，总长 ≤ 4.2KB |
| 整理 | `session/disposed` + 启动兜底 | 会话结束且流水 ≥ 8KB 时，调用便宜模型（默认 `xiaomi/mimo-v2.6-flash`）压成 ≤400 字摘要写入 `memory/digests/<sid>.md`；启动 15 秒后补扫上次没来得及整理的流水 |

**验收记录（2026-10-02，真机端到端实测）**：插件 active；捕获 ✓（journal 实时增长，已剔 3 行系统噪声）；
注入 ✓（区块 1639 → 2876 字，persona.md 养成区在前）；真机 digest ✓（79085 字节流水 → MiMo 生成 953 字摘要，
22 秒，写入 `digests/` 后被下一轮注入）；子代理会话经 `topLevelOnly` 过滤，不进记忆库 ✓。

验收中发现并修掉的问题（v3）：
1. **严格注入制**：未 `inject` 的服务连读属性都抛错（`cannot get property "timer" without inject`）→
   定时器改用全局 `setInterval`；`llm` 走 apply 时保存的 `hostCtx`（v3 前 `callDigestLlm` 误引用未定义的 `ctx`，
   真机两次摘要失败）。**该修复已于 2026-10-02 22:08 真机复验通过**（70KB 流水 → 724 字摘要，无报错）。
2. **模块缓存按 URL 记**：改完代码不重启不生效，免重启生效须**同时换文件名与 patch 行 id**（真机验证过）；
   ⚠️ 开发期入口是带版本号的文件名（`index.v6.js` 这类），**发布版已收敛为 `index.js`** —— 见文末「热重载与入口命名」）。
3. **JSON 的 BOM 容错**：Windows 记事本 / PowerShell 5.1 的 “UTF8” 会写 BOM，此前会让 `state.json`/`plugin.json`
   解析失败并**静默退回默认值**（曾导致摘要标记丢失、重复调用模型）；`loadJson` 已剥 BOM。
4. **系统注入过滤**：`<system-reminder>` 与子代理通知（`Agent … sent a message:` / `Background subagent … finished`）
   也是 user 角色消息，此前污染流水与摘要标题；已按形态过滤。
5. **摘要幂等**：摘要文件不比流水旧则跳过，即使 `state.json` 丢失也不会重复烧钱。

v4 的两处修复（2026-10-02 晚）：
6. **误导提示**：注入区块尾部那句「有约 N KB 流水尚未整理，会话结束时会自动整理」此前只判
   `pendingJournalKb() >= 32`，不看 `digest.enabled` —— 摘要关掉时仍在骗人；已补上开关判断。
7. **recall 日志粒度**：此前用模块作用域 `assemblyLogged`，**每个进程只记一行**，日志无法证明「某个新会话
   确实注入过」；v4 起改为**按会话首次各记一行**并带上会话 id，行首加 `[v4]` 标记作可观测探针。

v5 与 v6（2026-10-02 深夜，两次「换名强制重载」的连续迭代）：
8. **v5 = 纯换名版**：磁盘 `index.v4.js` 被改过内容、URL 却没变，运行的一直是模块缓存里的**早期 v4**
   （日志表现为「每轮一行、无 `[v4]`」）→ 复制为 `index.v5.js` + 行 id 换 `whale-memory-v5` 强制重载。
   教训：**验收要看「新标记」，不能看 boot 行**（boot 行只说明重载发生了）。
9. **v6 = 正确取 scope**：v5 生效后日志立刻暴露下一层 —— `AssembleContext` 的官方契约只有 `{ scope?, signal? }`，
   v4/v5 写的 `context?.id` **取错了层级**、恒为 undefined，所以「按会话记」必然退化成「每轮一行」。
   正确取法：`context.scope` 传进来的其实是 Agent 实例，**`context.scope.id` 就是 SessionId**；
   v6 改用 scope 对象（WeakSet）去重，并把 `scope keys=[…]` 打进日志供求证。
   实测：同一会话只记一条且带真实 id —— `[v6] …（3696 字，会话 session-9fd3c27c-…；scope keys=[loopCtx,id,options,session,inbox,phase]）`。

**摘要真实行为（v4 时期实测）**：`session/disposed`（会话结束）与 `startupSweep`（插件启动/热重载后 15 秒）
都会触发整理 —— 所以**插件在会话进行中被重载时，会生成一份「中间态快照摘要」**（本会话即如此：70609 字节
→ 724 字，约 40 秒；无害，但会花一次便宜模型调用）。

## 记忆库布局（`$DSH_HOME/memory/`，可用 `DSH_MEMORY_DIR` 覆盖）

```
memory.md        长期记忆正文（本鱼手动维护，日期行追加）
index.md         精简索引（新会话自动注入，本鱼维护）
plugin.json      插件配置（改完下次生效，无需重启）
state.json       会话元数据（首条消息、已整理标记）
journal/         原始流水（自动捕获，只保留最近 40 份）
digests/         会话摘要（自动生成，只保留最近 60 份）
plugin-log.txt   插件日志（只读排查用）
```

## 配置（plugin.json，均为默认值）

```json
{
  "capture": { "enabled": true, "topLevelOnly": true,
               "journalCapBytes": 524288, "flushIntervalMs": 2000 },
  "recall":  { "enabled": true, "recentDigests": 2, "maxBlockChars": 5200,
               "maxPersonaChars": 2600, "maxIndexChars": 1400, "maxDigestChars": 1400 },
  "digest":  { "enabled": true, "minJournalBytes": 8192,
               "provider": "xiaomi", "model": "mimo-v2.6-flash", "maxTokens": 900 }
}
```

- 摘要用的模型换成 `tokenhub/hy3` 等也只需改 `digest.provider/model`。
- `digest.enabled=false` 时只捕获+回忆，整理交给 `memory` 技能手动做。

## 纪律

- 只 import node 内置模块，目录内自解析，无 node_modules、无 npm 依赖。
- 所有事件监听器自行 try/catch，任何失败只写 `plugin-log.txt`，绝不影响会话提交。
- 不改会话日志、不读凭证文件；凭证由 DSH 的 llm 服务在请求时解析。
- 与 `memory` 技能（`~/.dsh/skills/memory/SKILL.md`）配合：事实沉淀靠本鱼，压缩摘要靠插件。

## 安装

本仓库一键安装：

```bash
pwsh -File scripts/install.ps1 -Profile desktop -Plugin dsh-whale-memory   # Windows
bash scripts/install.sh -p desktop --plugin dsh-whale-memory               # macOS / Linux
```

手动步骤（`$DSH_HOME` = DSH 家目录）：

1. 把本目录放到 `$DSH_HOME/plugins/dsh-whale-memory/`（本文件所在处，**入口 `index.js`**）。
2. profile `package.json` 增加 `"dsh-whale-memory": "link:<本目录绝对路径>"`，
   并把 `dsh-whale-memory` 加进 `dsh.profile.bundles`；然后 `pnpm install`。
3. **`package.json` 的 `main`/`exports` 必须与入口同步**（发布版均为 `index.js`）——
   改代码换名时别漏了它，否则外部 `import 'dsh-whale-memory'` 会指到旧文件。
4. 本包自带 `cordis.patch.yml`（`id: whale-memory`），bundle 路线会被自动挂载。
   若走 profile patch 行路线，二选一，别同时挂（重复 id 会被拒），例如：
   ```yaml
   - insert:
       - id: whale-memory
         name: dsh-whale-memory
   ```
5. 刷新页面或重启 DSH；验证三处：`cordis.yml` 里出现对应条目、
   `memory/plugin-log.txt` 出现 boot 行与带 `[v6]` 的 recall 行、`memory/journal/` 出现流水。

## 热重载与入口命名

**模块缓存按 URL 记**：同一路径改了内容也不会重新加载（两次真机事故验证过）。所以：

| 场景 | 入口文件 | 纪律 |
|---|---|---|
| 开发期反复热修 | `index.vN.js`（带版本号） | 改代码时**同时换文件名 + 换 patch 行 id**，强制重载 |
| 发布 / 长期稳定 | `index.js` | 想改就重启 DSH（或照上面换名） |

带版本号的文件名让「换名」成为默认动作；固定名容易诱导「只加 reload 不换名」→ 必然踩缓存。

**正确迭代姿势（开发期）**：复制 `index.vN.js` → `index.v{N+1}.js` 改内容并更新日志标记 →
同步 `package.json` 的 `main`/`exports` → patch 换 `id: whale-memory-v{N+1}` 并指向新文件 →
把上一版留在根目录（或 `archive/`）作回滚位。
