#!/usr/bin/env bash
# dsh-plugins · 安装脚本（macOS / Linux）
#
#   bash scripts/install.sh -p desktop
#   bash scripts/install.sh -p desktop --plugin dsh-subagent-usage
#   bash scripts/install.sh -p desktop -d "$HOME/.dsh" --skip-install
#
# 做的事：备份 → 挂 link: 依赖 → 加进 dsh.profile.bundles → pnpm install。
# 只改 DSH 的 profile 目录，不动本仓库、不动 DSH 本体。
set -euo pipefail

PROFILE="desktop"
PLUGIN=""
DSH_HOME_ARG=""
SKIP_INSTALL=0

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--profile)     PROFILE="${2:?缺 profile 名}"; shift 2 ;;
    --plugin)         PLUGIN="${2:?缺插件名}"; shift 2 ;;
    -d|--dsh-home)    DSH_HOME_ARG="${2:?缺家目录}"; shift 2 ;;
    --skip-install)   SKIP_INSTALL=1; shift ;;
    -h|--help)        usage 0 ;;
    *) echo "未知参数：$1" >&2; usage 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGINS_ROOT="$REPO_ROOT/plugins"

step()  { printf '\033[36m▸ %s\033[0m\n' "$1"; }
ok()    { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
warn()  { printf '\033[33m  ! %s\033[0m\n' "$1"; }
fail()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

DSH_HOME="${DSH_HOME_ARG:-${DSH_HOME:-$HOME/.dsh}}"
[ -d "$DSH_HOME" ] || fail "找不到 DSH 家目录：$DSH_HOME（用 -d 指定）"
DSH_HOME="$(cd "$DSH_HOME" && pwd)"

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"
[ -f "$MANIFEST" ] || fail "profile 不存在：$PROFILE_DIR"

step "DSH 家目录：$DSH_HOME"
ok "profile：$PROFILE_DIR"

command -v node >/dev/null 2>&1 || fail "找不到 node（插件是 ESM，改 manifest 与装依赖都要它）"

# 收集仓库里的插件
AVAILABLE=""
for d in "$PLUGINS_ROOT"/*/; do
  [ -f "${d}package.json" ] || continue
  name="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).name)" "${d}package.json")"
  AVAILABLE="$AVAILABLE$name|${d%/}"$'\n'
done
[ -n "$AVAILABLE" ] || fail "本仓库 plugins/ 下没找到任何插件"

SELECTED=""
if [ -n "$PLUGIN" ]; then
  line="$(printf '%s' "$AVAILABLE" | grep -E "^${PLUGIN}\|" || true)"
  [ -n "$line" ] || fail "仓库里没有插件：$PLUGIN"
  SELECTED="$line"
else
  SELECTED="$(printf '%s' "$AVAILABLE" | sed '/^$/d')"
fi

step "准备安装以下插件："
printf '%s\n' "$SELECTED" | while IFS='|' read -r n _; do ok "$n"; done

STAMP="$(date +%Y%m%d-%H%M%S)"
step "备份 profile 配置（后缀 .bak-$STAMP）"
for f in package.json cordis.patch.yml pnpm-lock.yaml; do
  [ -f "$PROFILE_DIR/$f" ] && cp "$PROFILE_DIR/$f" "$PROFILE_DIR/$f.bak-$STAMP" && ok "$f"
done

step "写入 profile manifest"
PAYLOAD="$(printf '%s\n' "$SELECTED" | sed '/^$/d' | node -e '
let raw = ""; process.stdin.on("data", d => raw += d).on("end", () => {
  const list = raw.split("\n").filter(Boolean).map(l => { const [name, dir] = l.split("|"); return { name, dir }; });
  process.stdout.write(JSON.stringify(list));
});')"

node - "$MANIFEST" "$PAYLOAD" <<'EOF'
import fs from 'node:fs';
const [manifestPath, payloadJson] = process.argv.slice(2);
const wanted = JSON.parse(payloadJson);
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
m.dependencies = m.dependencies || {};
m.dsh = m.dsh || {};
m.dsh.profile = m.dsh.profile || {};
const bundles = Array.isArray(m.dsh.profile.bundles) ? m.dsh.profile.bundles : [];
const changed = [];
for (const { name, dir } of wanted) {
  const spec = 'link:' + dir;
  if (m.dependencies[name] !== spec) { m.dependencies[name] = spec; changed.push('dependencies += ' + name); }
  if (!bundles.includes(name)) { bundles.push(name); changed.push('bundles += ' + name); }
}
const sorted = {};
for (const k of Object.keys(m.dependencies).sort()) sorted[k] = m.dependencies[k];
m.dependencies = sorted;
m.dsh.profile.bundles = bundles;
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
console.log(changed.length ? changed.join('\n') : '(manifest 已是最新，无需改动)');
EOF

if [ "$SKIP_INSTALL" = "1" ]; then
  warn "已跳过 pnpm install（--skip-install）：记得自己跑一次"
else
  step "pnpm install"
  if command -v pnpm >/dev/null 2>&1; then
    (cd "$PROFILE_DIR" && pnpm install) || warn "pnpm install 退出码非 0，可重跑一次"
  else
    warn "PATH 里没有 pnpm。manifest 已改好，请手动执行：cd \"$PROFILE_DIR\" && pnpm install"
  fi
fi

echo
printf '\033[32m完成。刷新 DSH 页面即生效（bundle 型插件免重启）。\033[0m\n'
echo "回滚：把 profile 目录下的 *.bak-$STAMP 覆盖回原文件，再跑一次 pnpm install。"
