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

/** Finds a repository in a saved list; GitHub names are case-insensitive. */
function includesRepository(names, name) {
    return names.some(candidate => candidate.toLowerCase() === name.toLowerCase());
}

/** Tells whether a repository row starts on, which always means monitored. */
function isMonitored(owner, name) {
    if (owner.mode === 'only')
        return includesRepository(owner.repositories, name);
    return !includesRepository(owner.excludedRepositories, name);
}

/** Keeps the saved scope of the selected mode only, in the shape filters.js stores. */
function savedOwner(owner) {
    return {
        login: owner.login,
        kind: owner.kind,
        enabled: owner.enabled,
        repositories: owner.mode === 'only' ? owner.repositories : null,
        excludedRepositories: owner.mode === 'except' ? owner.excludedRepositories : [],
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

    const choices = new Map(available.map(repository => [repository.name.toLowerCase(), repository]));
    for (const name of saved) {
        if (!choices.has(name.toLowerCase()))
            choices.set(name.toLowerCase(), {name, visibility: '', available: false});
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
            description: 'Each owner gets its own block below: discover its repositories, ' +
                'choose what to monitor, then pick repositories.',
        });
        const discoverRow = new Adw.ActionRow({
            title: 'Discover accounts',
            subtitle: 'Your gh account and the organizations it belongs to.',
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
            title: 'Add an owner',
            subtitle: 'Any public organization or account, by its GitHub login.',
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
            title: 'No owners yet',
            subtitle: 'Discover your gh account or add an owner.',
        });
        ownersGroup.add(ownerStatus);

        /**
         * UI state of one owner; the repository list stays null until its Discover runs. A new
         * owner, from Add or Discover accounts, watches all its repositories.
         */
        const createOwner = (owner, enabled) => ({
            login: owner.login,
            kind: owner.kind,
            enabled,
            mode: repositoryMode({repositories: null, excludedRepositories: [], ...owner}),
            repositories: owner.repositories ?? [],
            excludedRepositories: owner.excludedRepositories ?? [],
            availableRepositories: null,
            ghStatus: '',
            listExpanded: false,
            repositoryRows: new Map(),
        });

        const kindRank = owner => owner.kind === 'user' ? 0 : owner.kind === 'organization' ? 1 : 2;
        // Map order is block order: saved owners sorted, added ones first, discovered ones last.
        let owners = new Map(readOwnerFilters(settings)
            .sort((first, second) => kindRank(first) - kindRank(second) ||
                first.login.localeCompare(second.login))
            .map(owner => [owner.login.toLowerCase(), createOwner(owner, owner.enabled)]));
        const ownerGroups = [];

        let ownerSettingsTouched = false;
        let cancellable = new Gio.Cancellable();
        let taskGeneration = 0;
        let ghBusy = false;
        let saveButton = null;

        const updateOwnerStatus = (message = '') => {
            const activeCount = [...owners.values()].filter(owner => owner.enabled).length;
            ownerStatus.set_title(owners.size === 0
                ? 'No owners yet'
                : owners.size + (owners.size === 1 ? ' owner · ' : ' owners · ') + activeCount + ' enabled');
            ownerStatus.set_subtitle(message || (owners.size === 0
                ? 'Discover your gh account or add an owner.'
                : 'Pull requests of enabled owners appear in the menu.'));
        };

        const ownerDescription = owner => {
            const kind = owner.kind === 'user'
                ? 'Personal account'
                : owner.kind === 'organization' ? 'Organization' : 'GitHub owner';
            const noun = names => names.length === 1 ? ' repository' : ' repositories';
            const {repositories, excludedRepositories: excluded} = owner;
            const scope = owner.mode === 'only'
                ? repositories.length + ' selected' + noun(repositories)
                : owner.mode === 'except' && excluded.length > 0
                    ? 'All except ' + excluded.length + noun(excluded)
                    : 'All repositories';
            return kind + ' · ' + (owner.enabled ? 'Monitoring' : 'Paused') + ' · ' + scope;
        };

        /** Reads the switches back into the list of the current mode; a switch on is monitored. */
        const syncSelection = owner => {
            const entries = [...owner.repositoryRows.entries()];
            const monitored = entries.filter(([, row]) => row.get_active()).map(([name]) => name);
            if (owner.mode === 'only') {
                owner.repositories = monitored;
            } else if (owner.mode === 'except') {
                owner.excludedRepositories = entries
                    .filter(([, row]) => !row.get_active())
                    .map(([name]) => name);
            }
            owner.listRow?.set_title(monitored.length + ' of ' + entries.length + ' monitored');
            owner.group?.set_description(ownerDescription(owner));
        };

        const updateGhButtons = () => {
            const ownerButtons = [...owners.values()].map(owner => owner.discoverButton);
            for (const button of [discoverButton, addButton, ...ownerButtons])
                button?.set_sensitive(!ghBusy);
            if (saveButton)
                saveButton.set_sensitive(!ghBusy);
        };

        /** Creates an owner's block with its header; fillOwnerGroup() builds its rows. */
        const createOwnerGroup = owner => {
            const group = new Adw.PreferencesGroup({title: owner.login});
            owner.group = group;
            owner.groupRows = [];

            const header = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Remove ' + owner.login,
            });
            removeButton.add_css_class('flat');
            const enabledSwitch = new Gtk.Switch({
                active: owner.enabled,
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Monitor ' + owner.login,
            });
            // Icon and switch alone do not say which owner they act on.
            removeButton.update_property([Gtk.AccessibleProperty.LABEL], ['Remove ' + owner.login]);
            enabledSwitch.update_property([Gtk.AccessibleProperty.LABEL], ['Monitor ' + owner.login]);
            header.append(removeButton);
            header.append(enabledSwitch);
            group.set_header_suffix(header);

            enabledSwitch.connect('notify::active', () => {
                owner.enabled = enabledSwitch.get_active();
                ownerSettingsTouched = true;
                owner.syncEnabled();
                group.set_description(ownerDescription(owner));
                updateOwnerStatus();
            });
            // Removal, like every change here, only applies on Save preferences.
            removeButton.connect('clicked', () => {
                owners.delete(owner.login.toLowerCase());
                ownerGroups.splice(ownerGroups.indexOf(group), 1);
                page.remove(group);
                ownerSettingsTouched = true;
                updateOwnerStatus(owner.login + ' will be removed when you save.');
            });

            fillOwnerGroup(owner);
            return group;
        };

        /**
         * (Re)builds an owner's rows in place, so the page keeps its scroll position:
         * (1) discover the owner's repositories, (2) choose what to monitor once they are known,
         * (3) turn repositories on or off. A paused owner's rows are greyed out.
         */
        function fillOwnerGroup(owner) {
            const group = owner.group;
            for (const row of owner.groupRows.splice(0))
                group.remove(row);
            const loaded = owner.availableRepositories !== null;
            group.set_description(ownerDescription(owner));
            owner.repositoryRows = new Map();

            const discoverRepositoriesRow = new Adw.ActionRow({
                title: 'Repositories',
                subtitle: owner.ghStatus || (loaded
                    ? owner.availableRepositories.length + ' found'
                    : 'Not loaded yet. Discover them to choose some.'),
            });
            const discoverRepositoriesButton = new Gtk.Button({
                label: 'Discover',
                valign: Gtk.Align.CENTER,
            });
            discoverRepositoriesRow.add_suffix(discoverRepositoriesButton);
            discoverRepositoriesRow.set_activatable_widget(discoverRepositoriesButton);
            discoverRepositoriesButton.set_sensitive(!ghBusy);
            owner.discoverButton = discoverRepositoriesButton;
            group.add(discoverRepositoriesRow);

            // Choosing which repositories needs them listed, so the mode waits for Discover.
            const modeRow = new Adw.ComboRow({
                title: 'Monitor',
                subtitle: loaded
                    ? REPOSITORY_MODE_HINTS[owner.mode]
                    : REPOSITORY_MODE_HINTS[owner.mode] + ' Discover the repositories to change it.',
                model: Gtk.StringList.new(REPOSITORY_MODE_LABELS),
                selected: REPOSITORY_MODES.indexOf(owner.mode),
                sensitive: loaded,
            });
            group.add(modeRow);

            const listRow = new Adw.ExpanderRow({
                title: '',
                visible: loaded && owner.mode !== 'all',
                expanded: owner.listExpanded,
            });
            owner.listRow = listRow;
            listRow.connect('notify::expanded', () => {
                owner.listExpanded = listRow.get_expanded();
            });
            const searchRow = new Adw.ActionRow({title: 'Filter repositories'});
            const repositorySearch = new Gtk.SearchEntry({
                placeholder_text: 'Repository name',
                width_chars: 22,
                valign: Gtk.Align.CENTER,
            });
            searchRow.add_suffix(repositorySearch);
            listRow.add_row(searchRow);
            group.add(listRow);

            if (loaded) {
                for (const choice of repositoryChoices(owner)) {
                    const name = choice.name;
                    const repositoryRow = new Adw.SwitchRow({
                        title: name.slice(owner.login.length + 1) || name,
                        subtitle: choice.visibility
                            ? choice.visibility.toLowerCase()
                            : choice.available ? '' : 'Saved, but not visible to gh',
                        active: isMonitored(owner, name),
                    });
                    listRow.add_row(repositoryRow);
                    owner.repositoryRows.set(name, repositoryRow);
                    repositoryRow.connect('notify::active', () => {
                        ownerSettingsTouched = true;
                        syncSelection(owner);
                    });
                }
                syncSelection(owner);
            }

            repositorySearch.connect('search-changed', () => {
                const query = repositorySearch.get_text().trim().toLowerCase();
                for (const [name, row] of owner.repositoryRows)
                    row.set_visible(name.toLowerCase().includes(query));
            });

            // Switches keep their state between All except and Only; only the rule for new
            // repositories changes. Leaving All turns every switch on.
            modeRow.connect('notify::selected', () => {
                const mode = REPOSITORY_MODES[modeRow.get_selected()] ?? 'all';
                if (mode === owner.mode)
                    return;
                const previousMode = owner.mode;
                owner.mode = mode;
                if (mode === 'all' || previousMode === 'all') {
                    owner.repositories = [];
                    owner.excludedRepositories = [];
                    for (const row of owner.repositoryRows.values())
                        row.set_active(true);
                }
                syncSelection(owner);
                ownerSettingsTouched = true;
                modeRow.set_subtitle(REPOSITORY_MODE_HINTS[mode]);
                listRow.set_visible(mode !== 'all');
                if (mode !== 'all')
                    listRow.set_expanded(true);
            });

            owner.groupRows = [discoverRepositoriesRow, modeRow, listRow];
            owner.syncEnabled = () => {
                for (const row of owner.groupRows)
                    row.set_sensitive(owner.enabled && (row !== modeRow || loaded));
            };
            owner.syncEnabled();
            discoverRepositoriesButton.connect('clicked', () => loadRepositories(owner));
        }

        /** Lays the owner blocks out in order, between the owners group and the Save group. */
        const renderOwners = () => {
            for (const group of ownerGroups.splice(0))
                page.remove(group);
            page.remove(saveGroup);
            page.remove(aboutGroup);

            for (const owner of owners.values()) {
                const group = owner.group ?? createOwnerGroup(owner);
                ownerGroups.push(group);
                page.add(group);
            }

            page.add(saveGroup);
            page.add(aboutGroup);
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
            owner.ghStatus = 'Running gh repo list for ' + owner.login + '…';
            fillOwnerGroup(owner);

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
                owner.ghStatus = '';
                fillOwnerGroup(owner);
            }, error => {
                owner.ghStatus = error?.ghResult
                    ? describeGhFailure(error.ghResult).message
                    : 'Could not list the repositories. Check that gh is installed and authenticated.';
                fillOwnerGroup(owner);
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
                        if (existing.kind === 'owner') {
                            existing.kind = candidate.kind;
                            existing.group?.set_description(ownerDescription(existing));
                        }
                    } else {
                        owners.set(key, createOwner(candidate, firstDiscovery));
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
                updateOwnerStatus(owners.get(key).enabled
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

                // A new owner's block comes first, where the user is looking.
                const kind = {User: 'user', Organization: 'organization'}[type] ?? 'owner';
                owners = new Map([[key, createOwner({login, kind}, true)], ...owners]);
                ownerEntry.set_text('');
                ownerSettingsTouched = true;
                renderOwners();
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
