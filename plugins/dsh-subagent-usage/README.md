# dsh-subagent-usage — 子代理「模型 / 推理等级 / token」显示

> 属于 [dsh-model-routing](https://github.com/ponm3ay/dsh-model-routing) 仓库 · MIT · DSH 插件

在每个会话的对话里显示这次跑的到底是**哪个模型**、**什么推理等级**、**烧了多少 token**。
重点场景是子代理：打开某个子代理的会话，就能随时查它用了什么、花了多少 —— 不往主对话里刷报告，
也**不写进会话日志、不进入任何模型的上下文**。

## 你会看到什么

**① 会话标题栏右侧的小芯片**（常驻，随会话推进实时更新）

```
🐋 一次性子代理 · deepseek-flash · 推理等级 max · 15.9K tok  ●
```

- `🐋` 之后的类型标签只对子代理显示（一次性 / 可继续）；主会话不显示类型片段。
- 圆点在子代理正在跑的时候是**蓝色呼吸**的，停下后变灰。
- 鼠标悬停在芯片上会给出完整提示：提供方、模型、推理等级、token 合计、运行状态。
- 还没有任何模型请求的空会话**不显示**这个芯片（不占地方）。

**② 每轮对话结束后的一行**（在对话流末尾，可展开看明细）

```
🐋 deepseek-flash · 推理等级 max · 本轮 1.4K tok    详情
```

点「详情」展开：

| 行 | 内容 |
|---|---|
| 模型 / 提供方 | 实际发出去的那条路由 |
| 推理等级 | 该轮冻结的调用配置里的等级，没有就写「默认」 |
| 本轮 | 本轮 token 合计、模型耗时、步数 |
| 会话累计 | 整个会话的 token 合计 |
| 模型请求 / 步数 / 模型耗时 | 这一会话发了几次请求、走了几步、模型侧耗时 |
| 上下文窗口 | 提供方报的窗口大小 |
| 结束原因 | 正常完成 / 已中止 / 出错 / 触及上限 …… |
| 四桶明细 | 未缓存输入、缓存读、缓存写、输出，外加「其中推理」（推理是输出的一部分，不重复计入合计） |

## 数据从哪来

不是估算，也不是我在派活时自己声明的，而是**子代理自己那份日志里的权威记录**：

| 来源 | 取到什么 |
|---|---|
| `model/selection` | 这个会话自己选了哪条路由 |
| `request/header` 的 `header.config` | **实际冻结下来的** provider / model / reasoningEffort / maxTokens |
| `assistant/message` | 提供方回报的 usage 四桶，以及真正服务这次请求的 provider / model |
| `subagent/descriptor` | 这是一次委派、一次性还是可继续、被要求跑在哪条路由上 |
| `turn/start` `turn/end` `step/*` | 轮次、步数、模型耗时、结束原因 |

实现方式是 DSH 的**会话投影**（session projection）：一个纯函数折叠，注册成 `subagentUsage` 这个投影键，
由内核在每次事件提交后驱动。客户端用 `useProjection('subagentUsage')` 读取。

三个直接后果：

1. **零副作用**：不追加会话事件、不改任何消息，模型完全看不到它 —— 不是「报告」，是「查」。
2. **重载不丢**：值是由日志重新折叠出来的，刷新页面、切会话、甚至重启 DSH 之后照样在。
3. **按会话隔离**：每个会话（含每个子代理）各有自己的值，互不干扰。

## 怎么用

- **看某个子代理**：在父会话标题栏点「N 个子智能体」的按钮 → 展开子代理目录 → 点任意一行，
  就打开了那个子代理的会话；标题栏芯片与轮末用量行就在那里。
- **看主会话自己**：同一个芯片在主会话标题栏也显示（主会话的模型 / 推理等级 / 累计 token）。

## 想调整

| 想要 | 改哪里 |
|---|---|
| 只在子代理会话显示，主会话不显示 | `src/client.js` 的 `UsageChip`：在 `const nothing = ...` 之后加 `if (view.mode === null) return null`，然后重新构建 |
| 改文案（中/英） | `src/client.js` 顶部的 `zh` / `en` 字典；中文那份是键集合的唯一权威 |
| 改轮末行的位置 | `src/client.js` 里 `TAIL_SLOT` 注册的 `order`（越小越靠前；官方交付物是 0，本插件是 100） |
| 改标题栏芯片的位置 | `HEADER_SLOT` 注册的 `order`（子代理目录 -30、本插件 -20、agent 预设 -10、任务 20） |

改完客户端必须重新构建并刷新页面：

```bash
cd plugins/dsh-subagent-usage      # 本仓库里的插件目录
node build-client.mjs
```

改 `entry.js`（宿主半边）不需要手动重启：profile 的 patch 文件被监视，行会重组；实在不生效就重启 DSH。

## 自检

```bash
cd plugins/dsh-subagent-usage
node verify/fold-test.mjs      # 宿主折叠逻辑（拿真实会话日志跑，18 项）
node verify/client-test.mjs    # 客户端两个座位与渲染文本（33 项）
```

`fold-test.mjs` 不带参数时会自动挑 `$DSH_HOME\sessions` 下最大的那份会话日志。
想验某条子代理会话，把它那份 `session.v4.jsonl.zstd` 路径传进去即可。

## 安装

本仓库一键安装：

```bash
pwsh -File scripts/install.ps1 -Profile desktop -Plugin dsh-subagent-usage   # Windows
bash scripts/install.sh -p desktop --plugin dsh-subagent-usage               # macOS / Linux
```

细节与手动步骤见 [`docs/install.md`](../../docs/install.md)。要点：

1. profile 的 `node_modules` 里放一个指向本目录的链接（pnpm 的 `link:` 依赖，或目录联接）。
2. profile `package.json` 的 `dependencies` 里写 `"dsh-subagent-usage": "link:<本目录的绝对路径>"`。
3. 把 `dsh-subagent-usage` 加进 `dsh.profile.bundles`（走 bundle 路线），
   或在 profile 的 `cordis.patch.yml` 末尾追加 `- insert: [{ id: subagent-usage, name: dsh-subagent-usage }]`。

⚠️ **两条路选一条**：同时把包名加进 bundles 又手工插一行，会插入两条同 id 的条目，加载器会拒绝。
改完刷新页面即生效（宿主半边热加载；客户端产物变了要重建 + 刷新，必要时重启 DSH）。

### 装到别的机器 / 重装

本质上只要三步（`<plugin>` = 本目录）：

1. profile 的 `node_modules` 里放一个指向 `<plugin>` 的链接（pnpm 的 `link:` 依赖，或 Windows 目录联接）。
2. profile `package.json` 的 `dependencies` 里写 `"dsh-subagent-usage": "link:<plugin> 的路径"`。
3. profile `cordis.patch.yml` 末尾追加那两行 `- insert:` 条目。

也可以走官方的 bundle 路线（本包自带 `cordis.patch.yml` 与 `dsh.bundle` 声明）：
`dsh plugin --profile desktop add <plugin>`，然后重启 DSH。
⚠️ **两条路选一条**：同时把包名加进 `dsh.profile.bundles` 又手工插一行，会插入两条同 id 的条目。

### 卸载

1. 删掉 profile `cordis.patch.yml` 末尾那段 `- insert:`（含上方注释）。
2. 删掉 profile `package.json` 里的 `dsh-subagent-usage` 依赖行。
3. 删掉 profile `node_modules\dsh-subagent-usage` 链接。
4. 源码目录可留可删。重启或等 patch 重载后，键与界面一起消失。

只想去掉页面上的显示、保留宿主半边：删掉 `package.json` 里的 `dsh.client` 字段即可
（客户端半边就不再进启动清单，宿主投影仍在，别的插件也能读这个键）。

## 边界与已知限制

- **父会话标题栏那个芯片是父会话自己的**模型 / 推理等级 / 用量，不是子代理的汇总。子代理的模型要
  点进子代理会话看（或看官方子代理目录里那行的 token 合计 + 本插件的芯片）。
  想把「模型 / 推理等级」直接塞进父会话那份子代理目录的每一行，必须**顶掉官方的目录行渲染**
  （`dsh-client-ui-subagent` 自己的组件），属于替换官方 UI，风险高，本插件故意不做。
- **一次委派里的中间步骤不单独计费**：数值是提供方回报的 usage 四桶之和，与内核自带用量口径一致
  （未缓存输入 + 缓存读 + 缓存写 + 输出）。`其中推理` 是输出的子集，不计入合计。
- **失败重试算两次**：同一步内发生过 `llm/retry-started` 时，失败的那次与重试那次都真实消耗了额度，
  所以都计入；这与内核 `tokenUsage` 的口径一致。
- **分叉出来的子会话只算自己的**：`subagent_fork` 的子会话日志开头是父会话的种子，本插件在读到
  该子会话自己的 `subagent/descriptor` 时**重置累计**，只显示属于它的花费。
- 会话还在跑的时候数值是逐步长出来的；`running` 只表示当前有未结束的轮次。
