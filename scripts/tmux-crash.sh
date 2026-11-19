#!/bin/sh
# Stack trace of the latest tmux crash (Ubuntu), saved to ~/tmux-crash.txt and copied to the clipboard.
#   sh scripts/tmux-crash.sh
crash=$(ls -t /var/crash/_usr_bin_tmux.*.crash 2>/dev/null | head -n 1)
[ -n "$crash" ] || { echo "No tmux crash report in /var/crash."; exit 1; }
command -v gdb >/dev/null && command -v apport-unpack >/dev/null || {
	echo "Installing gdb (needs your password)…"
	sudo apt-get install -y gdb apport >/dev/null || exit 1
}
dir=$(mktemp -d)
rmdir "$dir" # apport-unpack wants to create it
apport-unpack "$crash" "$dir" 2>/dev/null || {
	sudo apport-unpack "$crash" "$dir" && sudo chown -R "$(id -u)" "$dir"
} || exit 1
exe=$(cat "$dir/ExecutablePath" 2>/dev/null || echo /usr/bin/tmux)
out="$HOME/tmux-crash.txt"
# debuginfod fetches Ubuntu's debug symbols, so the trace has function names and line numbers.
export DEBUGINFOD_URLS="${DEBUGINFOD_URLS:-https://debuginfod.ubuntu.com}"
{
	echo "crash file: $crash ($(date -r "$crash"))"
	"$exe" -V
	grep -m1 '^Package:' "$dir/ProblemType" "$dir/Package" 2>/dev/null
	echo
	gdb -batch -iex 'set debuginfod enabled on' -ex 'bt full' "$exe" "$dir/CoreDump" 2>&1 | grep -v '^\[New LWP' | tail -n 120
} > "$out"
rm -rf "$dir"
if command -v wl-copy >/dev/null; then wl-copy < "$out" && copied=1
elif command -v xclip >/dev/null; then xclip -selection clipboard < "$out" && copied=1
fi
cat "$out"
echo
[ -n "$copied" ] && echo "Copied to the clipboard (also saved to $out)." || echo "Saved to $out (install wl-clipboard to copy it automatically)."
