import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {nextSearchLimit, readOwnerFilters, searchScopes} from './filters.js';
import {
    MAX_SUGGESTIONS,
    parseQuickOpenQuery,
    quickOpenSuggestions,
    readRecentRepositories,
    rememberRepository,
} from './quickopen.js';
import {parseMarkdown} from './markdown.js';
import {
    labelColors,
    lookupArguments,
    parseLookupResponse,
    parsePreviewResponse,
    previewArguments,
} from './preview.js';

const SEARCH_LIMIT = 30;
const SEARCH_FETCH_LIMIT = SEARCH_LIMIT + 1;
const FILTER_REFRESH_DELAY_MS = 600;
const CHECK_FIELDS = 'bucket,name,workflow,state,completedAt,startedAt,link';
const SEARCH_FIELDS = 'number,title,url,repository,author,isDraft,updatedAt,labels';
// Labels beyond this count collapse into a +N badge, so the title keeps its room.
const ROW_LABEL_LIMIT = 3;
const PREVIEW_DELAY_MS = 350;
// Pointer sweeps across suggestions should not reflow the menu under the pointer.
const PREVIEW_FOCUS_DELAY_MS = 150;
const PREVIEW_CACHE_US = 60 * GLib.USEC_PER_SEC;
const PREVIEW_BAR_WIDTH = 140;
const LOOKUP_LIMIT = 20;
const QUOTE_COLORS = {
    note: '#4493f8',
    tip: '#3fb950',
    important: '#ab7df8',
    warning: '#d29922',
    caution: '#f85149',
};

const PREVIEW_STATES = {
    open: {label: 'Open', color: '#276746'},
    draft: {label: 'Draft', color: '#55565e'},
    merged: {label: 'Merged', color: '#6d3fae'},
    closed: {label: 'Closed', color: '#922c31'},
    completed: {label: 'Closed', color: '#6d3fae'},
};

const STATUS = {
    success: {label: 'Checks green', icon: 'checkbox-checked-symbolic', color: '#26a269'},
    pending: {label: 'Checks in progress', icon: 'view-refresh-symbolic', color: '#e5a50a'},
    failure: {label: 'Checks failed', icon: 'dialog-error-symbolic', color: '#c01c28'},
    cancelled: {label: 'Checks cancelled', icon: 'dialog-warning-symbolic', color: '#77767b'},
    skipped: {label: 'Checks skipped', icon: 'dialog-information-symbolic', color: '#77767b'},
    none: {label: 'No checks', icon: 'dialog-information-symbolic', color: '#77767b'},
    unknown: {label: 'Checks unavailable', icon: 'dialog-warning-symbolic', color: '#c01c28'},
};

/** Counts gh check buckets and classifies skipped checks as green only with a real pass. */
function summarizeChecks(checks) {
    const summary = {
        total: checks.length,
        passed: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
        cancelled: 0,
        unknown: 0,
        state: 'unknown',
    };

    for (const check of checks) {
        switch (String(check.bucket ?? '').toLowerCase()) {
        case 'pass':
            summary.passed++;
            break;
        case 'fail':
            summary.failed++;
            break;
        case 'pending':
            summary.pending++;
            break;
        case 'skipping':
            summary.skipped++;
            break;
        case 'cancel':
            summary.cancelled++;
            break;
        default:
            summary.unknown++;
            break;
        }
    }

    if (summary.total === 0)
        summary.state = 'none';
    else if (summary.failed > 0)
        summary.state = 'failure';
    else if (summary.pending > 0 || summary.unknown > 0)
        summary.state = 'pending';
    else if (summary.cancelled > 0)
        summary.state = 'cancelled';
    else if (summary.passed > 0)
        summary.state = 'success';
    else if (summary.skipped === summary.total)
        summary.state = 'skipped';

    return summary;
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

/** Names the repository for gh --repo, with its host when it is not github.com. */
function repositoryArgument(pr) {
    const host = GLib.Uri.parse(pr.url, GLib.UriFlags.NONE).get_host();
    if (!host)
        throw new Error('Could not determine the pull request host.');

    const fullName = pr.repository.nameWithOwner;
    return host.toLowerCase() === 'github.com' ? fullName : host + '/' + fullName;
}

function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
        return true;
    } catch {
        console.error('Greenlight: could not open ' + uri);
        return false;
    }
}

/** Gives filter changes a stable notification baseline independent of UI row order. */
function filterSignature(settings) {
    const owners = readOwnerFilters(settings)
        .sort((first, second) => first.login.toLowerCase().localeCompare(second.login.toLowerCase()))
        .map(owner => ({
            login: owner.login.toLowerCase(),
            kind: owner.kind,
            enabled: owner.enabled,
            repositories: owner.repositories === null
                ? null
                : [...owner.repositories].map(name => name.toLowerCase()).sort(),
            excludedRepositories: owner.excludedRepositories
                .map(name => name.toLowerCase()).sort(),
        }));
    return JSON.stringify({
        configured: settings.get_boolean('owner-filters-configured'),
        owners,
        author: settings.get_string('author-filter').trim(),
    });
}

/** Groups PR rows by owner and keeps each section ordered by last update. */
function groupPullRequestsByOwner(pullRequests) {
    const groups = new Map();
    for (const pullRequest of pullRequests) {
        const owner = pullRequest.owner || 'Unknown owner';
        if (!groups.has(owner))
            groups.set(owner, []);
        groups.get(owner).push(pullRequest);
    }

    return [...groups.entries()]
        .map(([owner, pullRequests]) => ({
            owner,
            pullRequests: pullRequests.sort(compareUpdatedPullRequests),
            latestUpdate: Date.parse(pullRequests[0]?.updatedAt ?? '') || 0,
        }))
        .sort((first, second) => second.latestUpdate - first.latestUpdate ||
            first.owner.localeCompare(second.owner));
}

/** Creates a compact semantic badge with a high-contrast label for CI and review metadata. */
function createBadge(text, background, accessibleName = text, foreground = '#ffffff') {
    const badge = new St.Label({
        text,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'padding: 1px 6px; border-radius: 6px; background-color: ' + background +
            '; color: ' + foreground + '; font-size: 0.9em; font-weight: 600;',
    });
    badge.accessible_name = accessibleName;
    return badge;
}

/** Creates a badge in the label's GitHub color; long names ellipsize. */
function createLabelBadge(label) {
    const {background, foreground} = labelColors(label.color);
    const badge = createBadge(label.name, background, 'Label ' + label.name, foreground);
    badge.style += ' max-width: 12em;';
    return badge;
}

