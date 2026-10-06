# 贡献指南

感谢愿意一起折腾 DSH 插件。

## 三条硬规矩

1. **不要提交密钥。** 提交前跑一次：

   ```powershell
   pwsh -File scripts/verify-no-secrets.ps1
   ```

   CI 会跑同一套规则；命中真实密钥的 PR 会被直接关闭，并请相关方**吊销重签**。
2. **不要提交个人路径与个人信息。** 文档与代码里用 `$DSH_HOME`、`<profile>` 这类占位，
   不要写本机绝对路径（盘符或家目录开头的用户目录）、真实用户名、邮箱、聊天记录、截图里的私人内容。
3. **只做加法。** 插件不得修改 DSH 本体源码；卸载后必须能完全还原（样式/令牌/定时器/路由一起回收）。

## 提交流程

```bash
git checkout -b feat/<short-name>
# 改代码……
node plugins/<plugin>/build-client.mjs      # 有浏览器半边时重新构建 lib/client.js
pwsh -File scripts/verify-no-secrets.ps1    # 必跑
git commit -m "feat(<plugin>): <一句话>"
```

- 提交信息用 `<type>(<scope>): <subject>`，type 取 `feat|fix|docs|chore|refactor`。
- 一个 PR 只做一件事；带浏览器半边的改动请附上「改前/改后」截图或文字描述。
- 新增插件请放在 `plugins/<包名>/`，并补齐 `package.json` 元数据
  （`license`、`dsh.bundle.patch`）与 `README.md`。

## 新增一个插件的检查表

- [ ] `plugins/<name>/package.json`：`name` / `version` / `description` / `license` / `type: module`
- [ ] 是 bundle 型的话：`dsh.bundle.patch` 指向自带的 `cordis.patch.yml`
- [ ] 有浏览器半边的话：`dsh.client.platform: web`，且 `lib/client.js` 与 `src/client.js` 同步
- [ ] `README.md`：安装、卸载、配置、已知坑
- [ ] 在根 `README.md` 的插件表里加一行
- [ ] 在 `CHANGELOG.md` 的 `Unreleased` 下记一笔
- [ ] `scripts/verify-no-secrets.ps1` 通过

## 代码风格

- ESM，Node ≥ 22.19 或 ≥ 24。
- 注释写「为什么」，不写「做了什么」；踩过的坑请留在代码里（这是本仓库的传统）。
- 不动别人的文件；跨插件共享的逻辑请复制而不是互相 import（插件要能单独安装）。

## 许可

贡献即表示同意以 [MIT](LICENSE) 授权。
