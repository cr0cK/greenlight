#!/usr/bin/env bash
# Regenerates the README screenshots in docs/screenshots/. Runs the checkout in a headless
# GNOME Shell on a private D-Bus session, with scripts/screenshots/gh standing in for the GitHub
# CLI, so the images show fictional data and never a real account.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=greenlight@cr0ck.github.io
OUT=$ROOT/docs/screenshots

if [[ ${1:-} != --inside ]]; then
    for command in gnome-shell dbus-run-session gdbus glib-compile-schemas unzip magick; do
        if ! command -v "$command" >/dev/null; then
            echo "Missing $command." >&2
            exit 1
        fi
    done
    make -C "$ROOT" pack

    # Exported before the bus starts: services it activates, such as the preferences window,
    # inherit its environment, so they too stay away from the real settings and gh.
    WORK=$(mktemp -d)
    export WORK XDG_DATA_HOME=$WORK/data XDG_CONFIG_HOME=$WORK/config GSETTINGS_BACKEND=keyfile
    export GSETTINGS_SCHEMA_DIR=$XDG_DATA_HOME/gnome-shell/extensions/$UUID/schemas
    export PATH=$ROOT/scripts/screenshots:$PATH GTK_A11Y=none
    # The display name stays short: the Wayland socket path must fit in 108 bytes.
    export WAYLAND_DISPLAY=greenlight-shot
    exec dbus-run-session -- "$0" --inside
fi

SHELL_PID=
cleanup() {
    [[ -n $SHELL_PID ]] && kill "$SHELL_PID" 2>/dev/null && wait "$SHELL_PID" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT

EXTENSIONS=$XDG_DATA_HOME/gnome-shell/extensions
mkdir -p "$EXTENSIONS/$UUID" "$EXTENSIONS/unsafe@screenshots" "$OUT"
unzip -q "$ROOT/dist/$UUID.shell-extension.zip" -d "$EXTENSIONS/$UUID"
glib-compile-schemas "$GSETTINGS_SCHEMA_DIR"

# Eval and Screenshot refuse callers outside unsafe mode; this throwaway extension enables it.
cat > "$EXTENSIONS/unsafe@screenshots/metadata.json" <<'JSON'
{"uuid": "unsafe@screenshots", "name": "Unsafe mode", "description": "Screenshots only",
 "shell-version": ["49"]}
JSON
cat > "$EXTENSIONS/unsafe@screenshots/extension.js" <<'JS'
export default class {
    enable() { global.context.unsafe_mode = true; }
    disable() {}
}
JS

gs() { gsettings set "$@"; }
gs org.gnome.shell enabled-extensions "['$UUID', 'unsafe@screenshots']"
gs org.gnome.shell disable-user-extensions false
gs org.gnome.shell welcome-dialog-last-shown-version "'999'"
gs org.gnome.desktop.interface color-scheme "'prefer-dark'"
EXT=org.gnome.shell.extensions.greenlight
gs $EXT author-filter "''"
gs $EXT owner-filters-configured true
gs $EXT owner-filters '[{"login":"acme","kind":"organization","enabled":true,"repositories":["acme/api-gateway","acme/web-client","acme/web-platform"]},{"login":"octo-org","kind":"organization","enabled":true,"repositories":null},{"login":"octocat","kind":"user","enabled":true,"repositories":null}]'

gnome-shell --headless --wayland --no-x11 --wayland-display="$WAYLAND_DISPLAY" \
    --virtual-monitor 1280x800 >"$WORK/shell.log" 2>&1 &
SHELL_PID=$!

# Runs JavaScript in the shell and prints its result.
shell_eval() {
    local reply
    reply=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>/dev/null) || return 1
    [[ $reply == "(true, "* ]] || return 1
    # Eval returns JSON, so a string result arrives quoted.
    reply=${reply#(true, \'}
    reply=${reply%\')}
    reply=${reply#\"}
    printf '%s\n' "${reply%\"}"
}

# Polls a JavaScript condition until it reads true, for up to $2 seconds (20 by default).
wait_for() {
    for _ in $(seq $((${2:-20} * 5))); do
        [[ $(shell_eval "$1" || true) == true ]] && return 0
        sleep 0.2
    done
    echo "Timed out waiting for: $1" >&2
    tail -20 "$WORK/shell.log" >&2
    exit 1
}

# Captures the whole screen with the menu open, and widens MENU_LEFT and MENU_BOTTOM, the edges
# that crop_menus later applies to every menu capture.
MENU_LEFT=999999
MENU_BOTTOM=0
capture_menu() {
    local area
    wait_for "Main.layoutManager._startingUp === false && !${STATE}._indicator.menu.actor.get_transition('opacity')"
    sleep 0.5
    area=$(shell_eval "const a = ${STATE}._indicator.menu.actor;
        const [x, y] = a.get_transformed_position(); const [, h] = a.get_transformed_size();
        [Math.max(0, Math.floor(x) - 24), Math.min(global.stage.height, Math.ceil(y + h) + 24),
         global.stage.width, global.stage.height].join(' ')")
    read -r left bottom width height <<<"$area"
    ((left < MENU_LEFT)) && MENU_LEFT=$left
    ((bottom > MENU_BOTTOM)) && MENU_BOTTOM=$bottom
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.ScreenshotArea 0 0 "$width" "$height" false \
        "$OUT/$1" >/dev/null
}

# The README shows the menu captures side by side, so they share one size: the panel strip from
# the leftmost menu edge to the screen edge, down to the lowest menu bottom.
crop_menus() {
    for image in "$@"; do
        magick "$OUT/$image" -crop "+${MENU_LEFT}+0" -crop "x${MENU_BOTTOM}+0+0" +repage \
            "$OUT/$image"
    done
}

wait_for "Main.extensionManager.lookup('$UUID')?.state === 1"
STATE="Main.extensionManager.lookup('$UUID').stateObj"
wait_for "${STATE}._loading === false && ${STATE}._prs.length === 5"

shell_eval "${STATE}._indicator.menu.open()" >/dev/null
capture_menu menu.png

shell_eval "${STATE}._quickOpenEntry.set_text('web 142')" >/dev/null
wait_for "${STATE}._previewState?.status === 'ready' && !!${STATE}._previewItem"
capture_menu quick-open.png
shell_eval "${STATE}._indicator.menu.close()" >/dev/null
crop_menus menu.png quick-open.png

gnome-extensions prefs "$UUID"
# The preferences service can wait on portal timeouts before it shows its window.
PREFS="global.display.list_all_windows().find(w => w.get_wm_class() === 'org.gnome.Shell.Extensions')"
wait_for "!!$PREFS" 90
# Launched without a startup notification, the window opens unfocused; ScreenshotWindow
# captures the focused window.
shell_eval "$PREFS.activate(global.get_current_time())" >/dev/null
# Tall enough to show the owners below the general settings.
shell_eval "$PREFS.move_resize_frame(true, 280, 10, 720, 780)" >/dev/null
wait_for "$PREFS.has_focus()"
sleep 1.5
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.ScreenshotWindow true false false \
    "$OUT/preferences.png" >/dev/null

if grep -E 'JS (ERROR|WARNING)' "$WORK/shell.log"; then
    echo "The shell logged JavaScript errors; check the screenshots." >&2
fi
# Drop metadata such as creation time so unchanged screenshots stay byte-identical.
for image in "$OUT"/*.png; do
    magick "$image" -strip "$image"
done
echo "Screenshots written to $OUT"
