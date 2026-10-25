#!/usr/bin/env bash
# One-step installer for video2mp4 on macOS / Linux.
# Installs Node.js (if missing), downloads yt-dlp + ffmpeg, registers the
# global "video2mp4" command and makes sure it is on your PATH.
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -v | sed 's/^v//' | cut -d. -f1
}

add_to_path() {
  local dir="$1" line="export PATH=\"$1:\$PATH\""
  case ":$PATH:" in *":$dir:"*) return ;; esac
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    if [ -f "$rc" ] || [ "$(basename "$rc")" = ".profile" ]; then
      grep -qsF "$line" "$rc" || printf '\n# Added by video2mp4 setup\n%s\n' "$line" >> "$rc"
    fi
  done
  export PATH="$dir:$PATH"
  step "Added $dir to PATH (in ~/.bashrc, ~/.zshrc, ~/.profile)"
}

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

# 2. Dependencies (yt-dlp + ffmpeg are downloaded by the postinstall script)
step 'Installing dependencies (yt-dlp, ffmpeg)...'
npm install --no-fund --no-audit --foreground-scripts

# 3. Register the global command (links this folder, so "git pull" updates it)
step 'Registering the global "video2mp4" command...'
if ! npm install -g . --no-fund --no-audit --ignore-scripts 2>/dev/null; then
  step 'No permission for the global npm folder - using ~/.npm-global instead'
  mkdir -p "$HOME/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  npm install -g . --no-fund --no-audit --ignore-scripts
fi

# 4. Ensure npm's global bin folder is on PATH
add_to_path "$(npm prefix -g)/bin"

# 5. Verify
ver="$(video2mp4 --version)" || fail 'video2mp4 could not be started.'
printf '\n\033[32mvideo2mp4 v%s is installed.\033[0m\n' "$ver"
echo 'Open a NEW terminal window and run:  video2mp4'
