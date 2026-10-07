# dsh-provider-accent

> 切换模型时，把「**供应商**」高亮成对比度紫色 —— 模型菜单与 `/model` 弹窗里的供应商分组标题
> 不再是一行灰扑扑的小字，一眼看清自己在挑哪家。

## 它改了什么

DSH 官方模型选择器（`@deepseek-ai/dsh-client-ui-model-selection`）把模型按供应商分组，
每个供应商是一行 **sticky 分组标题**（`MenuGroup`），颜色取自 `--dsw-alias-label-tertiary`
（三级标签色，很淡）。本插件只重绘这一行：

| 项目 | 官方 | 本插件 |
|---|---|---|
| 颜色（暗色主题） | `--dsw-alias-label-tertiary` | `#a78bfa`（violet-400） |
| 颜色（亮色主题） | 同上 | `#7c3aed`（violet-600） |
| 字重 | 500 | 600 |

字号、内距、背景（含吸顶时那层 94% 填充）、其它任何 DOM 与官方 class **都不碰**。

覆盖两个面：

1. **输入框的模型菜单**（点输入框右下角模型名 → 再点「模型」那一行展开的列表）；
2. **`/model` 命令弹窗**（`/<command> options` 那个 listbox）。

**不碰**：命令面板（`/`）自己的分组标题 —— 它们的行不是 `menuitemradio`、listbox 也不叫 `/model`，
保持官方三级灰。

## 怎么定位的（锚点来自 app.asar 里读的官方源码，不猜）

```text
composer 模型菜单（ModelSelect，portal 到 body 的 MenuSurface）
  <div role="menu" aria-label="模型">
    <section role="group" data-menu-group>            ← MenuGroup
      <span data-menu-group-start>
      <div data-menu-group-heading>  zai </div>        ← 供应商标题（目标）
      <button role="menuitemradio" …> MiMo-V2.6-Flash </button>   ← 模型行
    </section>

/model 命令弹窗（ui-commands 的 PopupSelectView）
  <div role="listbox" aria-label="/model 选项">        ← 前缀 /model，与语言无关
    <section role="group" data-menu-group>
      <div data-menu-group-heading> … </div>           ← 供应商标题（目标）
      <div role="option" …> … </div>
```

于是两条选择器（对哈希化的 CSS module 类名零依赖）：

```css
section[data-menu-group]:has(> [role="menuitemradio"]) > [data-menu-group-heading]
[role="listbox"][aria-label^="/model"] section[data-menu-group] > [data-menu-group-heading]
```

特异性 (0,3,1) 高于官方的 `.heading` (0,1,0)，不需 `!important`。

**为什么不用 `--dsw-alias-label-tertiary` 做令牌覆盖**：那个令牌全 App 都在用，改它会把别处一起染紫。
供应商标题没有专属令牌，所以按「组件级 CSS」处理。

## 安装

跟着仓库的安装脚本走（会自动备份 profile 配置、挂 `link:` 依赖、加进 `dsh.profile.bundles`、跑 `pnpm install`）：

```bash
pwsh -File scripts/install.ps1 -Profile desktop -Plugin dsh-provider-accent     # Windows
# bash scripts/install.sh -p desktop                                          # macOS / Linux
```

- **bundle 型**：装完**刷新页面**即生效，不用重启 DSH。
- 手工挂载时（二选一，**不要都挂**，重复 id 会被 client-modules 表拒）：
  `dsh.profile.bundles` 里加 `dsh-provider-accent`；或在 profile 的 `cordis.patch.yml` 末尾加
  `- insert: [{ id: provider-accent, name: dsh-provider-accent }]`。
- 卸载：`pwsh -File scripts/uninstall.ps1 -Profile desktop -Plugin dsh-provider-accent`。

## 生效与自检

- **宿主半边**：加完即进 cordis 树（HMR 重组）。用 `cordis_inspect_query` 查
  `host/Config.listConfigs {name:"dsh-provider-accent"}` → 应出现 `patchId: provider-accent`。
- **客户端半边**：产物编进 `window.__DSH_BOOT__`，刷新页面后生效；devtools 里
  `__dshProviderAccent.apply()` 可手动补插样式表，`__dshProviderAccent.colors` / `.selectors` 是当前配置。
- **离线自测**（不需要 DSH）：

  ```bash
  node build-client.mjs          # src/client.js -> lib/client.js
  node verify/client-test.mjs    # 21 项：loader 契约 / 选择器 / 两套配色 / effect 回收
  ```

- **肉眼**：输入框模型控件 → 点「模型」→ 供应商标题（如 `DeepSeek` / `CodeArts Agent`）应为紫色加粗。

## 改配色

只改 `src/client.js` 顶部的 `LIGHT_COLOR` / `DARK_COLOR` / `HEADING_WEIGHT`，然后：

```bash
npm run build     # 或直接 node build-client.mjs
```

改完刷新页面即可（客户端产物按 URL 记，必要时重启 DSH）。

## 结构

| 文件 | 角色 |
|---|---|
| `lib/index.js` | 宿主半边：零逻辑，只做「让这个包成为 cordis 一行」+ 静态核对客户端产物 |
| `src/client.js` | 客户端源码：一张 `<style>`，两条锚点选择器，明暗两套紫 |
| `lib/client.js` | 构建产物（`build-client.mjs` 生成，勿手改） |
| `cordis.patch.yml` | bundle 层：`insert` 一行 `id: provider-accent` |
| `verify/client-test.mjs` | 离线黑盒自测（stub `window.__ModuleLoader__` + `document`） |
| `AGENTS.md` | 维护说明：锚点契约、踩过的坑、验收手法 |

## 纪律

不写设置、不进模型上下文、不监听会话事件、不碰官方 DOM 与 class；任何一步找不到锚点，
菜单就保持官方配色 —— 本插件结构上不会让菜单点不开或报错。
