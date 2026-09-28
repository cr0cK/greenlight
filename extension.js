import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {
    migrateLegacyOwnerFilters,
    readOwnerFilters,
} from './filters.js';

const SEARCH_LIMIT = 30;
const SEARCH_FETCH_LIMIT = SEARCH_LIMIT + 1;
const MAX_QUERY_QUALIFIERS = 16;
const MAX_QUERY_LENGTH = 220;
const FILTER_REFRESH_DELAY_MS = 600;
const CHECK_FIELDS = 'bucket,name,workflow,state,completedAt,startedAt,link';
const SEARCH_FIELDS = 'number,title,url,repository,author,isDraft,updatedAt';

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

/** Parse PR URLs with GLib because GJS does not provide the browser URL global. */
function repositoryArgument(pr) {
    const uri = GLib.Uri.parse(pr.url, GLib.UriFlags.NONE);
    const host = uri.get_host();
    const parts = (uri.get_path() ?? '').split('/').filter(Boolean);
    const pullIndex = parts.findIndex(part => part === 'pull');
    const fullName = repositoryFullName(pr, parts, pullIndex);

    if (!host || !fullName)
        throw new Error('Could not determine the pull request repository.');

    return host.toLowerCase() === 'github.com' ? fullName : host + '/' + fullName;
}

/** Extracts owner/repository from gh search data or its pull request URL. */
function repositoryFullName(pr, urlParts = null, pullIndex = -1) {
    const repository = pr.repository;
    return typeof repository === 'string'
        ? repository
        : repository?.nameWithOwner
            ?? repository?.fullName
            ?? (repository?.owner?.login && repository?.name
                ? repository.owner.login + '/' + repository.name
                : null)
            ?? (pullIndex >= 2 ? urlParts.slice(0, pullIndex).join('/') : null);
}

/** Splits owner/repository qualifiers without exceeding GitHub search query bounds. */
function chunkSearchFilters(values, qualifier, fixedQueryLength) {
    const chunks = [];
    let current = [];
    let currentLength = fixedQueryLength;

    for (const value of values) {
        const qualifierLength = qualifier.length + value.length + (current.length > 0 ? 1 : 0);
        if (current.length > 0 && (current.length >= MAX_QUERY_QUALIFIERS ||
            currentLength + qualifierLength > MAX_QUERY_LENGTH)) {
            chunks.push(current);
            current = [];
            currentLength = fixedQueryLength;
        }
        current.push(value);
        currentLength += qualifier.length + value.length + (current.length > 1 ? 1 : 0);
    }

    if (current.length > 0)
        chunks.push(current);
    return chunks;
}

