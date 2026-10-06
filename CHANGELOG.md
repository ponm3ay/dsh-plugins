# 更新日志

本文件记录本仓库**仓库级**的变化（新增插件、脚本、文档）。
单个插件内部的详细变更记录在各插件的 `README.md` 里。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] — 2026-10-06

首个公开版本。

### Added

- `plugins/dsh-subagent-usage` — 会话内显示实际模型 / 推理等级 / token 消耗（含子代理进度芯片与每轮明细行）。
- `plugins/dsh-whale-memory` — 长期记忆：会话流水捕获（JSONL）、系统提示词注入、会话结束自动摘要。
- `plugins/dsh-whale-backdrop` — 界面背景画 + 面板半透明，刷新随机换图。
- `docs/credentials.md` — 凭证与密钥规范（环境变量 / 凭证库 / 泄露处置）。
- `docs/install.md` — 安装、卸载、回滚。
- `docs/third-party-plugins.md` — 第三方插件清单与出处。
- `scripts/install.ps1` / `scripts/install.sh` — 一键安装。
- `scripts/uninstall.ps1` — 卸载 / 回滚（含备份）。
- `scripts/verify-no-secrets.ps1` — 提交前密钥自查，CI 同款。
- `.github/workflows/ci.yml` — 密钥扫描 + ESM 语法检查。

[Unreleased]: https://github.com/ponm3ay/dsh-plugins/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ponm3ay/dsh-plugins/releases/tag/v0.1.0
