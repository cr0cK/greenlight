import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {readOwnerFilters, serializeOwnerFilters} from './filters.js';
import {describeGhFailure} from './github.js';

const INTERVALS = [30, 60, 120, 300, 600];
// Repository scope modes, in ComboRow order.
const REPOSITORY_MODES = ['all', 'except', 'only'];
const REPOSITORY_MODE_LABELS = ['All', 'All except…', 'Only…'];
const REPOSITORY_MODE_HINTS = {
    all: 'Every repository, including new ones.',
    except: 'New repositories are monitored. Turn off the ones to skip.',
    only: 'Only the repositories turned on. New repositories are skipped.',
};
const INTERVAL_LABELS = [
    '30 seconds',
    '1 minute',
    '2 minutes',
    '5 minutes',
    '10 minutes',
];

/**
 * Runs one gh command without a shell and bounds discovery calls to 30 seconds. Cancelling the
 * cancellable kills the process.
 */
function runGh(args, cancellable) {
    const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
    const launcher = new Gio.SubprocessLauncher({flags});
    launcher.setenv('GH_PROMPT_DISABLED', '1', true);
    const process = launcher.spawnv(['gh', ...args]);
    let timedOut = false;
    let timeoutSourceId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        30,
        () => {
            timedOut = true;
            timeoutSourceId = 0;
            process.force_exit();
            return GLib.SOURCE_REMOVE;
        }
    );
    const cancelledId = cancellable.connect(() => process.force_exit());

    return new Promise((resolve, reject) => {
        process.communicate_utf8_async(null, cancellable, (subprocess, result) => {
            cancellable.disconnect(cancelledId);
            if (timeoutSourceId) {
                GLib.Source.remove(timeoutSourceId);
                timeoutSourceId = 0;
            }

            try {
                const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                if (timedOut)
                    throw new Error('gh request timed out');
                if (!subprocess.get_if_exited() || subprocess.get_exit_status() !== 0) {
                    // Callers that explain failures read the exit code and message.
                    const error = new Error('gh command failed');
                    error.ghResult = {
                        exitCode: subprocess.get_if_exited() ? subprocess.get_exit_status() : -1,
                        stderr: stderr ?? '',
                    };
                    throw error;
                }
                resolve(stdout ?? '');
            } catch (error) {
                reject(error);
            }
        });
    });
}

/** Reads which way a saved owner scope goes. */
function repositoryMode(owner) {
    if (owner.repositories !== null)
        return 'only';
    return owner.excludedRepositories.length > 0 ? 'except' : 'all';
}

/** Tells whether a repository row starts on, which always means monitored. */
function isMonitored(owner, name) {
    if (owner.mode === 'only')
        return owner.repositories.includes(name);
    return !owner.excludedRepositories.includes(name);
}

/**
 * Keeps the saved scope of the selected mode only, in the shape filters.js stores. A paused
 * owner can be saved before its list loads; it then keeps the selection it had.
 */
function savedOwner(owner) {
    const mode = owner.requiresRepositoryList ? owner.selectionBase : owner.mode;
    return {
        login: owner.login,
        kind: owner.kind,
        enabled: owner.enabled,
        repositories: mode === 'only' ? owner.repositories : null,
        excludedRepositories: mode === 'except' ? owner.excludedRepositories : [],
    };
}

/** Keeps repository choices grouped under their owner, including saved names no longer visible to gh. */
function repositoryChoices(owner) {
    const saved = owner.mode === 'only'
        ? owner.repositories
        : owner.mode === 'except' ? owner.excludedRepositories : [];
    const available = owner.availableRepositories;
    if (available === null)
        return saved.map(name => ({name, available: false}));

    const choices = new Map(available.map(repository => [repository.name, repository]));
    for (const name of saved) {
        if (!choices.has(name))
            choices.set(name, {name, visibility: '', available: false});
    }
    return [...choices.values()];
}

