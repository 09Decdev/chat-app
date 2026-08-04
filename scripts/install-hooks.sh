#!/bin/sh
# Installs the gitleaks pre-commit hook into .git/hooks/.
#
# Usage:  sh scripts/install-hooks.sh
# Run after `git clone` (or whenever .git/hooks/ is recreated).
#
# The hook source is tracked at scripts/pre-commit; .git/hooks/ itself is not
# version-controlled, so this script copies the latest version in.

set -e

repo_root="$(git rev-parse --show-toplevel)"
hook_dir="$repo_root/.git/hooks"
hook_src="$repo_root/scripts/pre-commit"

if [ ! -f "$hook_src" ]; then
  echo "error: $hook_src not found" >&2
  exit 1
fi

cp "$hook_src" "$hook_dir/pre-commit"
chmod +x "$hook_dir/pre-commit"
echo "installed pre-commit hook -> $hook_dir/pre-commit"
echo "note: gitleaks must be on PATH (winget install gitleaks) or the hook skips."