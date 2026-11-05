#!/usr/bin/env sh
# Instala octomate-data (Linux / macOS): descarga el binario de la última release.
set -eu
REPO="maxirossi/octomatelabs-data"
os=$(uname -s | tr '[:upper:]' '[:lower:]'); arch=$(uname -m)
case "$os" in linux|darwin) ;; *) echo "Sistema no soportado: $os (en Windows usá install.ps1)" >&2; exit 1;; esac
case "$arch" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) echo "Arquitectura no soportada: $arch" >&2; exit 1;; esac
dest="${OCTOMATE_BIN_DIR:-$HOME/.local/bin}"; mkdir -p "$dest"
url="https://github.com/$REPO/releases/latest/download/octomate-data-$os-$arch"
echo "Descargando $url"
# Descarga a un temporal y reemplaza con mv: pisa una instalación previa aunque esté corriendo (evita "Text file busy")
tmp="$dest/.octomate-data.$$"; trap 'rm -f "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp"; chmod +x "$tmp"; mv -f "$tmp" "$dest/octomate-data"
echo "Instalado en $dest/octomate-data"
case ":$PATH:" in *":$dest:"*) ;; *) echo "Agregá $dest a tu PATH.";; esac
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || [ "$os" = darwin ]; then
  echo "Abriendo el asistente de configuración…"
  "$dest/octomate-data" setup
else
  echo "Sin entorno gráfico. Siguiente: octomate-data init && octomate-data install-service"
fi
