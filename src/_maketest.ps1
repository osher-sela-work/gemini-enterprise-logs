# Builds a throwaway copy of the report with the sample exports embedded and
# auto-ingested on load, so the whole pipeline can be exercised headlessly.
# Output filename is timestamped because the preview pane caches per path.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$html = [System.IO.File]::ReadAllText((Join-Path $root 'gemini-enterprise-report.html'))

$files = @(
    @{ name = 'gemini-enterprise-sample.tsv'; path = 'sample-data\gemini-enterprise-sample.tsv' },
    @{ name = 'nlm-real.tsv';                 path = 'sample-data\nlm-real.tsv' }
)

$payload = @()
foreach ($f in $files) {
    $full = Join-Path $root $f.path
    if (-not (Test-Path $full)) { continue }
    $text = [System.IO.File]::ReadAllText($full)
    $payload += [pscustomobject]@{ name = $f.name; text = $text }
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
$enc = New-Object System.Text.UTF8Encoding $true
[System.IO.File]::WriteAllText($outPath, $html, $enc)
Write-Output "file:///$($outPath -replace '\\','/' -replace ' ','%20')"
