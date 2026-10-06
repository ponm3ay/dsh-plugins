# dsh-whale-backdrop — 维护说明（给下一个接手的人/代理）

## 它是什么

DSH 桌面端的**纯装饰**客户端插件：把 `assets/` 里的画铺在整窗后面，并把主题令牌改成半透明，
让面板透出背景。不改 DSH 本体源码，不写会话日志，不进模型上下文，不碰任何设置文件。

## 两半的分工

| 文件 | 角色 | 关键约束 |
|---|---|---|
| `entry.js` | 宿主半：`name` = `dsh-whale-backdrop`，`inject = ['webServer']`，两条 `server.register` 路由 | **路由前缀只能挂在 `<ROUTE>/image`**，绝不能挂 `<ROUTE>` 本身——浏览器取本包客户端产物走 `/plugins/dsh-whale-backdrop/client.js`，根前缀会把那条请求吃成本插件的 404，产物永远加载不出来。`resolveImage` 会拒掉 `/ \ ..` 与未知扩展名 |
| `src/client.js` | 浏览器半：注入样式表 + `theme.overrideTokens` + 拉清单挑图 | 只 import 无；用 `exports.apply / exports.inject`（CommonJS 风格，外面由加载器包壳）。**没有 react、没有 JSX**，别引依赖 |
| `lib/client.js` | 构建产物 = 源码逐字套 `window.__ModuleLoader__.load({ id: "<package name>" … })` | 产物即构建，改源码后必须重跑 `build-client.mjs`；脚本会拒绝重复包裹 |
| `assets/` | 图片池，**目录即配置** | 只认顶层文件（子目录跳过）；`backdrop.jpg` 同时是 `primary` 与客户端兜底。**仓库里不放图**（见文末） |

## 挂载方式（二选一）

| 路线 | 怎么做 | 说明 |
|---|---|---|
| bundle（推荐） | 把包名加进 profile 的 `dsh.profile.bundles`，再 `pnpm install` | 本包自带 `cordis.patch.yml`，装着即热生效 |
| profile patch 行 | 在 profile 的 `cordis.patch.yml` 末尾追加 `- insert: [{ id: whale-backdrop, name: dsh-whale-backdrop }]` | 手工挂第三方插件的 profile 用这条 |

- ⚠️ **两条**都挂会出现重复 id，client-modules 表会拒绝该包。
- 仓库级安装脚本已经把这件事做完了：`pwsh -File scripts/install.ps1 -Plugin dsh-whale-backdrop`。

**实测（2026-10-02）**：加完 patch row + junction 后**无需重启 DSH**，`images.json` 首次请求即 200
（profile patch 被 watch，树自动重组）。`entry.js` 改动同理；`src/client.js` 改动需要重建 + 刷新页面
（新产物的 revision 不保证就地重取，必要时重启 DSH）。

## 自检

```powershell
# 宿主半活着？（200 + JSON 清单）
Invoke-WebRequest "http://127.0.0.1:$PORT/plugins/dsh-whale-backdrop/images.json" -UseBasicParsing | Select-Object StatusCode,Content
# 字节路由与守卫（应 200 / 404 / 404）
Invoke-WebRequest "http://127.0.0.1:$PORT/plugins/dsh-whale-backdrop/image/backdrop.jpg" -UseBasicParsing | Select-Object StatusCode,Headers
# 产物语法
node --check lib/client.js
```

（`$PORT` 就是 DSH Web GUI 的端口，页面上那个地址里的数字。）

浏览器半没有 DOM 探针，**视觉只能靠人眼**：页面里 `__dshWhaleBackdrop.paint()` 可重摇一次。

## 已知取舍

- 令牌半透明是「面板全部一起透」，不是只透聊天区；暗色下 alpha ≈ `.52–.62` 观感与可读性兼顾。
- 若某处面板用的是**写死的颜色**（不是令牌），那张面板不会透出背景——需要针对该元素补规则，
  别为此把 `TOKENS` 一路调低（会牺牲正文可读性）。

## 图片：本仓库不分发

开发时用的是第三方同人作品（Pixiv 上的画，版权归画师），**只在本机个人使用**。
开源发布时这些图被移除了 —— 所以 clone 下来 `assets/` 是空的，请自备图片。

- 提 PR 时**不要**带别人的作品进来。
- 一张图都没有时插件照常工作，只是没有背景。
