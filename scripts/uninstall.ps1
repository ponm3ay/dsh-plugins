<#
.SYNOPSIS
    从本机 DSH profile 卸下 dsh-model-routing 的插件（卸载 / 回滚）。

.DESCRIPTION
    反向操作：从 dependencies 摘掉 link: 依赖 → 从 dsh.profile.bundles 摘掉条目 → pnpm install。
    **不动源码目录，也不动插件自己的数据目录**（那是你的数据，要清请自己确认后删）。

.PARAMETER Profile
    profile 名，桌面端默认 desktop。

.PARAMETER Plugin
    要卸下的插件名（可多个，写成包名）。省略则只列出当前已装的本仓库插件，不改任何文件。

.PARAMETER DshHome
    DSH 家目录，规则同 install.ps1。

.PARAMETER SkipInstall
    只改 manifest，不跑 pnpm install。

.EXAMPLE
    pwsh -File scripts/uninstall.ps1                                  # 先看看装了啥
    pwsh -File scripts/uninstall.ps1 -Plugin dsh-whale-backdrop       # 卸一个
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

function Write-Step([string]$t) { Write-Host "▸ $t" -ForegroundColor Cyan }
function Write-Ok([string]$t) { Write-Host "  ✓ $t" -ForegroundColor Green }
function Write-Warn2([string]$t) { Write-Host "  ! $t" -ForegroundColor Yellow }
function Fail([string]$t) { Write-Host "✗ $t" -ForegroundColor Red; exit 1 }

if (-not $DshHome) { $DshHome = $env:DSH_HOME }
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
$DshHome = (Resolve-Path -LiteralPath $DshHome -ErrorAction SilentlyContinue).Path
if (-not $DshHome) { Fail "找不到 DSH 家目录；用 -DshHome 指定" }

$profileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$manifest = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifest)) { Fail "profile 不存在：$profileDir" }

# 本仓库的插件名
$owned = @()
foreach ($dir in Get-ChildItem -LiteralPath $pluginsRoot -Directory) {
    $pkgFile = Join-Path $dir.FullName 'package.json'
    if (Test-Path -LiteralPath $pkgFile) {
        try { $owned += (Get-Content -LiteralPath $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json).name } catch { }
    }
}

$current = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$installed = @()
foreach ($n in $owned) {
    if ($current.dependencies.PSObject.Properties.Name -contains $n) { $installed += $n }
}

Write-Step "profile：$profileDir"
Write-Host "  本仓库当前已装：$(if ($installed) { $installed -join ', ' } else { '（无）' })"

if (-not $Plugin) {
    Write-Host ""
    Write-Host "没有指定 -Plugin，仅列出，不做改动。" -ForegroundColor Yellow
    Write-Host "用法：pwsh -File scripts/uninstall.ps1 -Plugin $($owned -join ' -Plugin ')"
    exit 0
}

$targets = @()
foreach ($want in $Plugin) {
    if ($installed -notcontains $want) { Write-Warn2 "$want 未安装，跳过" ; continue }
    $targets += $want
}
if ($targets.Count -eq 0) { Fail "没有可卸的目标" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Write-Step "备份（后缀 .bak-$stamp）"
foreach ($name in 'package.json', 'cordis.patch.yml', 'pnpm-lock.yaml') {
    $src = Join-Path $profileDir $name
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination "$src.bak-$stamp" -Force }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    foreach ($c in (Get-ChildItem -LiteralPath (Join-Path $DshHome 'dsh-runtimes') -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1)) { $node = $c.FullName }
}
if (-not $node) { Fail "找不到 node" }

$script = Join-Path ([IO.Path]::GetTempPath()) ("dsh-model-routing-unpatch-{0}.mjs" -f $stamp)
$code = @'
import fs from 'node:fs';
const [manifestPath, namesCsv] = process.argv.slice(2);
const names = String(namesCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
// 容错：Windows 上别的工具可能写出带 BOM 的 package.json
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
const removed = [];
for (const name of names) {
  if (m.dependencies && Object.hasOwn(m.dependencies, name)) {
    // 只摘本仓库的 link: 依赖，避免误删别人装的东西
    if (String(m.dependencies[name]).startsWith('link:')) {
      delete m.dependencies[name];
      removed.push(`dependencies -= ${name}`);
    } else {
      removed.push(`保留 ${name}（不是 link: 依赖，未动）`);
      continue;
    }
  }
  const bundles = m.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) {
    const i = bundles.indexOf(name);
    if (i >= 0) { bundles.splice(i, 1); removed.push(`bundles -= ${name}`); }
  }
}
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
console.log(removed.join('\n') || '(无改动)');
'@
Set-Content -LiteralPath $script -Value $code -Encoding UTF8

Write-Step "更新 profile manifest"
& $node $script $manifest ($targets -join ',')
if ($LASTEXITCODE -ne 0) { Fail "改 manifest 失败" }
Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue

if ($SkipInstall) {
    Write-Warn2 "已跳过 pnpm install：记得手动跑一次，节点链接才会摘掉"
} else {
    $pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
    $invoker = $pnpm
    $pnpmArgList = @()
    if (-not $pnpm) {
        $resources = $null
        $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like '*DeepSeek*' } | Select-Object -First 1
        if ($proc) { $resources = Split-Path -Parent $proc.Path }
        if ($resources) {
            $cand = Join-Path $resources 'resources\runtime\pnpm\bin\pnpm.mjs'
            if (Test-Path -LiteralPath $cand) { $invoker = $node; $pnpmArgList = @('--expose-internals', $cand) }
        }
    }
    if (-not $invoker) {
        Write-Warn2 "找不到 pnpm；请手动执行：cd `"$profileDir`"; pnpm install"
    } else {
        Push-Location $profileDir
        try {
            & $invoker @pnpmArgList install
            if ($LASTEXITCODE -ne 0) { Write-Warn2 "pnpm install 退出码 $LASTEXITCODE（偶发 EPERM，重跑即可）" } else { Write-Ok "依赖已更新" }
        } finally { Pop-Location }
    }
}

Write-Host ""
Write-Host "已卸下：$($targets -join ', ')" -ForegroundColor Green
Write-Host "提示：源码目录与插件自己的数据目录都原样保留，需要清理请自行确认后删除。"
Write-Host "回滚：把 *.bak-$stamp 覆盖回原文件，再跑一次 pnpm install。"
