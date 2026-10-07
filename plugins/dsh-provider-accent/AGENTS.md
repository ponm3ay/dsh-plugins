# dsh-provider-accent — 维护说明（给下一个接手的人/代理）

## 它是什么

DSH 桌面端的**纯装饰**客户端插件：把模型选择器里的**供应商分组标题**染成高对比紫。
不改 DSH 本体源码，不写会话日志，不进模型上下文，不碰任何设置文件。

## 两半的分工

| 文件 | 角色 | 关键约束 |
|---|---|---|
| `lib/index.js` | 宿主半边：零逻辑，只为**让这个包成为 cordis 树上的一行**（客户端产物靠宿主条目被 `dsh-client-modules` 扫进 `window.__DSH_BOOT__`），顺手静态核对产物 | `apply()` 绝不抛错；不声明任何服务（声明一个没人 provide 的会让 fiber 卡 PENDING） |
| `src/client.js` | 浏览器半边：往 `<head>` 插一张 `<style>` | 不 import 任何东西（无 react / 无 JSX），`exports.apply` / `exports.inject`（CommonJS 风格，外面由加载器包壳） |
| `lib/client.js` | 构建产物 = 源码逐字套 `window.__ModuleLoader__.load({ id: "<package name>" … })` | 产物即构建；改源码后必须重跑 `build-client.mjs`（脚本会拒绝重复包裹） |
| `cordis.patch.yml` | bundle 层：`insert` 一行 `id: provider-accent` | 不要再在 profile patch 里手写同一 id（重复 id 会被拒） |

## 锚点契约（改了官方源码就可能失效的地方）

选择器只用**无障碍骨架**，不用哈希化的 CSS module 类名。四个锚点：

1. `section[data-menu-group]` + `div[data-menu-group-heading]` —— `ui-primitives` 的 `MenuGroup`
   渲染的固定属性（`role="group"` / `aria-labelledby` 也在，但用 data 属性最省事）。
2. `[role="menuitemradio"]` —— composer 模型菜单里的**模型行**（`/model` 弹窗的行是 `role="option"`，
   两者靠这个区分；effort 行同样是 `menuitemradio`，但它们**不在** `data-menu-group` 里，所以不受影响）。
3. `[role="listbox"][aria-label^="/model"]` —— `/model` 命令弹窗，`aria-label` 由
   `/{{command}} 选项` 渲染，**永远以 `/model` 开头**，与界面语言无关。
4. `body[data-ds-dark-theme]` —— `ui-theme` 给暗色主题打在 `<body>` 上的标记，用来切两套紫。

配色走**组件级 CSS**，不覆盖 `--dsw-alias-label-tertiary` —— 那个令牌全 App 都在用，
改它会把别处一起染紫；而供应商标题没有专属令牌。

## 验收手法（配色类改动别靠肉眼）

本机 DSH 是 Electron，`screen_observe` 的 AX 树常年为空；但 `wincu` 系 UIA
**其实能读到 Chromium 的 web 内容**（惰性开启无障碍后 400+ 节点；`find` 只扫十几节点，不可靠，
要用 `accessibility_tree`）。配色验收最省事的是**截屏 + 逐像素采样**：

```powershell
# 在模型面板区域数「精确等于目标色」的像素（把 #a78bfa 换成你的色）
$n=0; for($y=300;$y -le 990;$y++){for($x=1150;$x -le 1700;$x++){
  $c=$bmp.GetPixel($x,$y); if($c.R -eq 167 -and $c.G -eq 139 -and $c.B -eq 250){$n++}}}
```

实测基线（2026-10-07，dark 主题）：面板打开时精确 `rgb(167,139,250)` ≈ 207 px（三个标题），
Esc 关掉菜单后归零 —— **归零**这条同样重要，它证明紫色只来自本插件。

## 踩过的坑

- **模型控件的层级**：输入框右下角那个模型名按钮点开先是**根面板**（「模型 / 推理等级」两行 +
  一条滑条），**供应商分组标题在「模型」子页里**，必须再点一次「模型」行才 drill 进去。
  验收时少点这一步会以为"插件没生效"。（`/model` 命令则直接就是带分组的弹窗。）
- **坐标点击在这台机器上不稳**：`wincu` 的 raw-coordinate `click` 对 Electron 窗口可能因
  DPI 虚拟化落空；能用 `invoke`（UIA pattern）就别用坐标点。另外
  `ShowWindow(SW_RESTORE)` 会把**最大化的**窗口还原成普通大小，别拿它当"恢复"用。
- **改客户端产物**：`lib/client.js` 换了内容但 URL 没变时，页面可能命中旧模块缓存 —— 换文件名/换
  行 id，或直接刷新页面；宿主条目本身加完即进树（HMR 重组）。

## 已知取舍

- 字重从 500 提到 600 属于「顺带更醒目」，如果将来觉得和模型名抢层级，把 `HEADING_WEIGHT` 调回 500 即可。
- 只染**分组标题**，不染模型行；模型行保持官方近白色。
- 选择器失效时的表现是**静默退化**（保持官方配色），不会让菜单点不开。
