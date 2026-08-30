# Minimal static file server. The Browser pane caches file:// URLs per tab,
# so local edits never show up; serving over HTTP with no-cache headers gives
# a working reload loop. No node/python on this machine, hence HttpListener.
#
#   powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8099]

param([int]$Port = 8099)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Output "serving $root on http://localhost:$Port/"

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.tsv'  = 'text/tab-separated-values; charset=utf-8'
    '.csv'  = 'text/csv; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
}

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
        $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
        if ($rel -eq '') { $rel = 'gemini-enterprise-report.html' }
        $path = Join-Path $root $rel

        # Keep requests inside the served root.
        $full = [System.IO.Path]::GetFullPath($path)
        if (-not $full.StartsWith([System.IO.Path]::GetFullPath($root))) {
            $ctx.Response.StatusCode = 403; $ctx.Response.Close(); continue
        }

        if (Test-Path $full -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($full)
            $ext = [System.IO.Path]::GetExtension($full).ToLower()
            $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $ctx.Response.Headers.Add('Cache-Control', 'no-store, no-cache, must-revalidate')
            $ctx.Response.ContentLength64 = $bytes.Length
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $ctx.Response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("not found: $rel")
            $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
        }
        $ctx.Response.Close()
    } catch {
        # A dropped connection shouldn't take the server down.
    }
}
