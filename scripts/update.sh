#!/bin/sh
# Pull the latest Vivarium, build it and install it into a vault.
#   sh scripts/update.sh ~/path/to/vault      (the vault is remembered: next time just `sh scripts/update.sh`)
set -e
cd "$(dirname "$0")/.."
saved=.vault-path
vault="${1:-$(cat "$saved" 2>/dev/null || true)}"
[ -n "$vault" ] || { echo "usage: sh scripts/update.sh <vault folder>"; exit 1; }
[ -d "$vault/.obsidian" ] || { echo "$vault is not an Obsidian vault (no .obsidian folder)"; exit 1; }
echo "$vault" > "$saved"

git checkout -- package-lock.json   # npm may have touched it; it's not yours
git pull --ff-only
npm ci --no-audit --no-fund
npm run build

src=dev-vault/.obsidian/plugins/vivarium
dest="$vault/.obsidian/plugins/vivarium"
mkdir -p "$dest"
for f in main.js manifest.json styles.css vivarium vivarium-helper-macos; do
	[ -e "$src/$f" ] && cp "$src/$f" "$dest/"
done
echo
echo "Installed $(git log --oneline -1) into $dest"
echo "Now turn Vivarium off and on in Obsidian (Settings → Community plugins)."
