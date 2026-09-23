import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const SEARCH_LIMIT = 30;
// Fetch one extra result to show a truncation notice only when results were omitted.
const SEARCH_FETCH_LIMIT = SEARCH_LIMIT + 1;
const CHECK_FIELDS = 'bucket,name,workflow,state,completedAt,startedAt,link';
const SEARCH_FIELDS = 'number,title,url,repository,isDraft';

const STATUS = {
    success: {label: 'All checks passed', icon: 'checkbox-checked-symbolic'},
    pending: {label: 'Checks in progress', icon: 'view-refresh-symbolic'},
    failure: {label: 'Checks failed', icon: 'dialog-error-symbolic'},
    cancelled: {label: 'Checks cancelled', icon: 'dialog-warning-symbolic'},
    skipped: {label: 'Checks skipped', icon: 'dialog-information-symbolic'},
    none: {label: 'No checks', icon: 'dialog-information-symbolic'},
    unknown: {label: 'Status unavailable', icon: 'dialog-question-symbolic'},
};

/** Skipped checks are non-blocking, but at least one check must pass for green. */
function classifyChecks(checks) {
    if (checks.length === 0)
        return 'none';

    const buckets = checks.map(check => String(check.bucket ?? '').toLowerCase());
    if (buckets.includes('fail'))
        return 'failure';
    if (buckets.includes('cancel'))
        return 'cancelled';
    if (buckets.includes('pending'))
        return 'pending';
    if (buckets.every(bucket => bucket === 'pass' || bucket === 'skipping'))
        return buckets.includes('pass') ? 'success' : 'skipped';

    return 'pending';
}

/** Keeps a compact check-run fingerprint to spot a fresh green run between polls. */
function checksFingerprint(checks) {
    const contents = checks
        .map(check => [
            check.name ?? '',
            check.workflow ?? '',
            check.bucket ?? '',
            check.state ?? '',
            check.startedAt ?? '',
            check.completedAt ?? '',
        ].join('\u001f'))
        .sort()
        .join('\n');

    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, contents, -1);
}

