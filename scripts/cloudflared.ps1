# Wrapper local — cloudflared no está en PATH de Windows
$bin = Join-Path $PSScriptRoot '..\tools\cloudflared.exe'
if (-not (Test-Path $bin)) {
  Write-Error "No se encontró $bin. Descarga: https://github.com/cloudflare/cloudflared/releases"
  exit 1
}
& $bin @args
