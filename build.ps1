# Assembles src/* into the single distributable HTML file.
# Run:  powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $root 'src'
$out  = Join-Path $root 'gemini-enterprise-report.html'

$parts = @('head.html','vendor.html','style.css','body.html','app.js')

$sb = New-Object System.Text.StringBuilder
foreach ($p in $parts) {
    $f = Join-Path $src $p
    if (-not (Test-Path $f)) { throw "missing source part: $p" }
    [void]$sb.AppendLine([System.IO.File]::ReadAllText($f).TrimEnd())
}

# UTF-8 *with* BOM: the page is opened straight off disk (file://) where no
# HTTP charset header exists, and Windows browsers otherwise guess cp1255
# for Hebrew content and render the whole UI as mojibake.
$enc = New-Object System.Text.UTF8Encoding $true
[System.IO.File]::WriteAllText($out, $sb.ToString(), $enc)

$kb = [math]::Round((Get-Item $out).Length / 1KB)
$lines = ([System.IO.File]::ReadAllLines($out)).Count
Write-Output "built: $out  ($kb KB, $lines lines)"
