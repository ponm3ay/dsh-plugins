# 凭证与密钥规范

> 一句话：**仓库里只出现凭证的「名字」，永远不出现凭证的「值」。**

本文件是 `dsh-model-routing` 的强制规范。它同时回答三件事：
① 密钥该放哪；② 插件代码该怎么写；③ 万一泄露了怎么办。

---

## 1. 密钥放哪：三种合法位置

按推荐程度排序：

### ① 用户级环境变量（首选）

不落文件、不进任何同步盘、不会被 `git` 看见。

```powershell
# Windows：写入用户级环境变量（不进系统级，不需要管理员）
setx TOKENHUB_API_KEY "你的 key"
# ⚠️ setx 只对**之后新启动的进程**可见；已经在跑的 DSH 要重启才会继承

# 验证（只打印名字是否存在，不打印值）
[bool][Environment]::GetEnvironmentVariable('TOKENHUB_API_KEY','User')
```

```bash
# macOS / Linux
export TOKENHUB_API_KEY="你的 key"     # 建议放 ~/.config/dsh/secrets.env（600 权限）里 source
```

### ② DSH 凭证库

DSH 自己管理的凭证文件，位置 `$DSH_HOME/.credentials.yaml`；插件通过 `apiKeyEnv` 的名字引用。
这个文件 **不要**复制进任何工作区、同步盘或仓库。

```yaml
# $DSH_HOME/.credentials.yaml（示例结构，值请自己填）
refs:
  TOKENHUB_API_KEY: "<你的 key>"
```

### ③ 本地 `.env`（仅调试，最短命）

```bash
cp .env.example .env     # .env 已在 .gitignore 中
```

即便如此：**不要把 `.env` 建在被 OneDrive / iCloud / Dropbox 接管的目录里** ——
那等于把明文密钥同步上云。临时调试请放 `%TEMP%` 或 `$DSH_HOME` 下的私有目录。

---

## 2. 插件代码该怎么写

配置里只写**引用名**，运行时从环境变量/凭证库取：

```yaml
# cordis.patch.yml —— 正确 ✅
- id: my-plugin
  config:
    apiKeyEnv: TOKENHUB_API_KEY      # 只有名字
    baseURL: https://example.com/v1
```

```js
// entry.js —— 正确 ✅
const key = process.env[config.apiKeyEnv];
if (!key) throw new Error(`未找到凭证：请设置环境变量 ${config.apiKeyEnv}`);
```

**反例（一律拒收）**：

```js
const key = 'sk-abcdef0123456789';        // ❌ 硬编码
const key = config.apiKey ?? 'sk-...';    // ❌ 兜底里塞真值
console.log('key =', key);                // ❌ 打印密钥（日志同样算泄露）
```

补充约定：

- 报错信息里**只报变量名**，不要回显值（哪怕是前几位/后四位）。
- 不要把密钥拼进 URL 查询串——会进访问日志。
- 截图、演示链接、issue 正文、PR 描述里都不要出现 key。

---

## 3. 提交前自查

```powershell
pwsh -File scripts/verify-no-secrets.ps1
```

脚本扫描：`sk-` / `AKIA` / `ghp_` / `xox[baprs]-` / `-----BEGIN * PRIVATE KEY-----` /
`apiKey:` 后面直接跟长字符串 / 高熵长串等，并按 `.gitignore` 忽略目录跳过。

CI（[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)）会跑同一套规则，
所以本地跑一遍能省一次红灯。

建议再装一层本地钩子：

```bash
# .git/hooks/pre-commit
#!/bin/sh
pwsh -NoProfile -File scripts/verify-no-secrets.ps1 || exit 1
```

---

## 4. 泄露处置

> **删除 ≠ 消除。** 文件删了，值仍在：git 历史、云盘版本历史、回收站、别人 clone 的副本、日志。

一旦怀疑泄露，**按顺序**执行：

1. **先吊销**：到服务商后台把该 key 停用/删除。这一步最重要，做完泄露就止损了。
2. **再重签**：生成新 key，只放进环境变量或凭证库，不落仓库。
3. **再清理**：
   - 工作区里：从当前提交移除并提交；
   - 历史里：用 [`git filter-repo`](https://github.com/newren/git-filter-repo) 或
     [BFG](https://rtyley.github.io/bfg-repo-cleaner/) 重写历史，然后 `git push --force-with-lease`；
   - 让协作者重新 clone（旧 clone 里仍有旧历史）。
4. **再看一眼同步盘**：OneDrive/iCloud 有版本历史与回收站（约 30 天），
   只能靠**吊销**兜底 —— 这也是「密钥不要放同步目录」的原因。
5. **复盘**：把这次的教训写进 `CONTRIBUTING.md` 或本文件，避免同款再犯。

GitHub 平台侧还可以开：

- **Secret scanning** + **Push protection**（仓库 Settings → Code security）——推送时直接拦截；
- 分支保护：禁止直接推 `main`，必须过 CI。

---

## 5. CI 里的密钥怎么用

CI 需要真密钥时（一般不需要），用 **GitHub Repository Secrets**：

```yaml
- name: 冒烟测试
  env:
    TOKENHUB_API_KEY: ${{ secrets.TOKENHUB_API_KEY }}
  run: node plugins/xxx/smoke.mjs
```

- Secrets 不会出现在日志里（但**自己 print 就会**，所以代码里不要打印）。
- Fork 的 PR **拿不到** secrets —— 这是保护，不是 bug；需要真密钥的测试请跳过并标注。
- 本仓库的 CI 刻意**不需要任何密钥**：只做静态扫描与语法检查。

---

## 6. 检查表（贴到 PR 模板里用）

- [ ] 没有新增任何明文密钥 / token / 私钥
- [ ] 新增配置项一律用 `apiKeyEnv` 之类的**引用名**
- [ ] 报错与日志不回显密钥
- [ ] 文档、截图、示例里没有真实值
- [ ] `pwsh -File scripts/verify-no-secrets.ps1` 通过
- [ ] 没有把 `.env`、凭证库、私钥放进被云同步的目录