/** Preserves a GHES host prefix because search may return PRs from another host. */
function repositoryArgument(pr) {
    const url = new URL(pr.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const pullIndex = parts.findIndex(part => part === 'pull');
    const repository = pr.repository;
    const fullName = typeof repository === 'string'
        ? repository
        : repository?.nameWithOwner
            ?? repository?.fullName
            ?? (repository?.owner?.login && repository?.name
                ? repository.owner.login + '/' + repository.name
                : null)
            ?? (pullIndex >= 2 ? parts.slice(0, pullIndex).join('/') : null);

    if (!fullName)
        throw new Error('Could not determine the pull request repository.');

    return url.hostname === 'github.com' ? fullName : url.hostname + '/' + fullName;
}

/**
 * Monitors the authenticated user's open PRs through the local gh CLI.
 * Calls run without a shell so user data and repository names stay separate arguments.
 */
export default class BabysitPRExtension extends Extension {
    enable() {
        this._enabled = true;
        this._settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._activeProcess = null;
        this._activeTimeoutId = 0;
        this._loading = false;
        this._error = null;
        this._prs = [];
        this._hasMorePullRequests = false;

        this._indicator = new PanelMenu.Button(0.0, 'BabysitPR', false);
        this._indicator.accessible_name = 'BabysitPR';
        const panelBox = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelIcon = new St.Icon({
            icon_name: 'view-list-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelLabel = new St.Label({
            text: 'PR',
            y_align: Clutter.ActorAlign.CENTER,
        });
        panelBox.add_child(this._panelIcon);
        panelBox.add_child(this._panelLabel);
        this._indicator.add_child(panelBox);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settingsSignal = this._settings.connect(
            'changed::refresh-interval',
            () => this._scheduleRefresh()
        );
        this._renderMenu();
        this._refresh();
        this._scheduleRefresh();
    }

    disable() {
        this._enabled = false;
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
        if (this._settingsSignal) {
            this._settings.disconnect(this._settingsSignal);
            this._settingsSignal = 0;
        }
        if (this._activeTimeoutId) {
            GLib.Source.remove(this._activeTimeoutId);
            this._activeTimeoutId = 0;
        }
        this._cancellable?.cancel();
        this._activeProcess?.force_exit();
        this._indicator?.destroy();

        this._settings = null;
        this._indicator = null;
        this._panelIcon = null;
        this._panelLabel = null;
        this._cancellable = null;
        this._activeProcess = null;
    }

    _scheduleRefresh() {
        if (!this._enabled)
            return;

        if (this._refreshSourceId)
            GLib.Source.remove(this._refreshSourceId);

        const interval = this._settings.get_int('refresh-interval');
        this._refreshSourceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshSourceId = 0;
                this._refresh();
                this._scheduleRefresh();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    async _runGh(args) {
        const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
        const launcher = new Gio.SubprocessLauncher({flags});
        launcher.setenv('GH_PROMPT_DISABLED', '1', true);
        const process = launcher.spawnv(['gh', ...args]);
        this._activeProcess = process;

        // A stalled network request must not permanently block future refreshes.
        this._activeTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._activeTimeoutId = 0;
            if (this._activeProcess === process)
                process.force_exit();
            return GLib.SOURCE_REMOVE;
        });

        return new Promise((resolve, reject) => {
            process.communicate_utf8_async(null, this._cancellable, (subprocess, result) => {
                if (this._activeProcess === subprocess)
                    this._activeProcess = null;
                if (this._activeTimeoutId) {
                    GLib.Source.remove(this._activeTimeoutId);
                    this._activeTimeoutId = 0;
                }
                try {
                    const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                    resolve({
                        exitCode: subprocess.get_if_exited() ? subprocess.get_exit_status() : -1,
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                    });
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    async _refresh() {
        if (!this._enabled || this._loading)
            return;

        this._loading = true;
        this._error = null;
        this._renderMenu();

        try {
            const search = await this._runGh([
                'search', 'prs',
                '--author', '@me',
                '--state', 'open',
                '--sort', 'updated',
                '--order', 'desc',
                '--limit', String(SEARCH_FETCH_LIMIT),
                '--json', SEARCH_FIELDS,
            ]);
            if (search.exitCode !== 0)
                throw new Error('gh search prs failed');

            const searchRows = JSON.parse(search.stdout);
            if (!Array.isArray(searchRows))
                throw new Error('gh search prs returned an unexpected response');

            const hasMorePullRequests = searchRows.length > SEARCH_LIMIT;
            const snapshot = [];
            for (const row of searchRows.slice(0, SEARCH_LIMIT)) {
                if (!this._enabled)
                    return;

                let repo = 'Unknown repository';
                let key = repo + '#' + row.number;
                try {
                    repo = repositoryArgument(row);
                    key = repo + '#' + row.number;
                    const result = await this._runGh([
                        'pr', 'checks', String(row.number),
                        '--repo', repo,
                        '--json', CHECK_FIELDS,
                    ]);

                    // gh pr checks uses exit code 8 when checks are still pending.
                    if (result.exitCode !== 0 && result.exitCode !== 8)
                        throw new Error('gh pr checks failed');

                    const checks = JSON.parse(result.stdout);
                    if (!Array.isArray(checks))
                        throw new Error('gh pr checks returned an unexpected response');

                    snapshot.push({
                        ...row,
                        repo,
                        key,
                        checks,
                        checkState: classifyChecks(checks),
                        fingerprint: checksFingerprint(checks),
                        checkError: false,
                    });
                } catch {
                    const previous = this._readCache()[key];
                    snapshot.push({
                        ...row,
                        repo,
                        key,
                        checks: [],
                        checkState: previous?.state ?? 'unknown',
                        fingerprint: '',
                        checkError: true,
                    });
                }
            }

            if (!this._enabled)
                return;

            this._updateNotificationCache(snapshot);
            this._prs = snapshot;
            this._hasMorePullRequests = hasMorePullRequests;
        } catch {
            if (!this._enabled)
                return;

            this._error = 'Could not refresh pull requests. Check that gh is installed ' +
                'and authenticated (gh auth status).';
            console.error('BabysitPR: failed to read pull requests.');
        } finally {
            if (this._enabled) {
                this._loading = false;
                this._updatePanel();
                this._renderMenu();
            }
        }
    }

    _readCache() {
        try {
            const cache = JSON.parse(this._settings.get_string('state-cache'));
            return cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
        } catch {
            return {};
        }
    }

    _updateNotificationCache(snapshot) {
        // The first complete read is a baseline; later reads alert only on a new green run.
        const initialized = this._settings.get_boolean('initialized');
        const previous = this._readCache();
        const allChecksRead = snapshot.every(pr => !pr.checkError);

        if (!initialized) {
            if (!allChecksRead)
                return;

            const baseline = {};
            for (const pr of snapshot)
                baseline[pr.key] = {state: pr.checkState, fingerprint: pr.fingerprint};
            this._settings.set_string('state-cache', JSON.stringify(baseline));
            this._settings.set_boolean('initialized', true);
            return;
        }

        const current = {};
        for (const pr of snapshot) {
            const old = previous[pr.key];
            if (pr.checkError) {
                if (old)
                    current[pr.key] = old;
                continue;
            }

            if (pr.checkState === 'success' &&
                (!old || old.state !== 'success' || old.fingerprint !== pr.fingerprint)) {
                Main.notify(
                    'BabysitPR',
                    pr.repo + ' #' + pr.number + ' is all green: ' + pr.title
                );
            }
            current[pr.key] = {state: pr.checkState, fingerprint: pr.fingerprint};
        }

        this._settings.set_string('state-cache', JSON.stringify(current));
    }

    _updatePanel() {
        if (!this._indicator)
            return;

        this._panelLabel.text = this._error ? 'PR !' : 'PR ' + this._prs.length;
        if (this._error ||
            this._prs.some(pr => pr.checkState === 'failure' || pr.checkState === 'cancelled'))
            this._panelIcon.icon_name = 'dialog-error-symbolic';
        else if (this._prs.length > 0 && this._prs.every(pr => pr.checkState === 'success'))
            this._panelIcon.icon_name = 'checkbox-checked-symbolic';
        else if (this._prs.some(pr => pr.checkState === 'pending'))
            this._panelIcon.icon_name = 'view-refresh-symbolic';
        else
            this._panelIcon.icon_name = 'view-list-symbolic';
    }

    _renderMenu() {
        if (!this._indicator)
            return;

        const menu = this._indicator.menu;
        menu.removeAll();

        const refreshItem = new PopupMenu.PopupMenuItem(
            this._loading ? 'Refreshing…' : 'Refresh now',
            {reactive: !this._loading, can_focus: !this._loading}
        );
        refreshItem.connect('activate', () => this._refresh());
        menu.addMenuItem(refreshItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (this._error) {
            menu.addMenuItem(new PopupMenu.PopupMenuItem(
                this._error,
                {reactive: false, can_focus: false}
            ));
        }

        if (this._prs.length === 0 && this._loading) {
            menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'Loading open pull requests…',
                {reactive: false, can_focus: false}
            ));
        } else if (this._prs.length === 0) {
            menu.addMenuItem(new PopupMenu.PopupMenuItem(
                this._error ? 'No previous state available.' : 'No open pull requests found.',
                {reactive: false, can_focus: false}
            ));
        } else {
            for (const pr of this._prs)
                menu.addMenuItem(this._createPullRequestItem(pr));

            if (this._hasMorePullRequests) {
                menu.addMenuItem(new PopupMenu.PopupMenuItem(
                    'Showing only the ' + SEARCH_LIMIT + ' most recently updated pull requests.',
                    {reactive: false, can_focus: false}
                ));
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const preferencesItem = new PopupMenu.PopupMenuItem('Preferences…');
        preferencesItem.connect('activate', () => this.openPreferences());
        menu.addMenuItem(preferencesItem);
    }

    _createPullRequestItem(pr) {
        const status = STATUS[pr.checkState] ?? STATUS.unknown;
        const item = new PopupMenu.PopupBaseMenuItem();
        const icon = new St.Icon({
            icon_name: status.icon,
            style_class: 'popup-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        icon.accessible_name = status.label;
        item.add_child(icon);

        const labels = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const title = new St.Label({
            text: pr.repo + ' #' + pr.number + ' · ' + pr.title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'max-width: 32em;',
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        let details = status.label;
        if (pr.checkError)
            details += ' · checks unavailable';
        else if (pr.checks.length > 0)
            details += ' · ' + pr.checks.length + ' checks';
        if (pr.isDraft)
            details += ' · draft';

        const detailLabel = new St.Label({
            text: details,
            style_class: 'dim-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        labels.add_child(title);
        labels.add_child(detailLabel);
        item.add_child(labels);
        item.connect('activate', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(pr.url, null);
            } catch {
                console.error('BabysitPR: could not open this pull request.');
            }
        });
        return item;
    }
}
