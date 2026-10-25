#!/usr/bin/env bash
# One-step installer (macOS / Linux).
# Copies the app to ~/.local/share/<app>, installs Node.js if missing, downloads
# yt-dlp + ffmpeg, registers the global command and makes sure it is on your PATH.
# The downloaded ZIP / cloned folder can be deleted afterwards.
set -euo pipefail
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd -P)"
APP="$(sed -n 's/^[[:space:]]*"name":[[:space:]]*"\([^"]*\)".*/\1/p' "$SOURCE_DIR/package.json" | head -n 1)"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/$APP"
APP_ITEMS="bin lib scripts package.json package-lock.json README.md setup.cmd setup.ps1 setup.sh"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -v | sed 's/^v//' | cut -d. -f1
}

add_to_path() {
  local dir="$1" line="export PATH=\"$1:\$PATH\""
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bash_login"; do
    if [ -f "$rc" ] || { [ "$rc" != "$HOME/.bash_profile" ] && [ "$rc" != "$HOME/.bash_login" ]; }; then
      grep -qsF "$line" "$rc" || printf '\n# Added by %s setup\n%s\n' "$APP" "$line" >> "$rc"
    fi
  done
  case ":$PATH:" in *":$dir:"*) ;; *) export PATH="$dir:$PATH" ;; esac
  step "Persisted $dir in shell startup files"
}

[ -n "$APP" ] || fail 'Could not read the app name from package.json.'

# 1. Node.js 20+
if [ "$(node_major)" -lt 20 ]; then
  step 'Node.js 20+ not found - installing Node.js LTS...'
  if command -v brew >/dev/null 2>&1; then
    brew install node
  else
    export NVM_DIR="$HOME/.nvm"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    fi
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install --lts
    nvm alias default 'lts/*'
  fi
  [ "$(node_major)" -ge 20 ] || fail 'Could not install Node.js automatically. Install Node.js 20+ from https://nodejs.org and re-run ./setup.sh'
fi
step "Using Node.js $(node -v)"

# 2. Copy the app to its permanent location (keeps already-downloaded binaries in vendor/)
mkdir -p "$INSTALL_DIR"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
if [ "$SOURCE_DIR" != "$INSTALL_DIR" ]; then
  step "Installing $APP to $INSTALL_DIR ..."
  for item in $APP_ITEMS; do
    rm -rf "${INSTALL_DIR:?}/$item"
    if [ -e "$SOURCE_DIR/$item" ]; then cp -R "$SOURCE_DIR/$item" "$INSTALL_DIR/$item"; fi
  done
  chmod +x "$INSTALL_DIR/setup.sh" "$INSTALL_DIR"/bin/*.js
fi
cd "$INSTALL_DIR"

# 3. Dependencies (yt-dlp + ffmpeg are downloaded by the postinstall script)
step 'Installing dependencies (yt-dlp, ffmpeg)...'
npm install --no-fund --no-audit --ignore-scripts
node scripts/postinstall.js --strict

# 4. Register the global command (points at the installed copy)
step "Registering the global \"$APP\" command..."
if ! npm install -g . --no-fund --no-audit --ignore-scripts; then
  step 'No permission for the global npm folder - using ~/.npm-global instead'
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  npm install -g . --no-fund --no-audit --ignore-scripts
fi

# 5. Ensure npm's global bin folder is on PATH
add_to_path "$(dirname "$(command -v node)")"
add_to_path "$(npm prefix -g)/bin"

# 6. Verify
ver="$("$APP" --version)" || fail "$APP could not be started."
printf '\n\033[32m%s v%s is installed in %s\033[0m\n' "$APP" "$ver" "$INSTALL_DIR"
if [ "$SOURCE_DIR" != "$INSTALL_DIR" ]; then echo "You can delete $SOURCE_DIR now - it is no longer needed."; fi
echo "Open a NEW terminal window and run:  $APP"
