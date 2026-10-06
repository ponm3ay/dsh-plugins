# 安装 / 卸载 / 回滚

本仓库的插件都以「**本地插件**」形式安装：源码留在你 clone 下来的目录里，
DSH 的 profile 用 `link:` 依赖指向它。**不发布到 npm，也不需要发布。**

---

## 0. 前置

| 项 | 说明 |
|---|---|
| DSH | 桌面端或 CLI 任一（`dsh --version` 能跑） |
| Node | ≥ 22.19 或 ≥ 24（插件是 ESM） |
| pnpm | DSH 自带一份，也可以用系统 pnpm |
| profile 目录 | `$DSH_HOME/profiles/<profile>`，桌面端默认叫 `desktop` |

`$DSH_HOME` 就是 DSH 的家目录（Windows 常见 `D:\.dsh` 或 `%USERPROFILE%\.dsh`，
macOS/Linux 常见 `~/.dsh`）。**不确定就用 DSH 的插件页看一眼路径**。

> ⚠️ 改 profile 之前先备份这三个文件：`package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`。
> 脚本会自动备份（`*.bak-<时间戳>`）。

---

## 1. 一键安装

```powershell
# Windows（在 clone 下来的 dsh-model-routing 目录里）
pwsh -File scripts/install.ps1 -Profile desktop
# 只装一个
pwsh -File scripts/install.ps1 -Profile desktop -Plugin dsh-subagent-usage
# 指定家目录（DSH_HOME 没设或想装到别处时）
pwsh -File scripts/install.ps1 -Profile desktop -DshHome 'D:\.dsh'
```

```bash
# macOS / Linux
bash scripts/install.sh -p desktop
bash scripts/install.sh -p desktop --plugin dsh-whale-memory
```

脚本做四件事：备份 → 把插件加进 `dependencies`（`link:` 绝对路径）→ 加进
`dsh.profile.bundles` → 跑一次 `pnpm install`。做完**刷新页面**即生效（bundle 型免重启）。

---

## 2. 手动安装（脚本做了啥）

```bash
cd "$DSH_HOME/profiles/desktop"          # Windows: cd D:\.dsh\profiles\desktop
```

### ① 备份

```bash
cp package.json package.json.bak-$(date +%Y%m%d-%H%M%S)
cp cordis.patch.yml cordis.patch.yml.bak-$(date +%Y%m%d-%H%M%S)
cp pnpm-lock.yaml pnpm-lock.yaml.bak-$(date +%Y%m%d-%H%M%S)
```

### ② 挂依赖 + 激活

编辑 `package.json`：

```json
{
  "dependencies": {
    "dsh-subagent-usage": "link:D:/path/to/dsh-model-routing/plugins/dsh-subagent-usage"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-subagent-usage"
      ]
    }
  }
}
```

要点：

- `link:` 后面是**绝对路径**；Windows 用正斜杠或双反斜杠。
- 必须在 `dsh.profile.bundles` 里列出，否则插件只是普通依赖、**不会激活**。

### ③ 装依赖

```bash
# 用 DSH 自带的 pnpm（推荐，版本一致）
node --expose-internals "$DSH_RESOURCES/runtime/pnpm/bin/pnpm.mjs" install
# 或者：pnpm install
```

装完 `node_modules/<插件名>` 会是指向源码目录的链接/junction。

### ④ 生效

bundle 型插件会用它自带的 `cordis.patch.yml` 自动挂载：**刷新页面即生效**。
非 bundle 型（少见）需要在 profile 的 `cordis.patch.yml` 里手写一行：

```yaml
- insert:
    - id: my-plugin
      name: my-plugin
```

改完 patch，HMR 会重新组合加载树（实测：改 patch 文件即热生效）。

---

## 3. 卸载

```powershell
pwsh -File scripts/uninstall.ps1 -Profile desktop -Plugin dsh-whale-backdrop
```

脚本会：从 `bundles` 与 `dependencies` 里摘掉 → 跑 `pnpm install` → 保留源码目录不动。
默认还会先备份。

手动版就是反向操作：删掉 `dependencies` 那一行与 `bundles` 里那一项，然后 `pnpm install`。

> 插件自己的状态目录（例如 `dsh-whale-memory` 的 `memory/`）**不会**被卸载删掉——
> 那是你的数据。要清就自己确认后手动删。

---

## 4. 回滚

三步以内回滚到安装前：

```bash
cd "$DSH_HOME/profiles/desktop"
cp package.json.bak-<时间戳>      package.json
cp cordis.patch.yml.bak-<时间戳>  cordis.patch.yml
cp pnpm-lock.yaml.bak-<时间戳>    pnpm-lock.yaml
node --expose-internals "<DSH 的 pnpm.mjs>" install
```

然后在 DSH 里刷新页面；仍是坏的就把 DSH 完全退出重开。

---

## 5. 排障

| 症状 | 原因 | 处置 |
|---|---|---|
| 插件没出现在设置页 | 没进 `dsh.profile.bundles` | 补上那一项，重跑 `pnpm install`，刷新 |
| 报 `peerDependencies` 不兼容 | 插件声明的 DSH 版本范围与运行时不一致 | 升级插件，或在插件页/CLI 里授予**精确版本豁免**（知道自己担什么风险） |
| 改了代码不生效 | DSH 按 URL 缓存 ES 模块 | **同时改文件名与 patch 行 id**，或重启 DSH |
| 报 `cannot resolve profile bundle` | `link:` 路径不对 / 依赖没装 | 检查路径与 `node_modules/<插件>` 是否存在 |
| 装了但工具没出现 | 插件激活失败 | 看 DSH 启动输出里的 `skipping profile bundle ...: <原因>` |
| 页面样式残留 | 卸载时没还原令牌 | 刷新页面；仍残留就退回备份并反馈 issue |

Windows 上偶尔会遇到 `EPERM: rename ... package.json` —— pnpm 与编辑器抢文件，**重试即过**。
