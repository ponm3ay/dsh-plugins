# dsh-plugins

[![CI](https://github.com/ponm3ay/dsh-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/ponm3ay/dsh-plugins/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A collection of plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).**

本仓库收录「大肥鱼」为 DSH 写的插件（本地插件源码 + 安装/回滚脚本 + 第三方插件清单）。
每个插件都能单独安装、单独卸载，**不改 DSH 本体源码**。

- 🧩 自研插件源码 → [`plugins/`](plugins/)
- 🔐 凭证与密钥规范 → [`docs/credentials.md`](docs/credentials.md)
- 📦 第三方插件清单（不打包，只给出处与安装命令）→ [`docs/third-party-plugins.md`](docs/third-party-plugins.md)
- 🛠 安装 / 卸载 / 回滚 → [`docs/install.md`](docs/install.md)

---

## 插件一览

| 插件 | 一句话 | 形态 | 版本 |
|---|---|---|---|
| [`dsh-subagent-usage`](plugins/dsh-subagent-usage/) | 在对话里显示本轮**实际用的模型 / 推理等级 / token 消耗**，子代理会话尤其好用 | Host + Client | 0.1.0 |
| [`dsh-whale-memory`](plugins/dsh-whale-memory/) | **长期记忆**：自动捕获会话流水、自动注入记忆摘要、会话结束自动用便宜模型压缩成摘要 | Host | 0.1.0 |
| [`dsh-whale-backdrop`](plugins/dsh-whale-backdrop/) | 给界面铺一张**背景画** + 面板半透明，每次刷新随机换图 | Host + Client | 0.1.0 |

> 三个插件都遵循同一条设计约束：**只做加法**。注册自己的服务、路由、样式与钩子，卸载即还原，
> 不修改 DSH 本体的任何文件。

---

## 快速开始

前置：已经装好 DSH（桌面端或 CLI），并且知道自己的 profile 目录。

```bash
# 1) 取得源码
git clone https://github.com/ponm3ay/dsh-plugins.git
cd dsh-plugins

# 2) 安装（自动找 $DSH_HOME/profiles/<profile> 并挂载本地插件）
pwsh -File scripts/install.ps1 -Profile desktop          # Windows
# bash scripts/install.sh -p desktop                     # macOS / Linux

# 3) 重启 DSH（或刷新页面）后生效
```

只想装某一个插件：

```bash
pwsh -File scripts/install.ps1 -Profile desktop -Plugin dsh-subagent-usage
```

手动安装的原理与每一步细节（含回滚）见 [`docs/install.md`](docs/install.md)。

---

## 凭证与密钥

**这个仓库里没有任何密钥，将来也不会有。** 所有插件都遵守同一条规矩：

> 配置文件里只写**凭证的名字**（`apiKeyEnv: MY_API_KEY`），
> 真值只存在于 **用户级环境变量** 或 **DSH 凭证库**（`$DSH_HOME/.credentials.yaml`）。

```yaml
# 正确：仓库里是引用名
config:
  apiKeyEnv: TOKENHUB_API_KEY      # 真值在环境变量/凭证库里
```

```yaml
# 错误：真值进了文件，一提交就泄露
config:
  apiKey: sk-xxxxxxxxxxxxxxxx
```

要点：

1. 复制 [`.env.example`](.env.example) 得到本地 `.env` 时，`.env` 已被 `.gitignore` 排除；
   但**更推荐**直接用 `setx`（Windows）或 `export`（*nix）设置用户级环境变量——不落文件、不参与同步。
2. 密钥**不要**放进任何会被云同步的目录（OneDrive / iCloud / Dropbox 覆盖的桌面、文档、图片）。
3. `提交前先自查`：`pwsh -File scripts/verify-no-secrets.ps1`（CI 也会跑同一套规则）。
4. 一旦密钥进过 git 历史或同步盘：**吊销并重新签发**，删文件不算处置。

完整规范、泄露处置流程、CI 配置见 [`docs/credentials.md`](docs/credentials.md)。

---

## 仓库结构

```
dsh-plugins/
├── plugins/                    # 自研插件源码，一个目录一个插件
│   ├── dsh-subagent-usage/
│   ├── dsh-whale-memory/
│   └── dsh-whale-backdrop/
├── docs/
│   ├── credentials.md          # 凭证与密钥规范
│   ├── install.md              # 安装 / 卸载 / 回滚
│   └── third-party-plugins.md  # 第三方插件清单与出处
├── scripts/
│   ├── install.ps1  install.sh # 安装脚本
│   ├── uninstall.ps1           # 卸载 / 回滚
│   └── verify-no-secrets.ps1   # 密钥自查（CI 同款）
├── .github/workflows/ci.yml    # 密钥扫描 + 语法检查
├── .env.example                # 环境变量样板（占位符）
└── SECURITY.md  CONTRIBUTING.md  CHANGELOG.md  LICENSE
```

---

## 插件是怎么被 DSH 加载的（30 秒版）

DSH 的 profile 是一个 pnpm 项目：`$DSH_HOME/profiles/<profile>/`。

1. `package.json` 的 `dependencies` 里挂上插件包（本地插件用 `link:<绝对路径>`）；
2. `package.json` 的 `dsh.profile.bundles` 里列出要激活的插件；
3. **bundle 型**插件自带 `dsh.bundle.patch`（`cordis.patch.yml`），被列出后自动挂载，改完免重启热生效；
4. **非 bundle 型**插件要在 profile 的 `cordis.patch.yml` 里手写一行 `- insert: { id, name }` 才会激活。

本仓库的插件都是 bundle 型，装完刷新页面即生效。

---

## 开发

插件是普通的 ESM（Node ≥ 22.19 或 ≥ 24）。带浏览器半边的插件用自带的构建脚本产出 `lib/client.js`：

```bash
node plugins/dsh-subagent-usage/build-client.mjs      # src/client.js -> lib/client.js
```

自测脚本：

```bash
node plugins/dsh-subagent-usage/verify/fold-test.mjs
node plugins/dsh-subagent-usage/verify/client-test.mjs
node plugins/dsh-whale-backdrop/build-client.mjs
pwsh -File scripts/verify-no-secrets.ps1              # 提交前必跑
```

改代码免重启生效的小技巧（DSH 的模块缓存按 URL 记）：**同时改文件名与 patch 行 id**。
详见各插件 README。

---

## 第三方插件

DSH 生态里好用的插件不止这些。本仓库**不打包**别人的作品（版权与上游维护归原作者），
而是在 [`docs/third-party-plugins.md`](docs/third-party-plugins.md) 里维护一份清单：
包名、用途、出处仓库、许可证、安装命令。

---

## 安全

发现安全问题请按 [`SECURITY.md`](SECURITY.md) 私下报告，不要开公开 issue。

## 贡献

欢迎 PR。提交前请读 [`CONTRIBUTING.md`](CONTRIBUTING.md)——最重要的一条：
**不要提交任何密钥、token、真实路径或个人信息。**

## 许可

[MIT](LICENSE) © 2026 ponm3ay

---

<sub>本仓库里的插件都是「大肥鱼」给自己造的零件：注释里留着它的口径、踩过的坑和当时的账。
如果你也住在 DSH 里，欢迎拿去用。</sub>