/** Provides discovered owner scopes, per-owner repositories, and one save action. */
export default class GreenlightPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const monitoringGroup = new Adw.PreferencesGroup({
            title: 'Monitoring',
            description: 'Greenlight uses the installed gh CLI and its current authentication.',
        });
        const authorRow = new Adw.ActionRow({
            title: 'Author',
            subtitle: 'Use @me or a GitHub login; leave empty to include every author.',
        });
        const authorEntry = new Gtk.Entry({
            text: settings.get_string('author-filter'),
            placeholder_text: '@me or username',
            width_chars: 24,
            valign: Gtk.Align.CENTER,
        });
        authorRow.add_suffix(authorEntry);
        authorRow.set_activatable_widget(authorEntry);

        const intervalModel = Gtk.StringList.new(INTERVAL_LABELS);
        const intervalRow = new Adw.ComboRow({
            title: 'Refresh interval',
            subtitle: 'Time between check requests',
            model: intervalModel,
        });
        const currentInterval = INTERVALS.indexOf(settings.get_int('refresh-interval'));
        intervalRow.set_selected(currentInterval >= 0 ? currentInterval : 2);

        const quickOpenGroup = new Adw.PreferencesGroup({
            title: 'Quick open',
            description: 'Open an issue or pull request by repository and number from the menu.',
        });
        const shortcutRow = new Adw.EntryRow({
            title: 'Keyboard shortcut (empty disables it)',
            text: settings.get_strv('quick-open-shortcut')[0] ?? '',
        });
        shortcutRow.connect('changed', () => shortcutRow.remove_css_class('error'));
        quickOpenGroup.add(shortcutRow);

        const ownersGroup = new Adw.PreferencesGroup({
            title: 'Accounts and organizations',
            description: 'Enable owners to monitor, then expand one to select its repositories.',
        });
        const discoverRow = new Adw.ActionRow({
            title: 'Discover from gh',
            subtitle: 'Load the authenticated account and its organization memberships.',
        });
        const discoverButton = new Gtk.Button({
            label: 'Discover',
            valign: Gtk.Align.CENTER,
        });
        discoverButton.add_css_class('suggested-action');
        discoverRow.add_suffix(discoverButton);
        discoverRow.set_activatable_widget(discoverButton);
        ownersGroup.add(discoverRow);

        const addRow = new Adw.ActionRow({
            title: 'Add another owner',
            subtitle: 'Add any public organization or account by its GitHub login.',
        });
        const ownerEntry = new Gtk.Entry({
            placeholder_text: 'organization or username',
            width_chars: 20,
            valign: Gtk.Align.CENTER,
        });
        const addButton = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER});
        addRow.add_suffix(ownerEntry);
        addRow.add_suffix(addButton);
        addRow.set_activatable_widget(ownerEntry);
        ownersGroup.add(addRow);

        const ownerStatus = new Adw.ActionRow({
            title: 'No owners loaded',
            subtitle: 'Discover your gh account or add an owner to create a scoped list.',
        });
        ownersGroup.add(ownerStatus);

        const owners = new Map();
        for (const owner of readOwnerFilters(settings)) {
            owners.set(owner.login.toLowerCase(), {
                ...owner,
                mode: repositoryMode(owner),
                repositories: owner.repositories ?? [],
                availableRepositories: null,
                repositoryListLoaded: false,
                requiresRepositoryList: false,
                selectionBase: null,
                repositoryRows: new Map(),
                ghStatus: '',
            });
        }

        let ownerSettingsTouched = false;
        let cancellable = new Gio.Cancellable();
        let taskGeneration = 0;
        let ghBusy = false;
        let saveButton = null;
        let ghButtons = [discoverButton, addButton];

        const updateOwnerStatus = (message = '') => {
            const activeCount = [...owners.values()].filter(owner => owner.enabled).length;
            ownerStatus.set_title(
                owners.size + (owners.size === 1 ? ' owner · ' : ' owners · ') + activeCount + ' enabled'
            );
            ownerStatus.set_subtitle(message ||
                'Choose the account and organizations whose pull requests should appear.');
        };

        const updateOwnerSubtitle = owner => {
            const kind = owner.kind === 'user'
                ? 'Personal account'
                : owner.kind === 'organization'
                    ? 'Organization'
                    : 'GitHub owner';
            const noun = names => names.length === 1 ? ' repository' : ' repositories';
            const {repositories, excludedRepositories: excluded} = owner;
            // Until a pending conversion loads its list, the kept selection is the base one.
            const mode = owner.requiresRepositoryList ? owner.selectionBase : owner.mode;
            const scope = mode === 'only'
                ? repositories.length + ' selected' + noun(repositories)
                : mode === 'except' && excluded.length > 0
                    ? 'All except ' + excluded.length + noun(excluded)
                    : 'All repositories';
            owner.row.set_subtitle(
                kind + ' · ' + (owner.enabled ? 'Monitoring' : 'Paused') + ' · ' + scope
            );
        };

        /** Reads the switches back into the list of the current mode; a switch on is monitored. */
        const updateRepositorySummary = owner => {
            const entries = [...owner.repositoryRows.entries()];
            const monitored = entries.filter(([, choice]) => choice.row.get_active())
                .map(([name]) => name);
            owner.repositoryStatus.set_title(entries.length + ' repositories');
            owner.repositoryStatus.set_subtitle(monitored.length + ' monitored');
            if (owner.mode === 'only') {
                owner.repositories = monitored;
            } else if (owner.mode === 'except') {
                owner.excludedRepositories = entries
                    .filter(([, choice]) => !choice.row.get_active())
                    .map(([name]) => name);
            }
            updateOwnerSubtitle(owner);
        };

        const updateGhButtons = () => {
            for (const button of ghButtons)
                button.set_sensitive(!ghBusy);
            if (saveButton)
                saveButton.set_sensitive(!ghBusy);
        };

        /** Rebuilds owner expanders while keeping their selection and expansion state. */
        const renderOwners = () => {
            ownersGroup.remove(ownerStatus);
            for (const owner of owners.values()) {
                if (owner.row) {
                    owner.expanded = owner.row.get_expanded();
                    ownersGroup.remove(owner.row);
                }
            }

            ghButtons = [discoverButton, addButton];
            const orderedOwners = [...owners.values()].sort((first, second) => {
                const rank = owner => owner.kind === 'user'
                    ? 0
                    : owner.kind === 'organization' ? 1 : 2;
                return rank(first) - rank(second) || first.login.localeCompare(second.login);
            });

            for (const owner of orderedOwners) {
                // A paused owner has no repository choices to make, so it does not expand.
                const row = new Adw.ExpanderRow({
                    title: owner.login,
                    enable_expansion: owner.enabled,
                });
                owner.row = row;
                row.set_expanded(owner.expanded ?? false);
                row.connect('notify::expanded', () => {
                    owner.expanded = row.get_expanded();
                });
                owner.repositoryRows = new Map();
                const enabledSwitch = new Gtk.Switch({
                    active: owner.enabled,
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Include this owner in monitoring',
                });
                row.add_action(enabledSwitch);
                const removeButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Remove this owner',
                });
                removeButton.add_css_class('flat');
                row.add_action(removeButton);
                // Removal, like every change here, only applies on Save preferences.
                removeButton.connect('clicked', () => {
                    // renderOwners() only takes out rows of owners still listed.
                    ownersGroup.remove(owner.row);
                    owners.delete(owner.login.toLowerCase());
                    ownerSettingsTouched = true;
                    renderOwners();
                    updateOwnerStatus(owner.login + ' will be removed when you save.');
                });
                enabledSwitch.connect('notify::active', () => {
                    owner.enabled = enabledSwitch.get_active();
                    row.set_enable_expansion(owner.enabled);
                    ownerSettingsTouched = true;
                    updateOwnerSubtitle(owner);
                    updateOwnerStatus();
                });

                const modeRow = new Adw.ComboRow({
                    title: 'Repositories',
                    subtitle: REPOSITORY_MODE_HINTS[owner.mode],
                    model: Gtk.StringList.new(REPOSITORY_MODE_LABELS),
                    selected: REPOSITORY_MODES.indexOf(owner.mode),
                });
                row.add_row(modeRow);

                const loadRow = new Adw.ActionRow({
                    title: 'Repository selection',
                    subtitle: owner.ghStatus || 'Load repositories to choose a subset.',
                });
                const loadButton = new Gtk.Button({
                    label: 'Load repositories',
                    valign: Gtk.Align.CENTER,
                });
                loadRow.add_suffix(loadButton);
                loadRow.set_activatable_widget(loadButton);
                row.add_row(loadRow);
                ghButtons.push(loadButton);

                const searchRow = new Adw.ActionRow({title: 'Filter repositories'});
                const repositorySearch = new Gtk.SearchEntry({
                    placeholder_text: 'Repository name',
                    width_chars: 22,
                    valign: Gtk.Align.CENTER,
                });
                searchRow.add_suffix(repositorySearch);
                row.add_row(searchRow);

                const repositoryStatus = new Adw.ActionRow({
                    title: 'Repositories not loaded',
                    subtitle: 'Load the list to choose individual repositories.',
                });
                owner.repositoryStatus = repositoryStatus;
                row.add_row(repositoryStatus);

                const allRepositories = owner.mode === 'all';
                loadRow.set_visible(!allRepositories);
                searchRow.set_visible(!allRepositories && owner.repositoryListLoaded);
                repositoryStatus.set_visible(!allRepositories);

                const choices = repositoryChoices(owner);
                for (const choice of choices) {
                    const name = choice.name;
                    const repositoryName = name.slice(owner.login.length + 1);
                    const subtitle = choice.visibility
                        ? choice.visibility.toLowerCase()
                        : choice.available ? '' : 'Saved selection not currently visible to gh';
                    const repositoryRow = new Adw.SwitchRow({
                        title: repositoryName || name,
                        subtitle,
                        active: isMonitored(owner, name),
                    });
                    repositoryRow.set_visible(!allRepositories && !owner.requiresRepositoryList);
                    row.add_row(repositoryRow);
                    owner.repositoryRows.set(name, {row: repositoryRow, available: choice.available});
                    repositoryRow.connect('notify::active', () => {
                        ownerSettingsTouched = true;
                        updateRepositorySummary(owner);
                    });
                }

                if (owner.availableRepositories !== null) {
                    updateRepositorySummary(owner);
                } else if (owner.mode !== 'all' && owner.repositoryRows.size > 0) {
                    repositoryStatus.set_title(owner.repositoryRows.size + ' saved repositories');
                    repositoryStatus.set_subtitle(
                        (owner.mode === 'only'
                            ? owner.repositories.length + ' selected'
                            : owner.excludedRepositories.length + ' excluded') +
                        ' · load to refresh availability'
                    );
                }

                repositorySearch.connect('search-changed', () => {
                    const query = repositorySearch.get_text().trim().toLowerCase();
                    const hidden = owner.mode === 'all' || owner.requiresRepositoryList;
                    for (const [name, choice] of owner.repositoryRows)
                        choice.row.set_visible(!hidden && name.toLowerCase().includes(query));
                });

                // Switches keep their state across modes; only the rule for new repositories
                // changes. Leaving All turns every switch on.
                modeRow.connect('notify::selected', () => {
                    const mode = REPOSITORY_MODES[modeRow.get_selected()] ?? 'all';
                    const previousMode = owner.mode;
                    owner.mode = mode;
                    const all = mode === 'all';
                    const loaded = owner.availableRepositories !== null;
                    if (all || previousMode === 'all') {
                        owner.repositories = [];
                        owner.excludedRepositories = [];
                        for (const choice of owner.repositoryRows.values())
                            choice.row.set_active(true);
                    }
                    if (loaded) {
                        owner.selectionBase = null;
                        owner.requiresRepositoryList = false;
                    } else {
                        // Without the list, the monitored set stays the one of the base mode:
                        // everything when leaving All, else the first list mode switched from.
                        // It is converted once the list loads, and saving waits for it.
                        if (all)
                            owner.selectionBase = null;
                        else if (previousMode === 'all')
                            owner.selectionBase = 'except';
                        else
                            owner.selectionBase ??= previousMode;
                        owner.requiresRepositoryList = owner.selectionBase !== null &&
                            owner.selectionBase !== mode;
                    }
                    if (!all && loaded)
                        updateRepositorySummary(owner);

                    ownerSettingsTouched = true;
                    modeRow.set_subtitle(REPOSITORY_MODE_HINTS[mode]);
                    loadRow.set_visible(!all);
                    searchRow.set_visible(!all && owner.repositoryListLoaded);
                    repositoryStatus.set_visible(!all);
                    // Switches stay hidden until a pending conversion has its list.
                    const query = repositorySearch.get_text().trim().toLowerCase();
                    const hidden = all || owner.requiresRepositoryList;
                    for (const [name, choice] of owner.repositoryRows)
                        choice.row.set_visible(!hidden && name.toLowerCase().includes(query));
                    updateOwnerSubtitle(owner);
                    updateOwnerStatus();
                    if (!all && owner.availableRepositories === null)
                        loadRepositories(owner);
                });

                loadButton.connect('clicked', () => loadRepositories(owner));
                updateOwnerSubtitle(owner);
                ownersGroup.add(row);
            }

            ownersGroup.add(ownerStatus);
            updateOwnerStatus();
            updateGhButtons();
        };

        /** Serializes gh requests and drops callbacks after a newer task or window close. */
        const startGhTask = async (task, onError) => {
            if (ghBusy)
                return;
            ghBusy = true;
            taskGeneration++;
            const requestGeneration = taskGeneration;
            cancellable = new Gio.Cancellable();
            updateGhButtons();

            try {
                await task(requestGeneration);
            } catch (error) {
                if (requestGeneration === taskGeneration)
                    onError(error);
            } finally {
                if (requestGeneration === taskGeneration) {
                    ghBusy = false;
                    updateGhButtons();
                }
            }
        };

        /** Loads one owner's repository catalog without mixing it into another owner's filter. */
        function loadRepositories(owner) {
            if (ghBusy)
                return;
            owner.ghStatus = 'Loading repositories…';
            owner.row.set_subtitle(owner.login + ' · Loading repositories…');
            owner.repositoryStatus?.set_subtitle('Running gh repo list for ' + owner.login + '.');

            startGhTask(async requestGeneration => {
                const output = await runGh([
                    'repo', 'list', owner.login,
                    '--limit', '1000',
                    '--json', 'nameWithOwner,visibility',
                ], cancellable);
                if (requestGeneration !== taskGeneration)
                    return;

                const response = JSON.parse(output);
                if (!Array.isArray(response))
                    throw new Error('gh repo list returned an unexpected response');
                owner.availableRepositories = response
                    .filter(repository => typeof repository.nameWithOwner === 'string')
                    .map(repository => ({
                        name: repository.nameWithOwner,
                        visibility: repository.visibility ?? '',
                        available: true,
                    }))
                    .sort((first, second) => first.name.localeCompare(second.name));
                owner.repositoryListLoaded = true;
                owner.ghStatus = owner.availableRepositories.length + ' repositories loaded';
                if (owner.requiresRepositoryList) {
                    // Keeps the monitored set of the base mode, now that it can be listed.
                    const names = owner.availableRepositories.map(repository => repository.name);
                    const monitored = owner.selectionBase === 'only'
                        ? names.filter(name => owner.repositories.includes(name))
                        : names.filter(name => !owner.excludedRepositories.includes(name));
                    if (owner.mode === 'only')
                        owner.repositories = monitored;
                    else
                        owner.excludedRepositories = names.filter(name => !monitored.includes(name));
                    owner.requiresRepositoryList = false;
                }
                owner.selectionBase = null;
                renderOwners();
            }, () => {
                owner.ghStatus = 'Could not load repositories. Check gh auth status.';
                owner.repositoryStatus?.set_title('Could not load repositories');
                owner.repositoryStatus?.set_subtitle(owner.ghStatus);
                if (owner.row)
                    owner.row.set_subtitle(owner.login + ' · ' + owner.ghStatus);
            });
        }

        discoverButton.connect('clicked', () => {
            ownerStatus.set_subtitle('Reading the authenticated account and organization memberships…');
            startGhTask(async requestGeneration => {
                const account = (await runGh(['api', 'user', '--jq', '.login'], cancellable)).trim();
                const organizations = (await runGh(
                    ['api', 'user/orgs', '--paginate', '--jq', '.[].login'],
                    cancellable
                )).split('\n').map(login => login.trim()).filter(Boolean);
                if (requestGeneration !== taskGeneration)
                    return;
                if (!account)
                    throw new Error('gh api user returned no login');

                const firstDiscovery = !settings.get_boolean('owner-filters-configured') &&
                    owners.size === 0;
                const discovered = [
                    {login: account, kind: 'user'},
                    ...organizations.map(login => ({login, kind: 'organization'})),
                ];
                for (const candidate of discovered) {
                    const key = candidate.login.toLowerCase();
                    const existing = owners.get(key);
                    if (existing) {
                        if (existing.kind === 'owner')
                            existing.kind = candidate.kind;
                    } else {
                        owners.set(key, {
                            ...candidate,
                            enabled: firstDiscovery,
                            mode: 'all',
                            repositories: [],
                            excludedRepositories: [],
                            availableRepositories: null,
                            repositoryListLoaded: false,
                            requiresRepositoryList: false,
                            selectionBase: null,
                            repositoryRows: new Map(),
                            ghStatus: '',
                        });
                    }
                }

                ownerSettingsTouched = true;
                renderOwners();
                updateOwnerStatus(
                    discovered.length + ' owners found, including ' + account + '.'
                );
            }, () => {
                updateOwnerStatus('Could not discover owners. Check that gh is installed and authenticated.');
            });
        });

        const addOwner = () => {
            const login = ownerEntry.get_text().trim();
            if (!/^[A-Za-z0-9-]+$/.test(login)) {
                updateOwnerStatus('Enter a valid GitHub organization or account login.');
                return;
            }
            const key = login.toLowerCase();
            if (owners.has(key)) {
                const existing = owners.get(key);
                existing.row.set_expanded(true);
                updateOwnerStatus(existing.enabled
                    ? login + ' is already listed.'
                    : login + ' is already listed but paused; turn it on to choose its repositories.');
                return;
            }

            // A mistyped login would fail every search, so check it exists before adding it.
            if (ghBusy)
                return;
            updateOwnerStatus('Checking ' + login + ' on GitHub…');
            startGhTask(async requestGeneration => {
                const type = (await runGh(['api', 'users/' + login, '--jq', '.type'], cancellable)).trim();
                if (requestGeneration !== taskGeneration || owners.has(key))
                    return;

                owners.set(key, {
                    login,
                    kind: {User: 'user', Organization: 'organization'}[type] ?? 'owner',
                    enabled: true,
                    mode: 'all',
                    repositories: [],
                    excludedRepositories: [],
                    availableRepositories: null,
                    repositoryListLoaded: false,
                    requiresRepositoryList: false,
                    selectionBase: null,
                    repositoryRows: new Map(),
                    ghStatus: '',
                });
                ownerEntry.set_text('');
                ownerSettingsTouched = true;
                renderOwners();
                owners.get(key).row.set_expanded(true);
                updateOwnerStatus(login + ' added.');
            }, error => {
                const result = error?.ghResult;
                updateOwnerStatus(/HTTP 404|Not Found/i.test(result?.stderr ?? '')
                    ? 'No GitHub account or organization is named ' + login + '.'
                    : result
                        ? describeGhFailure(result).message
                        : 'Could not check ' + login + '. Check that gh is installed and authenticated.');
            });
        };
        addButton.connect('clicked', addOwner);
        ownerEntry.connect('activate', addOwner);

        saveButton = new Gtk.Button({label: 'Save preferences', valign: Gtk.Align.CENTER});
        saveButton.add_css_class('suggested-action');
        const saveRow = new Adw.ActionRow({
            title: 'Save preferences',
            subtitle: 'Apply owner, repository, author, refresh, and shortcut settings together.',
        });
        saveRow.add_suffix(saveButton);
        saveRow.set_activatable_widget(saveButton);
        const saveGroup = new Adw.PreferencesGroup();
        saveGroup.add(saveRow);
        saveButton.connect('clicked', () => {
            const shortcutText = shortcutRow.get_text().trim();
            const [validShortcut, shortcutKey, shortcutModifiers] = Gtk.accelerator_parse(shortcutText);
            if (shortcutText && (!validShortcut || shortcutKey === 0)) {
                shortcutRow.add_css_class('error');
                shortcutRow.grab_focus();
                return;
            }

            if (ownerSettingsTouched) {
                for (const owner of owners.values()) {
                    if (owner.enabled && owner.requiresRepositoryList &&
                        !owner.repositoryListLoaded) {
                        owner.row.set_expanded(true);
                        owner.ghStatus = 'Load repositories before saving a custom selection.';
                        owner.row.set_subtitle(owner.login + ' · ' + owner.ghStatus);
                        return;
                    }
                }
            }

            settings.delay();
            if (ownerSettingsTouched) {
                settings.set_string('owner-filters',
                    serializeOwnerFilters([...owners.values()].map(savedOwner)));
                settings.set_boolean('owner-filters-configured', true);
            }
            settings.set_string('author-filter', authorEntry.get_text().trim());
            const selectedInterval = intervalRow.get_selected();
            if (selectedInterval < INTERVALS.length)
                settings.set_int('refresh-interval', INTERVALS[selectedInterval]);
            settings.set_strv('quick-open-shortcut', shortcutText
                ? [Gtk.accelerator_name(shortcutKey, shortcutModifiers)]
                : []);
            settings.apply();
            window.close();
        });

        const versionRow = new Adw.ActionRow({
            title: 'Version',
            subtitle: this.metadata['version-name'] ?? 'Unknown',
            subtitle_selectable: true,
        });
        versionRow.add_css_class('property');
        const sourceRow = new Adw.ActionRow({
            title: 'Source code',
            subtitle: this.metadata.url,
            activatable: true,
        });
        sourceRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        sourceRow.connect('activated', () => {
            new Gtk.UriLauncher({uri: this.metadata.url}).launch(window, null, (launcher, result) => {
                try {
                    launcher.launch_finish(result);
                } catch {
                    console.error('Greenlight: could not open ' + this.metadata.url);
                }
            });
        });
        const aboutGroup = new Adw.PreferencesGroup({title: 'About'});
        aboutGroup.add(versionRow);
        aboutGroup.add(sourceRow);

        monitoringGroup.add(authorRow);
        monitoringGroup.add(intervalRow);
        page.add(monitoringGroup);
        page.add(quickOpenGroup);
        page.add(ownersGroup);
        page.add(saveGroup);
        page.add(aboutGroup);
        window.add(page);
        renderOwners();

        window.connect('close-request', () => {
            taskGeneration++;
            cancellable.cancel();
            return false;
        });
    }
}
