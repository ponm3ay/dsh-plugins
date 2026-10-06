<#
.SYNOPSIS
    把 dsh-plugins 里的插件安装到本机 DSH profile。

.DESCRIPTION
    做四件事：备份 → 挂 link: 依赖 → 加进 dsh.profile.bundles → 跑 pnpm install。
    改的是 DSH 的 profile 目录（$DSH_HOME/profiles/<profile>），**不改本仓库、不改 DSH 本体**。

.PARAMETER Profile
    profile 名，桌面端默认 desktop。

.PARAMETER Plugin
    只装指定插件（可多个）。省略则装本仓库 plugins/ 下的全部。

.PARAMETER DshHome
    DSH 家目录。省略时依次取 $env:DSH_HOME、$env:USERPROFILE\.dsh、~/.dsh。

.PARAMETER SkipInstall
    只改 package.json，不跑 pnpm install（离线或想自己跑时用）。

.EXAMPLE
    pwsh -File scripts/install.ps1
    pwsh -File scripts/install.ps1 -Profile desktop -Plugin dsh-subagent-usage
    pwsh -File scripts/install.ps1 -DshHome 'D:\.dsh'
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [string[]]$Plugin,
    [string]$DshHome,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginsRoot = Join-Path $repoRoot 'plugins'

function Write-Step([string]$text) { Write-Host "▸ $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "  ✓ $text" -ForegroundColor Green }
function Write-Warn2([string]$text) { Write-Host "  ! $text" -ForegroundColor Yellow }
function Fail([string]$text) { Write-Host "✗ $text" -ForegroundColor Red; exit 1 }

# ── 1. 定位 DSH 家目录与 profile ─────────────────────────────────────────
if (-not $DshHome) { $DshHome = $env:DSH_HOME }
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
$DshHome = (Resolve-Path -LiteralPath $DshHome -ErrorAction SilentlyContinue).Path
if (-not $DshHome) { Fail "找不到 DSH 家目录；用 -DshHome 明确指定（例如 -DshHome 'D:\.dsh'）" }

$profileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$manifest = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifest)) {
    Fail "profile 不存在：$profileDir（先确认 -Profile 名字；可用 Get-ChildItem '$DshHome\profiles' 查看）"
}
Write-Step "DSH 家目录：$DshHome"
Write-Ok "profile：$profileDir"

# ── 2. 决定要装哪些插件 ─────────────────────────────────────────────────
$available = @()
foreach ($dir in Get-ChildItem -LiteralPath $pluginsRoot -Directory) {
    $pkgFile = Join-Path $dir.FullName 'package.json'
    if (-not (Test-Path -LiteralPath $pkgFile)) { continue }
    try { $meta = Get-Content -LiteralPath $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
    $available += [pscustomobject]@{ Name = $meta.name; Dir = $dir.FullName }
}
if ($available.Count -eq 0) { Fail "本仓库 plugins/ 下没找到任何插件" }

if ($Plugin) {
    $selected = @()
    foreach ($want in $Plugin) {
        $hit = $available | Where-Object { $_.Name -eq $want -or (Split-Path $_.Dir -Leaf) -eq $want }
        if (-not $hit) { Fail "仓库里没有插件：$want（可选：$($available.Name -join ', ')）" }
        $selected += $hit
    }
} else {
    $selected = $available
}

Write-Step "准备安装 $($selected.Count) 个插件："
$selected | ForEach-Object { Write-Ok $_.Name }

# ── 3. 备份 ────────────────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Write-Step "备份 profile 配置（后缀 .bak-$stamp）"
foreach ($name in 'package.json', 'cordis.patch.yml', 'pnpm-lock.yaml') {
    $src = Join-Path $profileDir $name
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination "$src.bak-$stamp" -Force
        Write-Ok "$name → $name.bak-$stamp"
    }
}

# ── 4. 用 node 改 manifest（保序、2 空格缩进）────────────────────────────
$node = $null
foreach ($cand in (Get-ChildItem -LiteralPath (Join-Path $DshHome 'dsh-runtimes') -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    $node = $cand.FullName
}
if (-not $node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
    # 非 Windows：名字不带 .exe
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
}
if (-not $node) { Fail "找不到 node（插件是 ESM，改 manifest 与装依赖都要它）" }
Write-Ok "node：$node"

$patchScript = Join-Path ([IO.Path]::GetTempPath()) ("dsh-plugins-patch-{0}.mjs" -f $stamp)
# 注意：不在这里手工拼 JSON —— PowerShell 5.1 的 ConvertTo-Json 对 PSCustomObject
# 会输出不带引号的属性名（node 直接 JSON.parse 会炸）。交给 node 自己扫目录。
$filterCsv = ($Plugin -join ',')
$patchCode = @'
import fs from 'node:fs';
import path from 'node:path';

const [manifestPath, pluginsRoot, filterCsv] = process.argv.slice(2);
const filter = filterCsv ? filterCsv.split(',').map((s) => s.trim()).filter(Boolean) : null;

function discover(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgFile = path.join(root, entry.name, 'package.json');
    if (!fs.existsSync(pkgFile)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      out.push({ name: meta.name, dir: path.join(root, entry.name).replace(/\\/g, '/') });
    } catch { /* 坏掉的 package.json 直接跳过 */ }
  }
  return out;
}

