# Downloads Quran text as JSON (then everything works offline)
# Run: powershell -ExecutionPolicy Bypass -File .\download_quran.ps1
#
# Strategy:
# 1) Try alquran.cloud "quran-simple" endpoint (common).
# 2) Try other known endpoints as fallback.
# Output: quran.json in the current folder.
#
# Note: APIs sometimes change. If all fail, you'll see the failed URLs printed.

$OutFile = Join-Path (Get-Location).Path "quran.json"

$Candidates = @(
  "https://api.alquran.cloud/v1/quran/quran-simple",
  "https://api.alquran.cloud/v1/quran/ar.quran-simple",
  "https://api.alquran.cloud/v1/quran/ar.alafasy",
  "https://api.alquran.cloud/v1/quran/ar",
  "https://raw.githubusercontent.com/fawazahmed0/quran-api/1/editions/ara-quransimple.json"
)

function Try-Download($url) {
  try {
    Write-Host "Trying: $url"
    $resp = Invoke-RestMethod -Uri $url -Method GET -TimeoutSec 60
    # Save raw JSON (we don't transform here; app.js can normalize multiple shapes)
    $resp | ConvertTo-Json -Depth 100 | Out-File -FilePath $OutFile -Encoding utf8
    return $true
  } catch {
    Write-Host "Failed: $url"
    return $false
  }
}

$ok = $false
foreach ($u in $Candidates) {
  if (Try-Download $u) { $ok = $true; break }
}

if ($ok) {
  Write-Host "`nSaved: $OutFile"
  Write-Host "Now run: .\start_server.ps1 and open http://localhost:8000"
} else {
  Write-Host "`nAll download attempts failed."
  Write-Host "Tip: try opening those URLs in your browser and tell me which one works, and I'll hardcode it."
  exit 1
}
