<#
.SYNOPSIS
    站内密钥自查：扫描仓库里是否混进了真实凭证。

.DESCRIPTION
    按规则表扫描文本文件，命中即报「文件:行号 + 规则名」，
    **绝不回显命中的内容**（回显本身就是二次泄露）。

    退出码：0 = 干净；1 = 有命中；2 = 参数/环境错误。
    跨平台：Windows PowerShell 5.1 与 PowerShell 7 均可运行；CI 用 pwsh。

.PARAMETER Root
    要扫描的根目录，默认脚本所在仓库的根。

.PARAMETER IncludeIgnoreFile
    同时扫描 .gitignore 里被忽略的文件（默认跳过：那些文件按定义不该在那里）。

.EXAMPLE
    pwsh -File scripts/verify-no-secrets.ps1
    pwsh -File scripts/verify-no-secrets.ps1 -Root . -Verbose
#>
[CmdletBinding()]
param(
    [string]$Root,
    [switch]$IncludeIgnoreFile
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
    $Root = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path -LiteralPath $Root)) {
    Write-Error "找不到扫描根目录：$Root"
    exit 2
}
$Root = (Resolve-Path -LiteralPath $Root).Path

# ── 规则表 ────────────────────────────────────────────────────────────────
# 每条：名称 + 正则 + 建议（正则里不要写完整的示例密钥，避免脚本自身命中）
$rules = @(
    @{ Name = 'OpenAI/DeepSeek 风格 key'; Pattern = 'sk-[A-Za-z0-9_\-]{20,}' }
    @{ Name = 'AWS Access Key ID';        Pattern = 'AKIA[0-9A-Z]{16}' }
    @{ Name = 'GitHub token';             Pattern = 'gh[pousr]_[A-Za-z0-9]{30,}' }
    @{ Name = 'Slack token';              Pattern = 'xox[baprs]-[A-Za-z0-9\-]{10,}' }
    @{ Name = '私钥文件头';               Pattern = '-----BEGIN [A-Z ]*PRIVATE KEY-----' }
    @{ Name = '内联 apiKey 赋值';         Pattern = '(?i)(api[_-]?key|apikey|secret|passwd|password|access[_-]?token)\s*[:=]\s*["'']?[A-Za-z0-9_\-\.]{24,}' }
    @{ Name = 'Bearer 长串';              Pattern = '(?i)Bearer\s+[A-Za-z0-9_\-\.]{30,}' }
    @{ Name = '疑似 sk-ws（千问云）key';  Pattern = 'sk-ws-[A-Za-z0-9]{16,}' }
    @{ Name = '疑似 tokenhub/腾讯云 key'; Pattern = '(?i)secretid\s*[:=]\s*["'']?[A-Za-z0-9]{20,}' }
)

# ── 排除规则 ──────────────────────────────────────────────────────────────
$excludeDirNames = @('.git', 'node_modules', '.pnpm-store', 'dist', 'build', '.cache', 'tmp', 'temp', 'archive')
$excludeFileNames = @('.env', 'package-lock.json', 'pnpm-lock.yaml', '.DS_Store')
$textExtensions = @(
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.jsonl',
    '.yml', '.yaml', '.md', '.txt', '.ps1', '.psm1', '.sh', '.bash',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.php', '.cs',
    '.toml', '.ini', '.cfg', '.conf', '.properties', '.xml', '.html', '.css', '.sql'
)
$maxBytes = 2MB

Write-Verbose "扫描根目录：$Root"

$files = Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
    $rel = $_.FullName.Substring($Root.Length).TrimStart('\', '/')
    $parts = $rel -split '[\\/]'
    $skip = $false
    foreach ($p in $parts[0..([Math]::Max(0, $parts.Count - 2))]) {
        if ($excludeDirNames -contains $p) { $skip = $true; break }
    }
    if ($skip) { return $false }
    if ($excludeFileNames -contains $_.Name) { return $false }
    if ($_.Name -like '*.bak*') { return $false }
    if ($_.Name -eq 'verify-no-secrets.ps1') { return $false }   # 规则表本身
    if ($textExtensions -notcontains $_.Extension.ToLowerInvariant()) { return $false }
    if ($_.Length -gt $maxBytes) { return $false }
    return $true
}

$findings = New-Object System.Collections.ArrayList
$scanned = 0

foreach ($file in $files) {
    $scanned++
    $lineNo = 0
    try {
        $lines = Get-Content -LiteralPath $file.FullName -Encoding UTF8 -ErrorAction Stop
    } catch {
        continue
    }
    foreach ($line in $lines) {
        $lineNo++
        if ($null -eq $line -or $line.Length -lt 8) { continue }
        # 明显是占位符的行直接放过，少点噪音
        if ($line -match '(?i)(REPLACE|YOUR[_-]?KEY|<your|example|placeholder|xxxx|\.\.\.|REDACTED|FAKE)') { continue }
        foreach ($rule in $rules) {
            if ($line -match $rule.Pattern) {
                [void]$findings.Add([pscustomobject]@{
                    File = $file.FullName.Substring($Root.Length).TrimStart('\', '/')
                    Line = $lineNo
                    Rule = $rule.Name
                })
                break
            }
        }
    }
}

Write-Host ""
Write-Host "── 密钥自查 ────────────────────────────────────────────" -ForegroundColor Cyan
Write-Host ("扫描文件：{0} 个（文本类、< 2 MB、已跳过 .git / node_modules / .env / 锁文件）" -f $scanned)

if ($findings.Count -eq 0) {
    Write-Host "结果：干净 ✅  没有发现疑似凭证。" -ForegroundColor Green
    Write-Host "（命中只是启发式判断，反向也成立：清理过的仓库不代表历史里没有，必要时跑 filter-repo。）"
    exit 0
}

Write-Host ("结果：发现 {0} 处疑似凭证 ❌" -f $findings.Count) -ForegroundColor Red
Write-Host ""
Write-Host "位置（按规范，这里只报位置不打印内容）：" -ForegroundColor Yellow
$findings | ForEach-Object { Write-Host ("  {0}:{1}   [{2}]" -f $_.File, $_.Line, $_.Rule) }
Write-Host ""
Write-Host "处置：① 先吊销该凭证；② 换新值并只放环境变量/凭证库；③ 清理工作区与 git 历史；"
Write-Host "      ④ 若曾进过同步盘，务必以「吊销」为准（删文件不算）。详见 docs/credentials.md"
exit 1
