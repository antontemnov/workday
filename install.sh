#!/usr/bin/env bash
set -euo pipefail

REPO="antontemnov/workday"
APP_NAME="workday"
NPM_PACKAGE="workday-daemon"
MIN_NODE_MAJOR=20

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { echo -e "${CYAN}${BOLD}::${RESET} $1"; }
ok()    { echo -e "${GREEN}${BOLD}OK${RESET} $1"; }
warn()  { echo -e "${YELLOW}${BOLD}!!${RESET} $1"; }
fail()  { echo -e "${RED}${BOLD}ERROR${RESET} $1"; exit 1; }

# ─── Detect OS & arch ────────────────────────────────────────────────

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)   OS="linux" ;;
    Darwin)  OS="macos" ;;
    MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
    *) fail "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64)  ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) fail "Unsupported architecture: $arch" ;;
  esac

  info "Platform: ${OS}/${ARCH}"
}

# ─── Check Node.js ───────────────────────────────────────────────────

check_node() {
  if ! command -v node &>/dev/null; then
    fail "Node.js not found. Install Node.js >= ${MIN_NODE_MAJOR}: https://nodejs.org"
  fi

  local ver
  ver="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$ver" -lt "$MIN_NODE_MAJOR" ]; then
    fail "Node.js ${ver} is too old. Need >= ${MIN_NODE_MAJOR}."
  fi
  ok "Node.js $(node -v)"
}

# ─── Install npm package ─────────────────────────────────────────────

install_npm() {
  if command -v workday &>/dev/null; then
    ok "workday CLI already installed ($(workday --version 2>/dev/null || echo 'unknown'))"
  else
    info "Installing ${NPM_PACKAGE} via npm..."
    npm install -g "$NPM_PACKAGE"
    ok "workday CLI installed"
  fi
}

# ─── Initialize workday config ───────────────────────────────────────

init_config() {
  if [ -f "$HOME/.workday/config.json" ]; then
    ok "Config already exists at ~/.workday/config.json"
  else
    info "Running workday init..."
    workday init
    ok "Config created at ~/.workday/"
  fi
}

# ─── Download & install tray app ─────────────────────────────────────

install_tray_app() {
  info "Fetching latest release from GitHub..."

  local release_url="https://api.github.com/repos/${REPO}/releases/latest"
  local release_json
  release_json="$(curl -fsSL "$release_url" 2>/dev/null)" || {
    warn "Could not fetch GitHub releases. Skipping tray app install."
    warn "You can install it manually from: https://github.com/${REPO}/releases"
    return 0
  }

  local download_url=""
  local filename=""

  case "$OS" in
    macos)
      download_url="$(echo "$release_json" | grep -o '"browser_download_url":\s*"[^"]*\.dmg"' | head -1 | cut -d'"' -f4)"
      ;;
    windows)
      download_url="$(echo "$release_json" | grep -o '"browser_download_url":\s*"[^"]*-setup\.exe"' | head -1 | cut -d'"' -f4)"
      ;;
  esac

  if [ -z "$download_url" ]; then
    warn "No tray app binary found for ${OS}/${ARCH}."
    warn "Download manually: https://github.com/${REPO}/releases"
    return 0
  fi

  filename="$(basename "$download_url")"
  local tmpdir
  tmpdir="$(mktemp -d)"

  info "Downloading ${filename}..."
  curl -fSL -o "${tmpdir}/${filename}" "$download_url"

  case "$filename" in
    *.dmg)
      info "Mounting ${filename}..."
      local mount_point
      mount_point="$(hdiutil attach "${tmpdir}/${filename}" -nobrowse | tail -1 | awk '{print $3}')"
      cp -R "${mount_point}"/*.app /Applications/ 2>/dev/null || true
      hdiutil detach "$mount_point" -quiet
      ok "Tray app installed to /Applications"
      ;;
    *-setup.exe)
      # Stop running tray app before reinstall
      taskkill //IM "app.exe" //F 2>/dev/null || true
      local dl_dir="${USERPROFILE:-$HOME}/Downloads"
      cp "${tmpdir}/${filename}" "${dl_dir}/${filename}"
      local win_path
      win_path="$(cygpath -w "${dl_dir}/${filename}" 2>/dev/null || echo "${dl_dir}/${filename}")"
      info "Launching installer..."
      if powershell.exe -Command "Start-Process '${win_path}' -ArgumentList '/S' -Verb RunAs -Wait" 2>/dev/null; then
        ok "Tray app installed"
      else
        ok "Tray app installer launched"
      fi
      ;;
  esac

  rm -rf "$tmpdir"
}

# ─── Autostart ────────────────────────────────────────────────────────

setup_autostart() {
  case "$OS" in
    macos)
      local plist_dir="${HOME}/Library/LaunchAgents"
      local plist_file="${plist_dir}/com.workday.tray.plist"
      mkdir -p "$plist_dir"
      cat > "$plist_file" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.workday.tray</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/workday.app/Contents/MacOS/workday</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST
      ok "LaunchAgent created at ${plist_file}"
      ;;
    windows)
      local exe_path="${LOCALAPPDATA}/workday/app.exe"
      if [ ! -f "$exe_path" ]; then
        warn "Workday exe not found at ${exe_path}, skipping autostart."
        return 0
      fi
      local win_exe
      win_exe="$(cygpath -w "$exe_path" 2>/dev/null || echo "$exe_path")"
      powershell.exe -Command "
        \$startup = [Environment]::GetFolderPath('Startup')
        \$link = Join-Path \$startup 'Workday.lnk'
        if (-not (Test-Path \$link)) {
          \$ws = New-Object -ComObject WScript.Shell
          \$sc = \$ws.CreateShortcut(\$link)
          \$sc.TargetPath = '${win_exe}'
          \$sc.Save()
        }
      " 2>/dev/null && {
        ok "Added to autostart (shell:startup)"
      } || {
        warn "Could not add to autostart."
      }
      ;;
  esac
}

# ─── Main ─────────────────────────────────────────────────────────────

main() {
  echo ""
  echo -e "${BOLD}${CYAN}  WORKDAY INSTALLER${RESET}"
  echo -e "  ─────────────────────────────"
  echo ""

  detect_platform
  check_node
  install_npm
  init_config
  install_tray_app
  setup_autostart

  echo ""
  echo -e "${GREEN}${BOLD}  Installation complete!${RESET}"
  echo ""
  echo "  CLI:      workday --help"
  echo "  Tray app: ${APP_NAME}"
  echo ""
}

main "$@"
