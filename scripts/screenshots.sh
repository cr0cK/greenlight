#!/usr/bin/env bash
# Regenerates the README screenshots in docs/screenshots/. Runs the checkout in a headless
# GNOME Shell on a private D-Bus session, with scripts/screenshots/gh, claude, codex, and agy standing
# in for the real CLIs, and systemd-mock for the user's systemd, so the images show fictional data
# and never a real account or machine.
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
    # The agy runner writes a no-op xdg-open under the cache directory, which stays in the scratch one.
    export XDG_CACHE_HOME=$WORK/cache
    # GNOME Shell starts ibus-daemon from PATH, and outside the desktop session it can outlive
    # the bus and grow without bound: a no-op stands in for it.
    mkdir -p "$WORK/bin"
    ln -sfn "$(type -P true)" "$WORK/bin/ibus-daemon"
    export PATH=$WORK/bin:$ROOT/scripts/screenshots:$PATH GTK_A11Y=none
    # The display name stays short: the Wayland socket path must fit in 108 bytes.
    export WAYLAND_DISPLAY=greenlight-shot
    exec dbus-run-session -- "$0" --inside
fi

SHELL_PID=
MOCK_PID=
cleanup() {
    [[ -n $SHELL_PID ]] && kill "$SHELL_PID" 2>/dev/null && wait "$SHELL_PID" 2>/dev/null
    [[ -n $MOCK_PID ]] && kill "$MOCK_PID" 2>/dev/null
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
 "shell-version": ["49", "50"]}
JSON
cat > "$EXTENSIONS/unsafe@screenshots/extension.js" <<'JS'
export default class {
    enable() { global.context.unsafe_mode = true; }
    disable() {}
}
JS

# The private bus has no systemd: the mock serves the fictional timers of routines.json on it.
systemd-mock "$ROOT/scripts/screenshots/routines.json" >"$WORK/systemd-mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 50); do
    grep -q ready "$WORK/systemd-mock.log" && break
    sleep 0.1
done

gs() { gsettings set "$@"; }
gs org.gnome.shell enabled-extensions "['$UUID', 'unsafe@screenshots']"
gs org.gnome.shell disable-user-extensions false
gs org.gnome.shell welcome-dialog-last-shown-version "'999'"
gs org.gnome.desktop.interface color-scheme "'prefer-dark'"
EXT=org.gnome.shell.extensions.greenlight
gs $EXT author-filter "''"
gs $EXT owner-filters-configured true
# The order of the owner blocks and of the menu sections, which keeps the menu captures as they
# were: the kind-then-login order would put the personal account first.
gs $EXT owner-order "['acme', 'octo-org', 'octocat']"
gs $EXT claude-quota-enabled true
gs $EXT codex-quota-enabled true
gs $EXT agy-quota-enabled true
# old-mirror is not loaded by systemd: the menu leaves it out, and the preferences keep its row.
gs $EXT watched-routines "['backup-photos.timer', 'clean-downloads.timer', 'nightly-report.timer', 'old-mirror.timer', 'sync-mail.timer']"
gs $EXT owner-filters '[{"login":"acme","kind":"organization","enabled":true,"repositories":["acme/api-gateway","acme/web-client","acme/web-platform"]},{"login":"octo-org","kind":"organization","enabled":true,"repositories":null},{"login":"octocat","kind":"user","enabled":true,"repositories":null,"excludedRepositories":["octocat/hello-world"]}]'

# The menu captures need an 800 px screen, as the menu height follows it; the preferences window
# gets a taller one in a second run (see below).
start_shell() {
    gnome-shell --headless --wayland --no-x11 --wayland-display="$WAYLAND_DISPLAY" \
        --virtual-monitor "$1" >>"$WORK/shell.log" 2>&1 &
    SHELL_PID=$!
}
start_shell 1280x800

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
wait_for "!!${STATE}._quotaState.claude?.windows && !!${STATE}._quotaState.codex?.windows && !!${STATE}._quotaState.agy?.windows"
wait_for "${STATE}._routineWatcher.firstRead === true && ${STATE}._routineRows.box.get_children().length === 4"

