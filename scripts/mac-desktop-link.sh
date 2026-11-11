#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/.bin:/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin:$PATH"
export COREPACK_HOME="$ROOT/.corepack"
cd "$ROOT"
# Ensure local pnpm shim
if [[ ! -x "$ROOT/.bin/pnpm" ]]; then
  mkdir -p "$ROOT/.bin" "$ROOT/.corepack"
  COREPACK_HOME="$ROOT/.corepack" corepack prepare pnpm@11.28.5 --activate
  printf '%s\n' '#!/bin/sh' "exec node \"$ROOT/.corepack/v1/pnpm/11.28.5/bin/pnpm.cjs\" \"\$@\"" > "$ROOT/.bin/pnpm"
  chmod +x "$ROOT/.bin/pnpm"
fi
echo "Quitting DeepSeek Harness if running..."
osascript -e 'tell application "DeepSeek Harness" to quit' 2>/dev/null || true
sleep 1
echo "Linking local build into desktop profile..."
pnpm desktop:link
echo "Done. Reopen DeepSeek Harness to verify."