/** Identifies a previewable suggestion; previews only exist for github.com URLs. */
function previewKey(suggestion) {
    return suggestion?.url?.startsWith('https://github.com/')
        ? suggestion.repository.toLowerCase() + '#' + suggestion.number
        : null;
}

/** St labels ellipsize by default, which silently disables line wrapping. */
function wrapLabel(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
}

/** Secondary text; the Shell theme has no dim-label class, so opacity does the dimming. */
function createDimLabel(text, params = {}) {
    return new St.Label({
        text,
        opacity: 170,
        y_align: Clutter.ActorAlign.CENTER,
        ...params,
    });
}

/** Orders results locally as a fallback when a GitHub host ignores search sorting. */
function compareUpdatedPullRequests(first, second) {
    const firstTime = Date.parse(first.updatedAt ?? '') || 0;
    const secondTime = Date.parse(second.updatedAt ?? '') || 0;
    return secondTime - firstTime;
}

/**
 * Monitors open PRs through the active gh account, owner, repository, and author filters.
 * Calls run without a shell so user data and repository names stay separate arguments.
 */
export default class GreenlightExtension extends Extension {
    enable() {
        this._enabled = true;
        this._settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._processes = new Map();
        this._loading = false;
        this._error = null;
        this._prs = [];
        this._hasMorePullRequests = false;
        this._hasNoScopes = false;
        this._filterRefreshSourceId = 0;
        this._refreshAfterCurrent = false;

        this._indicator = new PanelMenu.Button(0.0, 'Greenlight', false);
        this._indicator.accessible_name = 'Greenlight';
        const panelBox = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelIcon = new St.Icon({
            gicon: Gio.FileIcon.new(
                this.dir.get_child('greenlight-pr-symbolic.svg')
            ),
            icon_size: 16,
            style_class: 'system-status-icon',
        });
        this._panelIcon.accessible_name = 'Pull request monitor';
        this._panelLabel = new St.Label({
            text: 'PR',
            y_align: Clutter.ActorAlign.CENTER,
        });
        panelBox.add_child(this._panelIcon);
        panelBox.add_child(this._panelLabel);
        this._indicator.add_child(panelBox);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._buildMenu();
        Main.wm.addKeybinding(
            'quick-open-shortcut',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._indicator.menu.toggle()
        );

        this._settingsSignals = [
            this._settings.connect('changed::refresh-interval', () => this._scheduleRefresh()),
            this._settings.connect('changed::owner-filters', () => this._scheduleFilterRefresh()),
            this._settings.connect('changed::owner-filters-configured', () => this._scheduleFilterRefresh()),
            this._settings.connect('changed::author-filter', () => this._scheduleFilterRefresh()),
        ];
        this._renderMenu();
        this._refresh();
        this._scheduleRefresh();
    }

