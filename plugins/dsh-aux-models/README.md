# dsh-aux-models —— 设置页「辅助模型」面板

照 Hermes Agent 的「辅助模型按任务生效」页做的 DSH 版：**一个设置页，按任务选辅助模型**。
布局对齐那张截图——左列任务列表（徽章显示 `自动` / `provider/model`），右侧表单
（服务商下拉 · 模型输入 · 调用超时 · 保存 / 恢复为自动），顶栏一个「全部恢复为自动」。

```
设置 → 辅助模型
┌──────────────┬────────────────────────────────────────┐
│ 常用辅助任务  │ 视觉分析                    [指挥生效] │
│  视觉分析 自动│ 图片附件与截图的分析路由…              │
│  上下文压缩  │ 服务商  [ Auto 自动选择 · auto    ▾ ]  │
│  网页抽取    │ 模型    [ 自动模式下不需要填写模型  ]  │
│  标题生成    │ 超时    [ 60                       ]  │
│  智能审批    │ [保存此辅助任务] [恢复为自动] 已保存   │
│  MCP 路由    │                                        │
│ 高级辅助任务  │ 生效方式 · 指挥生效：主脑派发对应任务时 │
│  技能中心…    │ 读此表选模型。                        │
└──────────────┴────────────────────────────────────────┘
```

## 它到底改变什么（不吹）

选型落盘一份机器可读的槽位表：**`$DSH_HOME/orchestra/aux-models.json`**。三种生效方式，
面板上每一条都如实标注：

| 徽章 | 含义 | 任务 |
|---|---|---|
| **立即生效** | 接线到真实调用点 | 上下文压缩 → whale-memory v8/v9 摘要前**现读此槽**，覆盖 provider/model/超时（保存后下一次摘要即生效，不必重载） |
| **指挥生效** | 主脑派发该类任务时读此表选模型（写进 `orchestra/capabilities.md` §1.5 派发纪律） | 视觉分析 · 网页抽取 · MCP 路由 · 技能中心 · Kanban 扩写/分解 · 档案描述 · Skill 审查 |
| **仅参考** | 该任务当前由 DSH 内核自管（模型不走本表），此处选型留作内核开放配置后的预设 | 标题生成（`session-title-llm`）· 智能审批（auto-review 捆） |

⚠️ **「自动」的语义**：优先复用主模型 / 默认路由，必要时按后端策略 fallback——不是「不做事」。
显式指定后该任务固定走选中的 provider/model，超时 5–600 秒（面板与宿主双重钳制）。

## 两半的分工

| 文件 | 角色 | 关键约束 |
|---|---|---|
| `entry.js` | 宿主半：`inject = ['webServer']`，两条 exact 路由 | `/catalog` 返回 provider/model 目录（**从 profile 的 `cordis.patch.yml` 的 `llm-pi-ai` 段实时正则提取**，提不到就退回内置 `xiaomi/zai/gpt`）+ 任务清单；`/state` GET 读、PUT 校验后**原子写**（临时文件 + rename） |
| `src/client.js` → `lib/client.js` | 浏览器半：注册 `settings.section`（`id: aux-models`，`order: 118`，`label: 辅助模型`） | 只 inject `slots`；`require('react')` 是基线词；**无 JSX、无打包器**；CSS 串里不出现反引号 |
| `cordis.patch.yml` | bundle 层：装进 profile 的 `dsh.profile.bundles` 即插一行 `aux-models-panel` | bundle 与 profile patch 行**二选一**，两条同 id 会被 client-modules 拒 |

数据全程走 HTTP，**不写会话日志、不进模型上下文、不碰 DSH 本体源码**。

## 校验与拦截（PUT）

- 任务键白名单（只认 11 个已知任务，其余忽略）
- `provider` 必须在**当前真实 provider 目录**里，否则 400 并指名报错
- 模型名 ≤120 字；超时钳到 5–600 秒
- 请求体 ≤64KB，非 JSON / 缺 `tasks` 一律 400
- 磁盘档损坏（读不出/JSON 坏）→ **读默认态，绝不让面板坏档拖垮插件**

## 装法（二选一）

```powershell
# A. bundle（推荐）
#    profile/package.json 的 dependencies 加 "dsh-aux-models": "link:<本目录>"
#    dsh.profile.bundles 加 "dsh-aux-models"，然后 pnpm install
# B. profile patch 行：在 profile 的 cordis.patch.yml 追加
#    - insert: [{ id: aux-models-panel, name: dsh-aux-models }]
```

改 `src/client.js` 后跑 `node build-client.mjs` 重建 `lib/client.js`，再刷新页面。
`entry.js` 改动由 HMR 重组生效（patch 被 watch）。

## 自检

```powershell
$b = "http://127.0.0.1:<DSH端口>/plugins/dsh-aux-models"
Invoke-WebRequest "$b/catalog" -UseBasicParsing | Select-Object StatusCode   # 200 + providers/tasks
Invoke-WebRequest "$b/state"   -UseBasicParsing | Select-Object StatusCode   # 200 + 11 任务
node --check lib/client.js
```

客户端半体是否真落位（比 HTTP 更硬的证据）：

```text
cordis_inspect_query(platform:"client", provider:"Slots", method:"listSubTree",
  input:{ root:"settings.section" })   → occupants 里应有 { id:"aux-models", order:118, active:true }
```

## 已知边界

- provider 目录是**正则**从 patch 提取的（宿主半不能 import js-yaml——插件目录没有 node_modules）。
  patch 结构大改时正则可能失手 → 退回内置目录，不影响面板可用，但下拉会少项。
- 「上下文压缩」选 `zai/glm-5.3-flash` 实测被上游拒：`This model always engages in thinking and
  cannot be disabled`（该模型不接受关闭思考的调用）。压缩槽建议留 `xiaomi/mimo-v2.6-flash`，
  zai 系留给允许思考的任务。
- 面板只能配「模型选型」，改不了 DSH 内核任务本身（如标题生成用哪个模型）——这是边界，不是 bug。
