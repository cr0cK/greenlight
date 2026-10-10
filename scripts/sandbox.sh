#!/usr/bin/env bash
# Runs the current checkout in a windowed GNOME Shell (mutter devkit), isolated from the
# desktop session: extensions and GSettings live under the sandbox directory, on a private
# D-Bus session. Preferences persist between runs; pass --reset to start from scratch.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=babysitpr@alexis
SANDBOX=${BABYSITPR_SANDBOX:-${XDG_CACHE_HOME:-$HOME/.cache}/babysitpr-sandbox}
EXTENSION_DIR=$SANDBOX/data/gnome-shell/extensions/$UUID
KEYFILE=$SANDBOX/config/glib-2.0/settings/keyfile

if [[ ${1:-} == --reset ]]; then
    rm -rf "$SANDBOX"
elif [[ $# -gt 0 ]]; then
    echo "Usage: $0 [--reset]" >&2
    exit 2
fi

for command in gh gnome-shell dbus-run-session glib-compile-schemas unzip; do
    if ! command -v "$command" >/dev/null; then
        echo "Missing $command." >&2
        exit 1
    fi
done
if [[ ! -x /usr/libexec/mutter-devkit ]]; then
    echo "Missing mutter devkit; install mutter-devel." >&2
    exit 1
fi

# The token lives in the desktop keyring, which the private D-Bus session cannot reach.
if ! GH_TOKEN=$(gh auth token 2>/dev/null); then
    echo "gh is not authenticated; run gh auth login." >&2
    exit 1
fi

make -C "$ROOT" pack
rm -rf "$EXTENSION_DIR"
mkdir -p "$EXTENSION_DIR" "$(dirname "$KEYFILE")"
unzip -q "$ROOT/dist/$UUID.shell-extension.zip" -d "$EXTENSION_DIR"
glib-compile-schemas "$EXTENSION_DIR/schemas"

if [[ ! -f $KEYFILE ]]; then
    cat > "$KEYFILE" <<EOF
[org/gnome/shell]
enabled-extensions=['$UUID']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'
EOF
fi

# The sandbox keyboard has its own Num Lock state; mirror the desktop's so keypad digits
# type digits instead of moving focus.
XDG_CONFIG_HOME="$SANDBOX/config" GSETTINGS_BACKEND=keyfile gsettings set \
    org.gnome.desktop.peripherals.keyboard numlock-state \
    "$(gsettings get org.gnome.desktop.peripherals.keyboard numlock-state)"

echo "Sandbox: $SANDBOX"
exec env \
    XDG_DATA_HOME="$SANDBOX/data" \
    XDG_CONFIG_HOME="$SANDBOX/config" \
    GSETTINGS_BACKEND=keyfile \
    GH_CONFIG_DIR="${GH_CONFIG_DIR:-$HOME/.config/gh}" \
    GH_TOKEN="$GH_TOKEN" \
    dbus-run-session -- gnome-shell --devkit --wayland
