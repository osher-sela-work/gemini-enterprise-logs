$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$html = [System.IO.File]::ReadAllText((Join-Path $root 'gemini-enterprise-report.html'))
$files = @(@{ name = 'real-export.csv'; path = 'sample-data\real-export.csv' })
$payload = @()
foreach ($f in $files) {
    $full = Join-Path $root $f.path
    if (-not (Test-Path $full)) { continue }
    $payload += [pscustomobject]@{ name = $f.name; text = [System.IO.File]::ReadAllText($full) }
}
$json = $payload | ConvertTo-Json -Compress -Depth 5
if ($payload.Count -eq 1) { $json = "[$json]" }
$inject = @"
<script>
window.__TESTFILES__ = $json;
window.addEventListener('load', function(){
  try{
    window.__TESTFILES__.forEach(function(f){ ingestText(f.text, f.name); });
    finishLoad();
    window.__TESTOK__ = true;
  }catch(e){ window.__TESTERR__ = e.message + ' :: ' + e.stack; }
});
</script>
</body>
"@
$html = $html -replace '</body>', $inject
$stamp = Get-Date -Format 'HHmmss'
$outPath = Join-Path $root "src\_t$stamp.html"
[System.IO.File]::WriteAllText($outPath, $html, (New-Object System.Text.UTF8Encoding $true))
Write-Output "http://localhost:8099/src/_t$stamp.html"
