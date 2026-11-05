# Instala octomate-data en Windows: descarga el .exe de la última release.
$ErrorActionPreference = "Stop"
$repo = "maxirossi/octomatelabs-data"
$dest = Join-Path $env:LOCALAPPDATA "octomatelabs-data"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$url = "https://github.com/$repo/releases/latest/download/octomate-data-windows-x64.exe"
Write-Host "Descargando $url"
Invoke-WebRequest -Uri $url -OutFile (Join-Path $dest "octomate-data.exe")
$path = [Environment]::GetEnvironmentVariable("Path", "User")
if ($path -notlike "*$dest*") { [Environment]::SetEnvironmentVariable("Path", "$path;$dest", "User") }
Write-Host "Instalado en $dest. Abriendo el asistente de configuración..."
& (Join-Path $dest "octomate-data.exe") setup
