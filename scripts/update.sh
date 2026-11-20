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

# Linux: the app-tile helper is Rust; build it here (needs cargo + libxkbcommon-dev + libgbm-dev).
if [ "$(uname -s)" = Linux ]; then
	if command -v cargo >/dev/null 2>&1; then
		(cd helper/linux && cargo build --release --locked) || echo "!! the app-tile helper didn't build; terminals and web tiles still work (see helper/linux/README.md)"
	else
		echo "(app tiles need the helper: sudo apt install cargo pkg-config libxkbcommon-dev libgbm-dev, then run this again)"
	fi
fi
npm run build

src=dev-vault/.obsidian/plugins/vivarium
dest="$vault/.obsidian/plugins/vivarium"
mkdir -p "$dest"
for f in main.js manifest.json styles.css vivarium SKILL.md vivarium-helper-macos vivarium-helper-linux-x64 vivarium-helper-linux-arm64; do
	# copy + rename: a running helper keeps its old file ("text file busy" on overwrite)
	[ -e "$src/$f" ] && cp "$src/$f" "$dest/$f.new" && mv -f "$dest/$f.new" "$dest/$f"
done
echo
echo "Installed $(git log --oneline -1) into $dest"
echo "Now turn Vivarium off and on in Obsidian (Settings → Community plugins)."
if pgrep -f "vivarium-helper-linux.*--listen" >/dev/null 2>&1; then
	echo "The app-tile helper keeps running with the old version until it's restarted (that closes the apps in your tiles):"
	echo "  pkill -f 'vivarium-helper-linux.*--listen'"
fi
