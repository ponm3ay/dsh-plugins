# 第三方插件清单

DSH 的生态里好用的插件不止本仓库这三个。**本仓库不打包别人的作品** ——
版权与上游维护归原作者，我们只维护这份清单：包名、用途、出处、许可证、安装命令。

> 全表已按许可证核对（MIT / Apache-2.0），出处链接均为**真实仓库**。
> 「验证版本」是我们真机装过并跑通的版本；「当前最新」是写这份清单时 registry 上的版本。

---

## 一、本地源码型（clone 到 `$DSH_HOME/plugins/<名>` 后按本地插件装）

| 插件 | 用途 | 出处 | 许可证 | 验证版本 |
|---|---|---|---|---|
| `dsh-boot-animation` | 开屏加载动画：点击进入、多片随机、进度可见、失败兜底 | [lxj5820/dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation) | MIT | 0.1.0 |
| `dsh-selfwake` | 「到点主动开口」：五道闸（随机间隔／安静／未回上限／静默时段／每日上限）过后注入「状态＋约束」，话由模型当场说 | [S3K926/dsh-selfwake](https://github.com/S3K926/dsh-selfwake) | MIT | 0.1.0 |
| `dsh-memory-board` | 设置页里的本地记忆面板：读、搜、追加、谨慎编辑一个基于文件的记忆档案 | [S3K926/dsh-memory-board](https://github.com/S3K926/dsh-memory-board) | MIT | 1.0.0 |
| `dsh-session-switch` | 会话切换（历史留存；**已被 [`S3K926/dsh-auto-handoff`](https://github.com/S3K926/dsh-auto-handoff) 取代**，两个别同时装） | [S3K926/dsh-session-switch](https://github.com/S3K926/dsh-session-switch) | MIT | 0.1.0 |

这一类的装法见 [`install.md`](install.md)：把源码目录放到 `$DSH_HOME/plugins/<包名>`，
再在 profile 里加 `link:` 依赖与 `bundles` 条目。

## 二、npm 型（`pnpm add` 即可）

| 包 | 用途 | 出处 | 许可证 | 验证版本 | 当前最新 |
|---|---|---|---|---|---|
| `dsh-whale-widget` | 界面右下角的余额小鲸鱼挂件：余额/今日用量/峰谷定价、气泡点击序列、自定义样式与音效 | [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) | MIT | 0.3.17 | 0.3.18 |
| `dsh-plugin-wallpaper-engine` | 用本机 Wallpaper Engine 壁纸当界面背景（Scene/Web 实时渲染、Video 直放）+ 液态玻璃质感 | [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) | MIT | 1.2.0 | 1.3.0 |
| `dsh-computer-use-win` | Windows 电脑控制（MCP + UI Automation）：读控件树、截图、输入、OCR、窗口管理 | [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) | MIT | 0.2.3 | 0.2.4 |
| `dsh-computer-use-vision` | 电脑控制「视觉系」：截图 → 外部视觉模型 → 模拟鼠标键盘，带自进化知识库 | [xuanyuanluoxue/computer-use-vision](https://github.com/xuanyuanluoxue/computer-use-vision) | MIT | 0.1.1 | 0.1.1 |
| `@bhzhangsun/dsh-computer-use` | 电脑控制（虚拟光标 + 视觉模型直读截图），提供 `screen_observe` 等一批工具 | [bhzhangsun/awesome-dsh](https://github.com/bhzhangsun/awesome-dsh) | MIT | 0.3.8 | 0.3.8 |
| `@linxin666/dsh-client-ui-skin-center` | 皮肤中心：皮肤是纯资源目录，支持试穿与一键应用（界面内切换，不重写配置文件） | [zhu1090093659/dsh-skins](https://github.com/zhu1090093659/dsh-skins) | Apache-2.0 | 0.4.4 | 0.4.5 |

装法（在 profile 目录里）：

```bash
pnpm add dsh-whale-widget
# 然后在 package.json 的 dsh.profile.bundles 里加上包名，再 pnpm install
```

> ⚠️ 有的包声明的 DSH peer 版本范围比较窄，装的时候会被「兼容闸门」拦下。
> 那是 DSH 的保护机制：确认你知道风险后再授予**精确版本豁免**，别为了装上就无脑跳过。

## 三、已知的坑（真机踩过，共享出来省钱）

| 现象 | 真正原因 | 处置 |
|---|---|---|
| 视觉系插件报「找不到脚本」 | 它的 `assetsDir()` 兜底分支与第一分支写成了同一个路径，资源实际在包根 `assets/` | 在包目录里建目录联接 `lib/assets -> assets`；**重装该包会冲掉，要重建** |
| 视觉系插件的 `.ps1` 报「字符串缺少终止符」 | 脚本是无 BOM 的 UTF-8，Windows PowerShell 5.1 按 GBK 解码 → 中文把语法炸掉 | 把 `assets/scripts/*.ps1` 全部改存为 **UTF-8 with BOM** |
| cua-driver 引导安装失败 | 上游只发 `.zip`，而插件 `bootstrapDirect` 把响应字节直接当 exe 落盘 | 手动下载 release 的 zip、校验 sha256 后解包，并关掉插件自更新 |
| 装了插件但工具没出现 | peer 不兼容被跳过，或没进 `bundles` | 看 DSH 启动输出里的 `skipping profile bundle ...` 原因行 |

## 四、想加进这份清单？

欢迎 PR —— 请附上：包名、真实仓库链接、许可证、一句话用途。
如果许可证不是 MIT/Apache-2.0 之类的宽松协议，请先说明再讨论。
