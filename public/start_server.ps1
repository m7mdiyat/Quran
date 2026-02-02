# Simple static file server (no Python) using .NET HttpListener
# Run: powershell -ExecutionPolicy Bypass -File .\start_server.ps1

$port = 8000
$prefix = "http://localhost:$port/"
$root = (Get-Location).Path

Write-Host "Serving folder: $root"
Write-Host "Open: $prefix"
Write-Host "Press Ctrl+C to stop."

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()

function Get-MimeType($path) {
  switch -Regex ($path) {
    "\.html$" { "text/html; charset=utf-8" }
    "\.js$"   { "application/javascript; charset=utf-8" }
    "\.json$" { "application/json; charset=utf-8" }
    "\.css$"  { "text/css; charset=utf-8" }
    "\.png$"  { "image/png" }
    "\.jpg$"  { "image/jpeg" }
    "\.jpeg$" { "image/jpeg" }
    "\.svg$"  { "image/svg+xml" }
    default   { "application/octet-stream" }
  }
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response

    $rel = $req.Url.AbsolutePath.TrimStart("/")
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = "index.html" }
    $path = Join-Path $root $rel

    if (-not (Test-Path $path -PathType Leaf)) {
      $res.StatusCode = 404
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("Not Found")
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      $res.Close()
      continue
    }

    $res.ContentType = Get-MimeType $path
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.Close()
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