const available = discover(pluginsRoot);
const wanted = filter
  ? available.filter((p) => filter.includes(p.name) || filter.includes(path.basename(p.dir)))
  : available;
if (filter && wanted.length !== filter.length) {
  const missing = filter.filter((f) => !wanted.some((w) => w.name === f || path.basename(w.dir) === f));
  console.error(`找不到插件：${missing.join(', ')}；可选：${available.map((a) => a.name).join(', ')}`);
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
manifest.dependencies = manifest.dependencies || {};
manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || {};
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];

const changed = [];
for (const { name, dir } of wanted) {
  const spec = `link:${dir}`;
  if (manifest.dependencies[name] !== spec) {
    manifest.dependencies[name] = spec;
    changed.push(`dependencies += ${name} -> ${spec}`);
  }
  if (!bundles.includes(name)) {
    bundles.push(name);
    changed.push(`bundles += ${name}`);
  }
}

// 依赖按名字排序，保持文件可读、diff 稳定
const sorted = {};
for (const key of Object.keys(manifest.dependencies).sort()) sorted[key] = manifest.dependencies[key];
manifest.dependencies = sorted;
manifest.dsh.profile.bundles = bundles;

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(changed.length ? changed.join('\n') : '(manifest 已是最新，无需改动)');
'@
Set-Content -LiteralPath $patchScript -Value $patchCode -Encoding UTF8

Write-Step "写入 profile manifest"
& $node $patchScript $manifest $pluginsRoot $filterCsv
if ($LASTEXITCODE -ne 0) { Fail "改 manifest 失败（退出码 $LASTEXITCODE）" }
Remove-Item -LiteralPath $patchScript -Force -ErrorAction SilentlyContinue

# ── 5. pnpm install ────────────────────────────────────────────────────
if ($SkipInstall) {
    Write-Warn2 "已跳过 pnpm install（-SkipInstall）：记得自己跑一次，插件才会挂上"
} else {
    $pnpmInvoker = $null
    $pnpmArgs = @()

    $sysPnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($sysPnpm) {
        $pnpmInvoker = $sysPnpm.Source
    } else {
        # 找 DSH 自带的 pnpm.mjs：先看运行中的 DSH 进程，再看常见安装路径
        $resources = $null
        $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like '*DeepSeek*' } | Select-Object -First 1
        if ($proc) { $resources = Split-Path -Parent $proc.Path }
        if (-not $resources -and $env:DSH_RESOURCES) { $resources = $env:DSH_RESOURCES }
        if ($resources) {
            $candidate = Join-Path $resources 'resources\runtime\pnpm\bin\pnpm.mjs'
            if (Test-Path -LiteralPath $candidate) {
                $pnpmInvoker = $node
                $pnpmArgs += @('--expose-internals', $candidate)
            }
        }
    }

    if (-not $pnpmInvoker) {
        Write-Warn2 "找不到 pnpm（系统 PATH 里没有，也没认出 DSH 自带的）。"
        Write-Warn2 "manifest 已经改好，请手动执行一次："
        Write-Host "     cd `"$profileDir`"; pnpm install" -ForegroundColor White
    } else {
        Write-Step "pnpm install（在 $profileDir）"
        Push-Location $profileDir
        try {
            & $pnpmInvoker @pnpmArgs install
            if ($LASTEXITCODE -ne 0) { Write-Warn2 "pnpm install 退出码 $LASTEXITCODE；可以重跑一次（Windows 上偶发 EPERM 抢文件）" }
            else { Write-Ok "依赖装好" }
        } finally {
            Pop-Location
        }
    }
}

Write-Host ""
Write-Host "完成。刷新 DSH 页面即生效（bundle 型插件免重启）。" -ForegroundColor Green
Write-Host "回滚：把 $profileDir 下的 *.bak-$stamp 覆盖回原文件，再跑一次 pnpm install。"
Write-Host "卸下某个插件：pwsh -File scripts/uninstall.ps1 -Profile $Profile -Plugin <名字>"