    disable() {
        this._enabled = false;
        Main.wm.removeKeybinding('quick-open-shortcut');
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
        for (const signal of this._settingsSignals ?? [])
            this._settings.disconnect(signal);
        this._settingsSignals = [];
        for (const entry of this._processes.values()) {
            if (entry.timeoutId)
                GLib.Source.remove(entry.timeoutId);
            entry.timeoutId = 0;
            entry.process.force_exit();
        }
        this._processes.clear();
        if (this._filterRefreshSourceId) {
            GLib.Source.remove(this._filterRefreshSourceId);
            this._filterRefreshSourceId = 0;
        }
        this._hasNoScopes = false;
        if (this._previewSourceId) {
            GLib.Source.remove(this._previewSourceId);
            this._previewSourceId = 0;
        }
        this._clearPreviewFocusTimer();
        this._previewCancellable?.cancel();
        this._previewCancellable = null;
        this._previewState = null;
        this._previewItem = null;
        this._previewCache = null;
        this._cancelLookup();
        this._lookupCache = null;
        this._setPointerCursor(false);
        this._cancellable?.cancel();
        this._indicator?.destroy();

        this._settings = null;
        this._indicator = null;
        this._panelIcon = null;
        this._panelLabel = null;
        this._refreshSection = null;
        this._quickOpenEntry = null;
        this._quickOpenSection = null;
        this._quickOpenItems = [];
        this._quickOpenSuggestions = [];
        this._contentSection = null;
        this._contentScrollView = null;
        this._pullRequestItems = [];
        this._cancellable = null;
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

    _scheduleFilterRefresh() {
        if (!this._enabled)
            return;

        if (this._filterRefreshSourceId)
            GLib.Source.remove(this._filterRefreshSourceId);

        this._filterRefreshSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            FILTER_REFRESH_DELAY_MS,
            () => {
                this._filterRefreshSourceId = 0;
                if (this._loading)
                    this._refreshAfterCurrent = true;
                else
                    this._refresh();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /** Runs gh concurrently with other calls; cancelling the cancellable stops the process. */
    async _runGh(args, cancellable = this._cancellable) {
        const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
        const launcher = new Gio.SubprocessLauncher({flags});
        launcher.setenv('GH_PROMPT_DISABLED', '1', true);
        const process = launcher.spawnv(['gh', ...args]);
        const entry = {process, timeoutId: 0};
        this._processes.set(process, entry);

        // A stalled network request must not permanently block future refreshes.
        entry.timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            entry.timeoutId = 0;
            process.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        const cancelledId = cancellable.connect(() => process.force_exit());

        return new Promise((resolve, reject) => {
            process.communicate_utf8_async(null, cancellable, (subprocess, result) => {
                this._processes.delete(subprocess);
                cancellable.disconnect(cancelledId);
                if (entry.timeoutId) {
                    GLib.Source.remove(entry.timeoutId);
                    entry.timeoutId = 0;
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
        if (!this._enabled)
            return;
        if (this._loading) {
            if (this._filterRefreshSourceId) {
                GLib.Source.remove(this._filterRefreshSourceId);
                this._filterRefreshSourceId = 0;
                this._refreshAfterCurrent = true;
            }
            return;
        }
        if (this._filterRefreshSourceId) {
            GLib.Source.remove(this._filterRefreshSourceId);
            this._filterRefreshSourceId = 0;
        }

        this._loading = true;
        this._error = null;
        this._renderMenu();

        const authorFilter = this._settings.get_string('author-filter').trim();
        const scopes = this._settings.get_boolean('owner-filters-configured')
            ? searchScopes(readOwnerFilters(this._settings), authorFilter)
            : [{type: 'all', values: [], excluded: [], hidden: []}];
        const hasNoScopes = this._settings.get_boolean('owner-filters-configured') &&
            scopes.length === 0;
        const currentFilterSignature = filterSignature(this._settings);

        try {
            const searchRowsByKey = new Map();
            let truncatedSearch = false;
            for (const scope of scopes) {
                const searchArgs = ['search', 'prs'];
                if (authorFilter)
                    searchArgs.push('--author', authorFilter);
                if (scope.type === 'owners') {
                    for (const owner of scope.values)
                        searchArgs.push('--owner', owner);
                } else if (scope.type === 'repositories') {
                    for (const repository of scope.values)
                        searchArgs.push('--repo', repository);
                }
                searchArgs.push(
                    '--archived=false',
                    '--state', 'open',
                    '--sort', 'updated',
                    '--order', 'desc',
                    '--json', SEARCH_FIELDS
                );
                // Exclusions are query terms; `--` keeps gh from reading them as flags.
                const queryTerms = scope.excluded.length > 0
                    ? ['--', ...scope.excluded.map(name => '-repo:' + name)]
                    : [];

                const allowedValues = new Set(scope.values.map(value => value.toLowerCase()));
                const hidden = new Set(scope.hidden.map(name => name.toLowerCase()));
                let limit = SEARCH_FETCH_LIMIT;
                let rows;
                while (limit !== null) {
                    const search = await this._runGh(
                        [...searchArgs, '--limit', String(limit), ...queryTerms]
                    );
                    if (search.exitCode !== 0)
                        throw new Error('gh search prs failed');

                    const response = JSON.parse(search.stdout);
                    if (!Array.isArray(response))
                        throw new Error('gh search prs returned an unexpected response');

                    rows = response.filter(row => {
                        const fullName = row.repository?.nameWithOwner?.toLowerCase();
                        if (!fullName || hidden.has(fullName))
                            return false;
                        return scope.type === 'owners'
                            ? allowedValues.has(fullName.split('/')[0])
                            : scope.type === 'repositories'
                                ? allowedValues.has(fullName)
                                : true;
                    });
                    // Exclusions that did not fit in the query are filtered here, so a full
                    // page can come back short; fetch more until the scope fills its share.
                    const next = hidden.size > 0
                        ? nextSearchLimit(limit, response.length, rows.length, SEARCH_FETCH_LIMIT)
                        : null;
                    if (next === null && response.length === limit && rows.length < SEARCH_FETCH_LIMIT)
                        truncatedSearch = true;
                    limit = next;
                }
                for (const row of rows) {
                    const fullName = row.repository.nameWithOwner.toLowerCase();
                    searchRowsByKey.set(fullName + '#' + row.number, row);
                }
            }

            const searchRows = [...searchRowsByKey.values()];
            searchRows.sort(compareUpdatedPullRequests);
            const hasMorePullRequests = searchRows.length > SEARCH_LIMIT || truncatedSearch;
            const snapshot = [];
            for (const row of searchRows.slice(0, SEARCH_LIMIT)) {
                if (!this._enabled)
                    return;

                const [owner, repositoryName] = row.repository.nameWithOwner.split('/');
                let repo = row.repository.nameWithOwner;
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

                    const checkSummary = summarizeChecks(checks);
                    snapshot.push({
                        ...row,
                        repo,
                        owner,
                        repositoryName,
                        key,
                        checks,
                        checkSummary,
                        checkState: checkSummary.state,
                        fingerprint: checksFingerprint(checks),
                        checkError: false,
                    });
                } catch {
                    const previous = this._readCache()[key];
                    snapshot.push({
                        ...row,
                        repo,
                        owner,
                        repositoryName,
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

            const latestFilterSignature = filterSignature(this._settings);
            if (latestFilterSignature !== currentFilterSignature) {
                // Discard results from filters the user has already replaced.
                this._refreshAfterCurrent = true;
                return;
            }

            this._updateNotificationCache(snapshot, currentFilterSignature);
            this._prs = snapshot;
            this._hasMorePullRequests = hasMorePullRequests;
            this._hasNoScopes = hasNoScopes;
        } catch {
            if (!this._enabled)
                return;

            this._error = 'Could not refresh pull requests. Check that gh is installed ' +
                'and authenticated (gh auth status).';
            console.error('Greenlight: failed to read pull requests.');
        } finally {
            if (this._enabled) {
                this._loading = false;
                this._updatePanel();
                this._renderMenu();
                if (this._refreshAfterCurrent) {
                    this._refreshAfterCurrent = false;
                    this._scheduleFilterRefresh();
                }
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

    _updateNotificationCache(snapshot, filterSignature) {
        // A filter change starts a new baseline so existing green PRs do not alert immediately.
        const initialized = this._settings.get_boolean('initialized');
        const filterChanged = this._settings.get_string('last-filter') !== filterSignature;
        const previous = this._readCache();
        const allChecksRead = snapshot.every(pr => !pr.checkError);

        if (!initialized || filterChanged) {
            if (!allChecksRead)
                return;

            const baseline = {};
            for (const pr of snapshot)
                baseline[pr.key] = {state: pr.checkState, fingerprint: pr.fingerprint};
            this._settings.set_string('state-cache', JSON.stringify(baseline));
            this._settings.set_string('last-filter', filterSignature);
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
                    'Greenlight',
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
    }

    /** Builds persistent menu sections so refreshes never reset text typed in quick open. */
    _buildMenu() {
        const menu = this._indicator.menu;
        this._refreshSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._refreshSection);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const entryItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._quickOpenEntry = new St.Entry({
            hint_text: 'Open issue or PR: repo #42, owner/repo#42, #42 or URL',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({
                icon_name: 'edit-find-symbolic',
                style_class: 'popup-menu-icon',
            }),
        });
        this._quickOpenEntry.accessible_name = 'Open an issue or pull request by repository and number';
        entryItem.add_child(this._quickOpenEntry);
        menu.addMenuItem(entryItem);
        this._quickOpenSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._quickOpenSection);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Only the pull request list scrolls, so the menu fits the screen while quick open,
        // its preview, and Preferences stay in view. The panel menu caps its height.
        this._contentSection = new PopupMenu.PopupMenuSection();
        this._contentScrollView = new St.ScrollView({
            style_class: 'vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        // The overlay scrollbar is drawn over the last pixels of the rows, next to their open
        // icon; this gutter keeps it clear of the rows and lines them up with the quick open field.
        this._contentSection.box.style = 'padding-right: 12px;';
        this._contentScrollView.set_child(this._contentSection.box);
        this._contentScrollView._delegate = this._contentSection;
        this._contentSection.actor = this._contentScrollView;
        menu.addMenuItem(this._contentSection);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const preferencesItem = new PopupMenu.PopupMenuItem('Preferences…');
        preferencesItem.connect('activate', () => this.openPreferences());
        menu.addMenuItem(preferencesItem);
        this._quickOpenItems = [];
        this._quickOpenSuggestions = [];
        this._previewSourceId = 0;
        this._previewFocusSourceId = 0;
        this._previewCancellable = null;
        this._previewState = null;
        this._previewItem = null;
        // Monotonic time before which a list preview must not scroll into view.
        this._previewRevealTime = 0;
        this._previewCache = new Map();
        this._pullRequestItems = [];
        this._lookupSourceId = 0;
        this._lookupCancellable = null;
        this._lookupState = null;
        this._lookupCache = new Map();

        const text = this._quickOpenEntry.clutter_text;
        text.connect('text-changed', () => this._renderQuickOpen());
        text.connect('activate', () => {
            const suggestion = this._quickOpenSuggestions.find(candidate => candidate.url);
            if (suggestion) {
                this._openQuickOpenSuggestion(suggestion);
                menu.close();
            }
        });
        text.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Down || !this._quickOpenItems.length)
                return Clutter.EVENT_PROPAGATE;
            this._quickOpenItems[0].grab_key_focus();
            return Clutter.EVENT_STOP;
        });

        // Connected after the panel menu manager, so this focus wins over its modal grab.
        menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                global.stage.set_key_focus(this._quickOpenEntry);
            } else {
                this._quickOpenEntry.set_text('');
                this._setPreviewTarget(null);
                this._setPointerCursor(false);
            }
        });
    }

    /** Collects repositories quick open can suggest without any network request. */
    _quickOpenRepositories() {
        return [
            ...readRecentRepositories(this._settings),
            ...this._prs.map(pr => pr.owner + '/' + pr.repositoryName),
            ...readOwnerFilters(this._settings)
                .filter(owner => owner.enabled)
                .flatMap(owner => owner.repositories ?? []),
        ];
    }

    _renderQuickOpen() {
        this._clearPreviewFocusTimer();
        this._quickOpenSection.removeAll();
        this._quickOpenItems = [];
        const text = this._quickOpenEntry.get_text();
        const {repositoryQuery, number, url} = parseQuickOpenQuery(text);
        const candidates = quickOpenSuggestions(
            text,
            this._quickOpenRepositories(),
            readRecentRepositories(this._settings),
            {limit: LOOKUP_LIMIT}
        );

        // Several repositories could hold the number: list only those where it exists.
        let lookup = null;
        if (number !== null && !url && candidates.length > 1)
            lookup = this._lookupSuggestions(candidates);
        else
            this._cancelLookup();
        this._quickOpenSuggestions = lookup?.status === 'loading'
            ? []
            : (lookup?.status === 'ready' ? lookup.suggestions : candidates).slice(0, MAX_SUGGESTIONS);
        if (!text.trim()) {
            this._setPreviewTarget(null);
            return;
        }

        if (lookup?.status === 'loading' || this._quickOpenSuggestions.length === 0) {
            this._setPreviewTarget(null);
            let message;
            if (lookup?.status === 'loading')
                message = 'Looking up #' + number + ' in ' + candidates.length + ' repositories…';
            else if (lookup?.status === 'ready')
                message = '#' + number + ' not found in ' + candidates.length + ' repositories';
            else if (repositoryQuery)
                message = 'No watched repository matches "' + repositoryQuery + '"';
            else
                message = 'No watched repositories yet. Type owner/repo #number.';
            this._quickOpenSection.addMenuItem(new PopupMenu.PopupMenuItem(
                message,
                {reactive: false, can_focus: false}
            ));
            return;
        }

        for (const suggestion of this._quickOpenSuggestions) {
            const actionable = suggestion.url !== null;
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: actionable,
                can_focus: actionable,
            });
            const repository = actionable
                ? new St.Label({text: suggestion.repository, y_align: Clutter.ActorAlign.CENTER})
                : createDimLabel(suggestion.repository);
            repository.x_expand = !suggestion.title;
            repository.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            item.add_child(repository);
            if (suggestion.title) {
                const title = createDimLabel(suggestion.title, {
                    x_expand: true,
                    style: 'max-width: 22em; margin-left: 4px;',
                });
                title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                item.add_child(title);
            }
            if (actionable) {
                item.add_child(createBadge('#' + suggestion.number, '#3c5268'));
                if (this._quickOpenItems.length === 0)
                    item.add_child(createDimLabel('↵'));
                item.accessible_name = 'Open ' + suggestion.repository + ' #' + suggestion.number;
                item.connect('activate', () => this._openQuickOpenSuggestion(suggestion));
                item.connect('key-focus-in', () =>
                    this._schedulePreviewTarget(suggestion, 'quick-open', PREVIEW_FOCUS_DELAY_MS));
                item._previewKey = previewKey(suggestion);
                this._quickOpenItems.push(item);
            } else {
                item.add_child(createDimLabel('add a number'));
            }
            this._quickOpenSection.addMenuItem(item);
        }
        this._setPreviewTarget(this._quickOpenSuggestions.find(candidate => candidate.url) ?? null);
    }

    _schedulePreviewTarget(suggestion, source, delay) {
        this._clearPreviewFocusTimer();
        this._previewFocusSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._previewFocusSourceId = 0;
            this._setPreviewTarget(suggestion, source);
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearPreviewFocusTimer() {
        if (this._previewFocusSourceId) {
            GLib.Source.remove(this._previewFocusSourceId);
            this._previewFocusSourceId = 0;
        }
    }

    /**
     * Keeps the candidates where the number exists, with their titles. Answers from cache when
     * every candidate is known, otherwise starts one debounced batched request and reports
     * loading; a failed request falls back to the unfiltered candidates.
     */
    _lookupSuggestions(candidates) {
        const number = candidates[0].number;
        const now = GLib.get_monotonic_time();
        const known = candidates.map(candidate => {
            const entry = this._lookupCache.get(candidate.repository.toLowerCase() + '#' + number);
            return entry && now - entry.time < PREVIEW_CACHE_US ? entry : null;
        });
        if (known.every(Boolean)) {
            this._cancelLookup();
            return {
                status: 'ready',
                suggestions: candidates
                    .map((candidate, index) => ({...candidate, title: known[index].title}))
                    .filter((_candidate, index) => known[index].found),
            };
        }

        const key = candidates.map(candidate => candidate.repository.toLowerCase()).join(' ') +
            '#' + number;
        if (this._lookupState?.key === key)
            return {status: this._lookupState.status};

        this._cancelLookup();
        const state = {key, status: 'loading'};
        this._lookupState = state;
        this._lookupSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_DELAY_MS, () => {
            this._lookupSourceId = 0;
            this._runLookup(state, candidates.map(candidate => candidate.repository), number);
            return GLib.SOURCE_REMOVE;
        });
        return {status: 'loading'};
    }

    async _runLookup(state, repositories, number) {
        const cancellable = new Gio.Cancellable();
        this._lookupCancellable = cancellable;
        try {
            // gh exits with 1 when any alias is NOT_FOUND but still prints every result.
            const result = await this._runGh(lookupArguments(repositories, number), cancellable);
            const time = GLib.get_monotonic_time();
            for (const {repository, found, title} of parseLookupResponse(result.stdout, repositories))
                this._lookupCache.set(repository.toLowerCase() + '#' + number, {time, found, title});
        } catch {
            if (!cancellable.is_cancelled()) {
                console.error('Greenlight: could not look up the issue or pull request number.');
                state.status = 'error';
            }
        }

        if (cancellable.is_cancelled() || this._lookupState !== state)
            return;
        this._lookupCancellable = null;
        this._renderQuickOpen();
    }

    _cancelLookup() {
        if (this._lookupSourceId) {
            GLib.Source.remove(this._lookupSourceId);
            this._lookupSourceId = 0;
        }
        this._lookupCancellable?.cancel();
        this._lookupCancellable = null;
        this._lookupState = null;
    }

    /**
     * Shows a cached preview at once, or a loading state followed by a debounced gh request.
     * The source says where the preview goes: under a quick open suggestion or a listed PR.
     */
    _setPreviewTarget(suggestion, source = 'quick-open') {
        const key = previewKey(suggestion);
        if (key === (this._previewState?.key ?? null) &&
            (!key || source === this._previewState.source)) {
            // Rows may have been rebuilt, so put the preview back under its target.
            this._renderPreview();
            return;
        }

        if (this._previewSourceId) {
            GLib.Source.remove(this._previewSourceId);
            this._previewSourceId = 0;
        }
        this._previewCancellable?.cancel();
        this._previewCancellable = null;

        const cached = key ? this._previewCache.get(key) : null;
        if (!key) {
            this._previewState = null;
        } else if (cached && GLib.get_monotonic_time() - cached.time < PREVIEW_CACHE_US) {
            this._previewState = {
                key,
                source,
                suggestion,
                status: cached.preview ? 'ready' : 'missing',
                preview: cached.preview,
            };
        } else {
            const state = {key, source, suggestion, status: 'loading', preview: null};
            this._previewState = state;
            this._previewSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIEW_DELAY_MS, () => {
                this._previewSourceId = 0;
                this._loadPreview(state);
                return GLib.SOURCE_REMOVE;
            });
        }
        this._renderPreview();
    }

    async _loadPreview(state) {
        const cancellable = new Gio.Cancellable();
        this._previewCancellable = cancellable;
        let status = 'error';
        let preview = null;
        try {
            const result = await this._runGh(
                previewArguments(state.suggestion.repository, state.suggestion.number),
                cancellable
            );
            // gh exits with 1 for NOT_FOUND but still prints the GraphQL response.
            preview = parsePreviewResponse(result.stdout);
            status = preview ? 'ready' : 'missing';
            this._previewCache.set(state.key, {time: GLib.get_monotonic_time(), preview});
        } catch {
            if (!cancellable.is_cancelled())
                console.error('Greenlight: could not load the issue or pull request preview.');
        }

        if (cancellable.is_cancelled() || this._previewState !== state)
            return;
        this._previewCancellable = null;
        this._previewState = {...state, status, preview};
        this._renderPreview();
    }

    /**
     * Shows the preview directly under its suggestion or listed pull request, so the pointer
     * reaches it without crossing other rows. Only the preview item is replaced; a focused row
     * stays.
     */
    _renderPreview() {
        this._previewItem?.destroy();
        // Rendering happens under a resting pointer, so keep the cursor a hovered row asked for.
        this._setPointerCursor(this._pullRequestItems.some(row => row.hover));
        const state = this._previewState;
        const inList = state?.source === 'list';
        const section = inList ? this._contentSection : this._quickOpenSection;
        const target = (inList ? this._pullRequestItems : this._quickOpenItems)
            .find(row => row._previewKey === state?.key);
        if (!state || !target)
            return;

        // A non-reactive item renders as insensitive, so this one only opts out of activation.
        const item = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false});
        // A fixed height keeps hover stable: retargeting a lower suggestion lifts it by exactly
        // the old preview's height, so the pointer lands in the new preview, not on a sibling.
        const previewStyle = hover => 'border-radius: 10px; width: 36em; height: 20em; ' +
            'background-color: rgba(127, 127, 127, ' + (hover ? '0.2' : '0.12') + ');';
        // No vfade: St's fade ignores its offset here and dims the last lines being read.
        const scrollView = new St.ScrollView({
            style: previewStyle(false),
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        // Clicks land on the content box, never on the scrollbar, so scrolling stays safe.
        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            reactive: true,
            track_hover: true,
            style: 'spacing: 6px; padding: 10px 12px;',
        });
        box.accessible_name = 'Open ' + state.suggestion.repository + ' #' + state.suggestion.number;
        box.connect('notify::hover', () => {
            scrollView.style = previewStyle(box.hover);
            this._setPointerCursor(box.hover);
        });
        box.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._openQuickOpenSuggestion(state.suggestion);
            this._indicator.menu.close();
            return Clutter.EVENT_STOP;
        });
        scrollView.set_child(box);
        item.add_child(scrollView);
        section.addMenuItem(item, section._getMenuItems().indexOf(target) + 1);
        this._previewItem = item;
        item.connect('destroy', () => {
            if (this._previewItem === item)
                this._previewItem = null;
        });
        if (inList) {
            // The preview's scroll view takes every wheel event, even at its ends or with
            // nothing to scroll, which traps the list behind it: hand those to the list.
            scrollView.connect('scroll-event', (_actor, event) => {
                const direction = event.get_scroll_direction();
                const delta = direction === Clutter.ScrollDirection.SMOOTH
                    ? event.get_scroll_delta()[1]
                    : {[Clutter.ScrollDirection.UP]: -1, [Clutter.ScrollDirection.DOWN]: 1}[direction];
                if (!delta)
                    return Clutter.EVENT_PROPAGATE;

                const {value, lower, upper, page_size: pageSize} = scrollView.vadjustment;
                if (delta < 0 ? value > lower : value < upper - pageSize)
                    return Clutter.EVENT_PROPAGATE;
                this._contentScrollView.emit('scroll-event', event);
                return Clutter.EVENT_STOP;
            });
            // Scroll once the preview has a size. Revealing it lifts its row by at most the
            // preview height, so the pointer stays on the row or on its preview. After a click,
            // wait out the double-click time so a second click still lands on the row.
            let revealSourceId = 0;
            const allocationId = item.connect('notify::allocation', () => {
                if (item.height === 0)
                    return;
                item.disconnect(allocationId);
                const waitMs = Math.ceil((this._previewRevealTime - GLib.get_monotonic_time()) / 1000);
                if (waitMs <= 0) {
                    ensureActorVisibleInScrollView(this._contentScrollView, item);
                    return;
                }
                revealSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, waitMs, () => {
                    revealSourceId = 0;
                    ensureActorVisibleInScrollView(this._contentScrollView, item);
                    return GLib.SOURCE_REMOVE;
                });
            });
            item.connect('destroy', () => {
                if (revealSourceId)
                    GLib.Source.remove(revealSourceId);
            });
        }

        const {repository, number} = state.suggestion;
        if (state.status !== 'ready') {
            box.add_child(createDimLabel({
                loading: 'Loading ' + repository + ' #' + number + '…',
                missing: '#' + number + ' not found in ' + repository,
                error: 'Preview unavailable. Check gh auth status.',
            }[state.status]));
            return;
        }

        const preview = state.preview;
        const isPullRequest = preview.kind === 'pull-request';
        const stateInfo = PREVIEW_STATES[preview.state] ?? PREVIEW_STATES.closed;
        const metadataLine = new St.BoxLayout({style: 'spacing: 6px;'});
        metadataLine.add_child(createBadge(stateInfo.label, stateInfo.color));
        metadataLine.add_child(createDimLabel(isPullRequest ? 'Pull request' : 'Issue'));
        if (preview.author)
            metadataLine.add_child(createDimLabel('@' + preview.author));
        if (!isPullRequest) {
            metadataLine.add_child(createDimLabel(
                preview.comments + (preview.comments === 1 ? ' comment' : ' comments')
            ));
        }
        box.add_child(metadataLine);

        const title = new St.Label({text: preview.title, style: 'font-weight: 600;'});
        wrapLabel(title);
        box.add_child(title);

        if (preview.labels.length) {
            // Clutter.FlowLayout allocated these badges with no height, so they share one line
            // and ellipsize when they do not fit the preview's fixed width.
            const labels = new St.BoxLayout({style: 'spacing: 4px;'});
            for (const label of preview.labels)
                labels.add_child(createLabelBadge(label));
            box.add_child(labels);
        }

        if (isPullRequest) {
            const branches = createDimLabel(
                preview.headRefName + ' → ' + preview.baseRefName +
                ' · +' + preview.additions + ' −' + preview.deletions
            );
            branches.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
            box.add_child(branches);
            box.add_child(this._createCheckSummary(preview.checks));
        }

        box.add_child(this._createMarkdownBody(parseMarkdown(preview.body, {repository})));
    }

    /** Lays out parsed Markdown blocks with GitHub-like spacing and structure. */
    _createMarkdownBody(blocks) {
        const body = new St.BoxLayout({vertical: true, style: 'spacing: 6px; padding-top: 6px;'});
        if (blocks.length === 0)
            body.add_child(createDimLabel('No description.'));

        for (const block of blocks) {
            if (block.type === 'paragraph') {
                body.add_child(this._createMarkupLabel(block, 'font-size: 0.95em;'));
            } else if (block.type === 'heading') {
                // Like GitHub, the two top levels are larger and underlined by a rule.
                body.add_child(this._createMarkupLabel(block, block.level <= 2
                    ? 'font-weight: 700; padding: 4px 0 3px; ' +
                        'border-bottom: 1px solid rgba(127, 127, 127, 0.3); font-size: ' +
                        (block.level === 1 ? '1.15em;' : '1.05em;')
                    : 'font-weight: 700; padding-top: 2px;'));
            } else if (block.type === 'summary' || block.type === 'list-item') {
                const row = new St.BoxLayout({
                    style: 'spacing: 6px; padding-left: ' + 16 * (block.depth ?? 0) + 'px;',
                });
                const marker = createDimLabel(block.type === 'summary' ? '▸' : block.marker, {
                    y_align: Clutter.ActorAlign.START,
                    style: 'min-width: 1.1em; font-size: 0.95em;',
                });
                if (block.checked)
                    marker.set({opacity: 255, style: 'min-width: 1.1em; color: #26a269;'});
                row.add_child(marker);
                const content = this._createMarkupLabel(block,
                    block.type === 'summary' ? 'font-weight: 600;' : 'font-size: 0.95em;');
                content.x_expand = true;
                row.add_child(content);
                body.add_child(row);
            } else if (block.type === 'code') {
                const code = new St.Label({
                    text: block.text,
                    style: 'font-family: monospace; font-size: 0.9em; padding: 6px 8px; ' +
                        'border-radius: 6px; background-color: rgba(127, 127, 127, 0.18);',
                });
                wrapLabel(code);
                body.add_child(code);
            } else if (block.type === 'quote') {
                const color = QUOTE_COLORS[block.alert] ?? 'rgba(127, 127, 127, 0.5)';
                const quote = new St.BoxLayout({
                    vertical: true,
                    style: 'spacing: 2px; padding-left: 10px; border-left: 3px solid ' + color + ';',
                });
                if (block.title) {
                    quote.add_child(new St.Label({
                        text: block.title,
                        style: 'font-weight: 700; color: ' + color + ';',
                    }));
                }
                if (block.markup) {
                    const content = this._createMarkupLabel(block, 'font-size: 0.95em;');
                    content.opacity = block.alert ? 255 : 210;
                    quote.add_child(content);
                }
                body.add_child(quote);
            } else if (block.type === 'rule') {
                body.add_child(new St.Widget({
                    style: 'height: 1px; margin: 4px 0; background-color: rgba(127, 127, 127, 0.35);',
                }));
            } else if (block.type === 'table') {
                const table = new St.BoxLayout({
                    vertical: true,
                    style: 'border: 1px solid rgba(127, 127, 127, 0.3); border-radius: 6px;',
                });
                block.rows.forEach((cells, rowIndex) => {
                    const row = new St.BoxLayout({
                        style: rowIndex === 0
                            ? 'background-color: rgba(127, 127, 127, 0.15);'
                            : 'border-top: 1px solid rgba(127, 127, 127, 0.2);',
                    });
                    for (const cell of cells) {
                        const label = this._createMarkupLabel(
                            rowIndex === 0 ? {...cell, markup: '<b>' + cell.markup + '</b>'} : cell,
                            'padding: 3px 6px; font-size: 0.9em;'
                        );
                        label.x_expand = true;
                        row.add_child(label);
                    }
                    table.add_child(row);
                });
                body.add_child(table);
            } else if (block.type === 'truncated') {
                body.add_child(createDimLabel('Description truncated. Click to read it on GitHub.'));
            }
        }
        return body;
    }

    /**
     * Shows Pango markup from markdown.js. A click on a link opens that link; anywhere else
     * the click falls through to the preview, which opens the issue or pull request.
     */
    _createMarkupLabel({markup, links}, ...styles) {
        const label = new St.Label({style: styles.join('')});
        wrapLabel(label);
        label.clutter_text.set_markup(markup);
        if (links.length === 0)
            return label;

        label.reactive = true;
        label.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            const [stageX, stageY] = event.get_coords();
            const [inside, x, y] = label.clutter_text.transform_stage_point(stageX, stageY);
            if (!inside)
                return Clutter.EVENT_PROPAGATE;
            // Positions point between characters, so the right half of a link's last
            // character reports the link's end.
            const position = label.clutter_text.coords_to_position(x, y);
            const link = links.find(candidate => position >= candidate.start &&
                (position < candidate.end || (position === candidate.end && position > candidate.start)));
            if (!link)
                return Clutter.EVENT_PROPAGATE;
            openUri(link.url);
            this._indicator.menu.close();
            return Clutter.EVENT_STOP;
        });
        return label;
    }

    _setPointerCursor(pointer) {
        if (Boolean(this._pointerCursor) === pointer)
            return;
        this._pointerCursor = pointer;
        global.display.set_cursor(pointer ? Meta.Cursor.POINTER : Meta.Cursor.DEFAULT);
    }

    /** Renders checks as a proportional bar followed by the names of failing checks. */
    _createCheckSummary(checks) {
        const container = new St.BoxLayout({vertical: true, style: 'spacing: 3px;'});
        if (checks.total === 0) {
            container.add_child(createDimLabel('No CI checks'));
            return container;
        }

        const color = checks.failed > 0
            ? '#922c31'
            : checks.pending + checks.unloaded > 0
                ? '#805d0c'
                : checks.passed > 0 ? '#276746' : '#55565e';
        const summaryLine = new St.BoxLayout({style: 'spacing: 8px;'});
        summaryLine.add_child(createBadge(
            'CI ' + checks.passed + '/' + checks.total,
            color,
            checks.passed + ' of ' + checks.total + ' checks passed'
        ));

        const bar = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'height: 6px; border-radius: 3px; background-color: rgba(127, 127, 127, 0.25);' +
                ' width: ' + PREVIEW_BAR_WIDTH + 'px;',
        });
        // Cumulative rounding keeps the segments exactly as wide as the bar.
        let filled = 0;
        let counted = 0;
        for (const [count, segmentColor] of [
            [checks.passed, '#26a269'],
            [checks.failed, '#c01c28'],
            [checks.pending, '#e5a50a'],
            [checks.skipped, '#77767b'],
        ]) {
            counted += count;
            const end = Math.round(counted / checks.total * PREVIEW_BAR_WIDTH);
            if (end > filled) {
                bar.add_child(new St.Widget({
                    style: 'height: 6px; width: ' + (end - filled) + 'px; background-color: ' +
                        segmentColor + ';',
                }));
            }
            filled = end;
        }
        summaryLine.add_child(bar);

        for (const [count, label, labelColor] of [
            [checks.failed, 'failed', '#922c31'],
            [checks.pending, 'pending', '#805d0c'],
            [checks.skipped, 'skipped', '#55565e'],
            [checks.unloaded, 'not loaded', '#55565e'],
        ]) {
            if (count > 0)
                summaryLine.add_child(createBadge(count + ' ' + label, labelColor));
        }
        container.add_child(summaryLine);

        for (const name of checks.failedNames) {
            const failedLine = new St.BoxLayout({style: 'spacing: 6px; padding-left: 2px;'});
            failedLine.add_child(new St.Icon({
                icon_name: 'dialog-error-symbolic',
                icon_size: 12,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'color: #c01c28;',
            }));
            const failedName = new St.Label({text: name, style: 'font-size: 0.95em;'});
            failedName.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            failedLine.add_child(failedName);
            container.add_child(failedLine);
        }
        if (checks.hiddenFailedCount > 0)
            container.add_child(createDimLabel('+' + checks.hiddenFailedCount + ' more failed'));
        return container;
    }

    _openQuickOpenSuggestion(suggestion) {
        if (!openUri(suggestion.url))
            return;
        this._settings.set_string('recent-repositories', JSON.stringify(
            rememberRepository(readRecentRepositories(this._settings), suggestion.repository)
        ));
    }

    _renderMenu() {
        if (!this._indicator)
            return;

        this._refreshSection.removeAll();
        const menu = this._contentSection;
        menu.removeAll();
        this._pullRequestItems = [];

        const refreshItem = new PopupMenu.PopupMenuItem(
            this._loading ? 'Refreshing…' : 'Refresh now',
            {reactive: !this._loading, can_focus: !this._loading}
        );
        refreshItem.connect('activate', () => this._refresh());
        this._refreshSection.addMenuItem(refreshItem);

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
                this._hasNoScopes
                    ? 'No active owners or repositories. Open Preferences to choose what to monitor.'
                    : this._error
                        ? 'No previous state available.'
                        : 'No open pull requests match the selected owners and author.',
                {reactive: false, can_focus: false}
            ));
        } else {
            for (const group of groupPullRequestsByOwner(this._prs)) {
                const heading = new PopupMenu.PopupMenuItem(
                    group.owner + ' · ' + group.pullRequests.length +
                    (group.pullRequests.length === 1 ? ' pull request' : ' pull requests'),
                    {reactive: false, can_focus: false}
                );
                heading.label.set_style(
                    'font-weight: 600; padding-top: 5px;'
                );
                menu.addMenuItem(heading);
                for (const pr of group.pullRequests)
                    menu.addMenuItem(this._createPullRequestItem(pr));
            }

            if (this._hasMorePullRequests) {
                menu.addMenuItem(new PopupMenu.PopupMenuItem(
                    'Showing the ' + SEARCH_LIMIT + ' most recently updated pull requests across owners.',
                    {reactive: false, can_focus: false}
                ));
            }
        }

        // A refresh rebuilds the rows: keep an open preview under its pull request if listed.
        if (this._previewState?.source === 'list') {
            if (this._pullRequestItems.some(row => row._previewKey === this._previewState.key))
                this._renderPreview();
            else
                this._setPreviewTarget(null);
        }
    }

    _createPullRequestItem(pr) {
        const status = STATUS[pr.checkError ? 'unknown' : pr.checkState] ?? STATUS.unknown;
        const item = new PopupMenu.PopupBaseMenuItem();
        const icon = new St.Icon({
            icon_name: status.icon,
            style_class: 'popup-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: ' + status.color + ';',
        });
        icon.accessible_name = status.label;
        item.add_child(icon);

        const content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 3px;',
        });
        const titleLine = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 6px;',
        });
        const number = createBadge('#' + pr.number, '#3c5268', 'Pull request ' + pr.number);
        const title = new St.Label({
            text: pr.title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: 600; max-width: 34em;',
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const author = pr.author?.login ? '@' + pr.author.login : 'Unknown author';
        const metadataLine = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 5px;',
        });
        const repository = createDimLabel(pr.repositoryName, {style: 'max-width: 17em;'});
        repository.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const authorLabel = createDimLabel(author);
        const reviewBadge = createBadge(
            pr.isDraft ? 'Draft' : 'Ready for review',
            pr.isDraft ? '#55565e' : '#315b7e',
            pr.isDraft ? 'Draft pull request' : 'Ready for review'
        );
        metadataLine.add_child(repository);
        metadataLine.add_child(authorLabel);
        metadataLine.add_child(reviewBadge);

        let checkLabel;
        let checkColor;
        if (pr.checkError) {
            checkLabel = 'CI unavailable';
            checkColor = '#922c31';
        } else if (pr.checkSummary.total === 0) {
            checkLabel = 'No CI';
            checkColor = '#55565e';
        } else {
            checkLabel = 'CI ' + pr.checkSummary.passed + '/' + pr.checkSummary.total;
            checkColor = {
                success: '#276746',
                pending: '#805d0c',
                failure: '#922c31',
                cancelled: '#55565e',
                skipped: '#55565e',
                unknown: '#922c31',
            }[pr.checkState] ?? '#55565e';

            const counts = pr.checkSummary;
            for (const [count, label, color] of [
                [counts.failed, 'failed', '#922c31'],
                [counts.pending, 'pending', '#805d0c'],
                [counts.skipped, 'skipped', '#55565e'],
                [counts.cancelled, 'cancelled', '#55565e'],
                [counts.unknown, 'unknown', '#55565e'],
            ]) {
                if (count > 0)
                    metadataLine.add_child(createBadge(count + ' ' + label, color));
            }
        }
        const checkBadge = createBadge(
            checkLabel,
            checkColor,
            pr.checkError
                ? 'Checks unavailable'
                : pr.checkSummary.total === 0
                    ? 'No CI checks'
                    : status.label + ', ' + pr.checkSummary.passed + ' of ' +
                        pr.checkSummary.total + ' checks passed'
        );

        titleLine.add_child(number);
        const labels = pr.labels ?? [];
        for (const label of labels.slice(0, ROW_LABEL_LIMIT))
            titleLine.add_child(createLabelBadge(label));
        if (labels.length > ROW_LABEL_LIMIT) {
            const hidden = labels.slice(ROW_LABEL_LIMIT).map(label => label.name);
            titleLine.add_child(createBadge(
                '+' + hidden.length, '#55565e', 'Labels ' + hidden.join(', ')
            ));
        }
        titleLine.add_child(title);
        titleLine.add_child(checkBadge);

        const openPullRequest = () => {
            openUri(pr.url);
            this._indicator.menu.close();
        };
        const openButton = new St.Button({
            child: new St.Icon({
                gicon: Gio.FileIcon.new(this.dir.get_child('greenlight-open-symbolic.svg')),
                icon_size: 14,
            }),
            y_align: Clutter.ActorAlign.CENTER,
            track_hover: true,
            accessible_name: 'Open pull request ' + pr.number + ' on GitHub',
        });
        // The Shell theme has no hover style for a bare button, so the hover tint is inline.
        const openButtonStyle = hover => 'padding: 3px 5px; border-radius: 6px; ' +
            'background-color: rgba(127, 127, 127, ' + (hover ? '0.3' : '0') + ');';
        openButton.style = openButtonStyle(false);
        openButton.connect('notify::hover', () => (openButton.style = openButtonStyle(openButton.hover)));
        openButton.connect('clicked', openPullRequest);
        titleLine.add_child(openButton);
        content.add_child(titleLine);
        content.add_child(metadataLine);
        item.add_child(content);
        item.accessible_name = pr.owner + '/' + pr.repositoryName + ' pull request ' +
            pr.number + ': ' + pr.title + '. ' +
            (labels.length ? 'Labels ' + labels.map(label => label.name).join(', ') + '. ' : '') +
            checkBadge.accessible_name;
        const suggestion = {
            repository: pr.owner + '/' + pr.repositoryName,
            number: pr.number,
            url: pr.url,
        };
        item._previewKey = previewKey(suggestion);
        this._pullRequestItems.push(item);
        item.connect('key-focus-in', () => ensureActorVisibleInScrollView(this._contentScrollView, item));
        // Hover covers the row's children, so the open icon gets the pointer cursor too.
        item.connect('notify::hover', () => this._setPointerCursor(item.hover));
        item.connect('destroy', () => {
            if (item.hover)
                this._setPointerCursor(false);
        });
        // Every activate signal closes the menu, so the row handles its own: a click or Space
        // toggles the preview and keeps the menu open; the open button, a double click, Enter,
        // or a click on the preview opens the pull request.
        let lastClickTime = 0;
        item.activate = event => {
            let open;
            this._previewRevealTime = 0;
            if (event?.type() === Clutter.EventType.KEY_PRESS) {
                open = event.get_key_symbol() !== Clutter.KEY_space;
            } else {
                const now = GLib.get_monotonic_time();
                const doubleClickUs = Clutter.Settings.get_default().double_click_time * 1000;
                open = now - lastClickTime <= doubleClickUs;
                lastClickTime = open ? 0 : now;
                this._previewRevealTime = now + doubleClickUs;
            }

            if (open) {
                openPullRequest();
            } else {
                const shown = this._previewState?.source === 'list' &&
                    this._previewState.key === item._previewKey;
                this._setPreviewTarget(shown ? null : suggestion, 'list');
            }
        };
        return item;
    }
}