shell_eval "${STATE}._indicator.menu.open()" >/dev/null
capture_menu menu.png

shell_eval "${STATE}._quickOpenEntry.set_text('142')" >/dev/null
wait_for "${STATE}._previewState?.status === 'ready' && !!${STATE}._previewItem"
capture_menu quick-open.png
shell_eval "${STATE}._indicator.menu.close()" >/dev/null
crop_menus menu.png quick-open.png

# Restart on a tall screen: the window must show the first owner block, with its move buttons,
# below the general settings.
kill "$SHELL_PID"
wait "$SHELL_PID" 2>/dev/null || true
start_shell 1280x1700
wait_for "Main.extensionManager.lookup('$UUID')?.state === 1"

gnome-extensions prefs "$UUID"
# The preferences service can wait on portal timeouts before it shows its window.
PREFS="global.display.list_all_windows().find(w => w.get_wm_class() === 'org.gnome.Shell.Extensions')"
wait_for "!!$PREFS" 90
# Launched without a startup notification, the window opens unfocused; ScreenshotWindow
# captures the focused window.
# A session that starts in the overview would keep the window unfocused.
shell_eval "Main.overview.hide()" >/dev/null
wait_for "Main.overview.visible === false"
shell_eval "$PREFS.activate(global.get_current_time())" >/dev/null
shell_eval "$PREFS.move_resize_frame(true, 280, 10, 720, 1600)" >/dev/null
wait_for "$PREFS.has_focus()"
sleep 1.5
capture_window() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.ScreenshotWindow true false false \
        "$OUT/$1" >/dev/null
}
capture_window preferences.png

# Presses keys, given as decimal keyvals, on a virtual keyboard, as a user's hands would: the
# keys of one call are held together, then released in reverse order.
press_keys() {
    shell_eval "const Clutter = imports.gi.Clutter;
        globalThis.__keyboard ??= Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const time = () => global.get_current_time() * 1000;
        for (const key of [$1]) globalThis.__keyboard.notify_keyval(time(), key, Clutter.KeyState.PRESSED);
        for (const key of [$1].reverse())
            globalThis.__keyboard.notify_keyval(time(), key, Clutter.KeyState.RELEASED);
        'ok'" >/dev/null
    sleep 0.4
}
SHIFT_TAB=65505,65056 RIGHT=65363 RETURN=65293
# The window opens with nothing focused: two Shift+Tab reach the tab switcher, an arrow key moves
# along it, and Return shows the tab. No product-side hook is involved.
press_keys $SHIFT_TAB
press_keys $SHIFT_TAB
press_keys $RIGHT
press_keys $RETURN
# These tabs are short: shrink the window so the captures hold no empty page.
shell_eval "$PREFS.move_resize_frame(true, 280, 10, 720, 520)" >/dev/null
wait_for "$PREFS.get_frame_rect().height === 520"
sleep 1.5
capture_window preferences-agents.png
press_keys $RIGHT
press_keys $RETURN
# The Routines tab reads the mock when the window opens: it lists its timers by now.
shell_eval "$PREFS.move_resize_frame(true, 280, 10, 720, 520)" >/dev/null
sleep 1.5
capture_window preferences-routines.png
press_keys $RIGHT
press_keys $RETURN
shell_eval "$PREFS.move_resize_frame(true, 280, 10, 720, 340)" >/dev/null
wait_for "$PREFS.get_frame_rect().height === 340"
sleep 1.5
capture_window preferences-about.png

if grep -E 'JS (ERROR|WARNING)' "$WORK/shell.log"; then
    echo "The shell logged JavaScript errors; check the screenshots." >&2
fi
# Drop metadata such as creation time so unchanged screenshots stay byte-identical.
for image in "$OUT"/*.png; do
    magick "$image" -strip "$image"
done
echo "Screenshots written to $OUT"