/** Produces non-overlapping all-owner and selected-repository search scopes. */
function searchScopes(settings, authorFilter) {
    if (!settings.get_boolean('owner-filters-configured'))
        return [{type: 'all', values: []}];

    const owners = readOwnerFilters(settings).filter(owner => owner.enabled);
    const allOwners = owners
        .filter(owner => owner.repositories === null)
        .map(owner => owner.login);
    const repositories = [...new Set(owners
        .filter(owner => owner.repositories !== null)
        .flatMap(owner => owner.repositories))];
    const fixedQueryLength = 24 + (authorFilter ? 7 + authorFilter.length : 0);

    return [
        ...chunkSearchFilters(allOwners, 'org:', fixedQueryLength)
            .map(values => ({type: 'owners', values})),
        ...chunkSearchFilters(repositories, 'repo:', fixedQueryLength)
            .map(values => ({type: 'repositories', values})),
    ];
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
function createBadge(text, background, accessibleName = text) {
    const badge = new St.Label({
        text,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'padding: 1px 6px; border-radius: 6px; background-color: ' + background +
            '; color: #ffffff; font-size: 0.9em; font-weight: 600;',
    });
    badge.accessible_name = accessibleName;
    return badge;
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
export default class BabysitPRExtension extends Extension {
    enable() {
        this._enabled = true;
        this._settings = this.getSettings();
        migrateLegacyOwnerFilters(this._settings);
        this._cancellable = new Gio.Cancellable();
        this._activeProcess = null;
        this._activeTimeoutId = 0;
        this._loading = false;
        this._error = null;
        this._prs = [];
        this._hasMorePullRequests = false;
        this._hasNoScopes = false;
        this._filterRefreshSourceId = 0;
        this._refreshAfterCurrent = false;

        this._indicator = new PanelMenu.Button(0.0, 'BabysitPR', false);
        this._indicator.accessible_name = 'BabysitPR';
        const panelBox = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelIcon = new St.Icon({
            gicon: Gio.FileIcon.new(
                this.dir.get_child('babysitpr-pr-symbolic.svg')
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
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }
        for (const signal of this._settingsSignals ?? [])
            this._settings.disconnect(signal);
        this._settingsSignals = [];
        if (this._activeTimeoutId) {
            GLib.Source.remove(this._activeTimeoutId);
            this._activeTimeoutId = 0;
        }
        if (this._filterRefreshSourceId) {
            GLib.Source.remove(this._filterRefreshSourceId);
            this._filterRefreshSourceId = 0;
        }
        this._hasNoScopes = false;
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
        const scopes = searchScopes(this._settings, authorFilter);
        const hasNoScopes = this._settings.get_boolean('owner-filters-configured') &&
            scopes.length === 0;
        const currentFilterSignature = filterSignature(this._settings);

        try {
            const searchRowsByKey = new Map();
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
                    '--limit', String(SEARCH_FETCH_LIMIT),
                    '--json', SEARCH_FIELDS
                );

                const search = await this._runGh(searchArgs);
                if (search.exitCode !== 0)
                    throw new Error('gh search prs failed');

                const response = JSON.parse(search.stdout);
                if (!Array.isArray(response))
                    throw new Error('gh search prs returned an unexpected response');

                const allowedValues = new Set(scope.values.map(value => value.toLowerCase()));
                for (const row of response) {
                    const fullName = repositoryFullName(row);
                    if (!fullName)
                        continue;
                    const matches = scope.type === 'owners'
                        ? allowedValues.has(fullName.split('/')[0].toLowerCase())
                        : scope.type === 'repositories'
                            ? allowedValues.has(fullName.toLowerCase())
                            : true;
                    if (matches)
                        searchRowsByKey.set(fullName.toLowerCase() + '#' + row.number, row);
                }
            }

            const searchRows = [...searchRowsByKey.values()];
            searchRows.sort(compareUpdatedPullRequests);
            const hasMorePullRequests = searchRows.length > SEARCH_LIMIT;
            const snapshot = [];
            for (const row of searchRows.slice(0, SEARCH_LIMIT)) {
                if (!this._enabled)
                    return;

                let repo = 'Unknown repository';
                let key = repo + '#' + row.number;
                const fullName = repositoryFullName(row);
                const nameParts = fullName?.split('/') ?? [];
                const owner = nameParts.shift() ?? 'Unknown owner';
                const repositoryName = nameParts.join('/') || 'Unknown repository';
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
            console.error('BabysitPR: failed to read pull requests.');
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
        this._panelIcon.accessible_name = 'Pull request monitor';
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

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const preferencesItem = new PopupMenu.PopupMenuItem('Preferences…');
        preferencesItem.connect('activate', () => this.openPreferences());
        menu.addMenuItem(preferencesItem);
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
        const repository = new St.Label({
            text: pr.repositoryName,
            style_class: 'dim-label',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'max-width: 17em;',
        });
        repository.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const authorLabel = new St.Label({
            text: author,
            style_class: 'dim-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
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
        titleLine.add_child(title);
        titleLine.add_child(checkBadge);
        content.add_child(titleLine);
        content.add_child(metadataLine);
        item.add_child(content);
        item.accessible_name = pr.owner + '/' + pr.repositoryName + ' pull request ' +
            pr.number + ': ' + pr.title + '. ' + checkBadge.accessible_name;
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
