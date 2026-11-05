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
curl -fsSL "$url" -o "$dest/octomate-data"; chmod +x "$dest/octomate-data"
echo "Instalado en $dest/octomate-data"
case ":$PATH:" in *":$dest:"*) ;; *) echo "Agregá $dest a tu PATH.";; esac
echo "Siguiente: octomate-data init && octomate-data install-service"
