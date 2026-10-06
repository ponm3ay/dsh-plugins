# dsh-whale-backdrop

> 属于 [dsh-plugins](https://github.com/ponm3ay/dsh-plugins) 仓库 · MIT · DSH 插件

给 DSH 桌面端铺一张背景画：整窗铺画，面板半透明透出图。

> 📷 **本仓库不附带任何图片。** 请把你自己有权使用的图放进 `assets/`
> （见下方「装图」与「图片版权」）。

- **宿主半**（`entry.js`）：两条**只读**路由，不写任何状态
  - `GET /plugins/dsh-whale-backdrop/images.json` → `{ primary, images: [{ name, bytes, revision, type }] }`
  - `GET /plugins/dsh-whale-backdrop/image/<file>?v=<revision>` → 图片字节（ETag / 304 / immutable）
- **浏览器半**（`src/client.js` → `lib/client.js`）：
  1. `<head>` 注入一张样式表：`<html>` 两层背景 = 压暗渐变 + 画，`<body>` 强制透明；
  2. `ctx.theme.overrideTokens('dsh-whale-backdrop', …)` 叠一层半透明令牌（`bg-base` / `bg-layer-1` / `bg-layer-2` /
     `sidebar-fill`），让面板透出背景，卸载即还原；
  3. 拉一次清单，**每次刷新随机挑一张**。

## 装图

把图片丢进 `assets/` 就行，**刷新页面即生效，不用重建、不用重启**：

```powershell
# 首选命名：backdrop.jpg —— 它同时是清单里的 primary 和拿不到清单时的兜底
Copy-Item '你的图.jpg' "$env:DSH_HOME\plugins\dsh-whale-backdrop\assets\backdrop.jpg"
```

- 支持 `jpg / jpeg / png / webp / avif`，直接放在 `assets/` 下（子目录不参与轮换）。
- 一张都没有也能装：插件照常运行，只是没有背景（`images.json` 返回空清单）。
- 多张图 → 每次刷新随机换一张；想固定，把 `src/client.js` 的 `RANDOM_PER_LOAD` 改成 `false`。

## 调参（都在 `src/client.js` 顶部）

| 常量 | 作用 |
|---|---|
| `ENABLED` | 总开关；`false` 等于没装 |
| `RANDOM_PER_LOAD` | 每次刷新随机换图 |
| `TINT_TOP` / `TINT_BOTTOM` | 压在画上的暗化渐变（上/下），字看不清就调深 |
| `TOKENS` | 四个半透明令牌的 alpha；**调大 = 面板更实、更清楚**，调小 = 更透、更好看 |

改完 `src/client.js` 必须重建产物：

```bash
node build-client.mjs        # src/client.js -> lib/client.js
```

然后刷新页面（新产物不保证就地重取；没变化就重启 DSH）。控制台里可手动重摇：
`__dshWhaleBackdrop.paint()`。

## 安装 / 卸载

安装走本仓库脚本（见 [`docs/install.md`](../../docs/install.md)）：

```bash
pwsh -File scripts/install.ps1 -Profile desktop -Plugin dsh-whale-backdrop
```

手动卸载三步（`$DSH_HOME` = DSH 家目录）：

1. profile 的 `cordis.patch.yml` 里删掉 `- id: whale-backdrop` 那个 `- insert:` 块；
2. profile 的 `package.json` 里删掉 `"dsh-whale-backdrop": "link:…"` 一行；
3. 删掉 profile 的 `node_modules/dsh-whale-backdrop` 链接（只删链接，不删源码目录）。

也可以直接用脚本：`pwsh -File scripts/uninstall.ps1 -Plugin dsh-whale-backdrop`。

> ⚠️ **挂载方式二选一**：profile patch 行 **或** bundle（`dsh.profile.bundles` + 自带 `cordis.patch.yml`），
> 两条都挂会出现重复 id，客户端模块表会拒绝该包。

## 图片版权

- 本仓库**不分发**任何图片：`assets/` 里只留说明文件，请自备。
- 想用同人作品做背景，请先看画师在作品页写的授权范围（能不能自用、能不能改、能不能公开）；
  不确定就别放。**你的图，你自己负责。**
- 别把别人的图提 PR 进本仓库 —— 这类 PR 会被关掉。

## 许可

[MIT](../../LICENSE)
