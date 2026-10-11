import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {readOwnerFilters, serializeOwnerFilters} from './filters.js';

const INTERVALS = [30, 60, 120, 300, 600];
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
                const [, stdout] = subprocess.communicate_utf8_finish(result);
                if (timedOut)
                    throw new Error('gh request timed out');
                if (!subprocess.get_if_exited() || subprocess.get_exit_status() !== 0)
                    throw new Error('gh command failed');
                resolve(stdout ?? '');
            } catch (error) {
                reject(error);
            }
        });
    });
}

/** Keeps repository choices grouped under their owner, including saved names no longer visible to gh. */
function repositoryChoices(owner) {
    const available = owner.availableRepositories;
    if (available === null)
        return (owner.repositories ?? []).map(name => ({name, available: false}));

    const choices = new Map(available.map(repository => [repository.name, repository]));
    for (const name of owner.repositories ?? []) {
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
            title: 'Quick open and preview',
            description: 'Open an issue or pull request by repository and number from the menu.',
        });
        const shortcutRow = new Adw.EntryRow({
            title: 'Keyboard shortcut (empty disables it)',
            text: settings.get_strv('quick-open-shortcut')[0] ?? '',
        });
        shortcutRow.connect('changed', () => shortcutRow.remove_css_class('error'));
        quickOpenGroup.add(shortcutRow);
        const hoverPreviewRow = Adw.SpinRow.new_with_range(0, 10, 0.5);
        hoverPreviewRow.set_title('Preview listed pull requests on hover');
        hoverPreviewRow.set_subtitle('Seconds before the preview opens; 0 turns it off.');
        hoverPreviewRow.set_digits(1);
        hoverPreviewRow.set_value(settings.get_int('hover-preview-delay') / 1000);
        quickOpenGroup.add(hoverPreviewRow);

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
                availableRepositories: null,
                repositoryListLoaded: false,
                selectAllOnNextLoad: false,
                requiresRepositoryList: false,
                repositoryRows: new Map(),
                ghStatus: '',
            });
        }

        let ownerSettingsTouched = false;
        let cancellable = new Gio.Cancellable();
        let taskGeneration = 0;
        let ghBusy = false;
        let saveButton = null;
        let ghButtons = [discoverButton];

        const updateOwnerStatus = (message = '') => {
            const activeCount = [...owners.values()].filter(owner => owner.enabled).length;
            ownerStatus.set_title(
                owners.size + ' owners · ' + activeCount + ' enabled'
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
            const scope = owner.repositories === null
                ? 'All repositories'
                : owner.repositories.length + ' selected repositories';
            owner.row.set_subtitle(
                kind + ' · ' + (owner.enabled ? 'Monitoring' : 'Paused') + ' · ' + scope
            );
        };

        const updateRepositorySummary = owner => {
            const count = owner.repositoryRows.size;
            const selected = [...owner.repositoryRows.values()]
                .filter(choice => choice.row.get_active()).length;
            owner.repositoryStatus.set_title(count + ' repositories');
            owner.repositoryStatus.set_subtitle(selected + ' selected');
            if (owner.repositories !== null) {
                owner.repositories = [...owner.repositoryRows.entries()]
                    .filter(([, choice]) => choice.row.get_active())
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

            ghButtons = [discoverButton];
            const orderedOwners = [...owners.values()].sort((first, second) => {
                const rank = owner => owner.kind === 'user'
                    ? 0
                    : owner.kind === 'organization' ? 1 : 2;
                return rank(first) - rank(second) || first.login.localeCompare(second.login);
            });

            for (const owner of orderedOwners) {
                const row = new Adw.ExpanderRow({title: owner.login});
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
                enabledSwitch.connect('notify::active', () => {
                    owner.enabled = enabledSwitch.get_active();
                    ownerSettingsTouched = true;
                    updateOwnerSubtitle(owner);
                    updateOwnerStatus();
                });

                const removeButton = new Gtk.Button({
                    label: 'Remove',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Remove this owner from preferences',
                });
                row.add_action(removeButton);
                removeButton.connect('clicked', () => {
                    ownersGroup.remove(owner.row);
                    owners.delete(owner.login.toLowerCase());
                    ownerSettingsTouched = true;
                    renderOwners();
                    updateOwnerStatus();
                    updateGhButtons();
                });

                const allRepositoriesRow = new Adw.SwitchRow({
                    title: 'All repositories',
                    subtitle: 'Automatically include new repositories for this owner.',
                    active: owner.repositories === null,
                });
                row.add_row(allRepositoriesRow);

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

                const allRepositories = allRepositoriesRow.get_active();
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
                        active: owner.repositories === null || owner.repositories.includes(name),
                    });
                    repositoryRow.set_visible(!allRepositories);
                    row.add_row(repositoryRow);
                    owner.repositoryRows.set(name, {row: repositoryRow, available: choice.available});
                    repositoryRow.connect('notify::active', () => {
                        ownerSettingsTouched = true;
                        updateRepositorySummary(owner);
                    });
                }

                if (owner.availableRepositories !== null) {
                    updateRepositorySummary(owner);
                } else if (owner.repositories !== null && owner.repositoryRows.size > 0) {
                    repositoryStatus.set_title(owner.repositoryRows.size + ' saved repositories');
                    repositoryStatus.set_subtitle(
                        owner.repositories.length + ' selected · load to refresh availability'
                    );
                }

                repositorySearch.connect('search-changed', () => {
                    const query = repositorySearch.get_text().trim().toLowerCase();
                    const all = allRepositoriesRow.get_active();
                    for (const [name, choice] of owner.repositoryRows)
                        choice.row.set_visible(!all && name.toLowerCase().includes(query));
                });

                allRepositoriesRow.connect('notify::active', () => {
                    const all = allRepositoriesRow.get_active();
                    if (all) {
                        owner.repositories = null;
                        owner.selectAllOnNextLoad = false;
                        owner.requiresRepositoryList = false;
                        for (const choice of owner.repositoryRows.values())
                            choice.row.set_active(true);
                    } else if (owner.repositories === null) {
                        owner.selectAllOnNextLoad = owner.availableRepositories === null;
                        owner.requiresRepositoryList = owner.availableRepositories === null;
                        owner.repositories = owner.availableRepositories !== null
                            ? [...owner.availableRepositories.map(repository => repository.name)]
                            : [];
                    }

                    ownerSettingsTouched = true;
                    loadRow.set_visible(!all);
                    searchRow.set_visible(!all && owner.repositoryListLoaded);
                    repositoryStatus.set_visible(!all);
                    const query = repositorySearch.get_text().trim().toLowerCase();
                    for (const [name, choice] of owner.repositoryRows)
                        choice.row.set_visible(!all && name.toLowerCase().includes(query));
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
            } catch {
                if (requestGeneration === taskGeneration)
                    onError();
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
                owner.requiresRepositoryList = false;
                owner.ghStatus = owner.availableRepositories.length + ' repositories loaded';
                if (owner.selectAllOnNextLoad) {
                    owner.repositories = owner.availableRepositories.map(repository => repository.name);
                    owner.selectAllOnNextLoad = false;
                }
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
                            repositories: null,
                            availableRepositories: null,
                            repositoryListLoaded: false,
                            selectAllOnNextLoad: false,
                            requiresRepositoryList: false,
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
                owners.get(key).row.set_expanded(true);
                updateOwnerStatus(login + ' is already listed.');
                return;
            }

            owners.set(key, {
                login,
                kind: 'owner',
                enabled: true,
                repositories: null,
                availableRepositories: null,
                repositoryListLoaded: false,
                selectAllOnNextLoad: false,
                requiresRepositoryList: false,
                repositoryRows: new Map(),
                ghStatus: '',
            });
            ownerEntry.set_text('');
            ownerSettingsTouched = true;
            renderOwners();
            owners.get(key).row.set_expanded(true);
        };
        addButton.connect('clicked', addOwner);
        ownerEntry.connect('activate', addOwner);

        saveButton = new Gtk.Button({label: 'Save preferences', valign: Gtk.Align.CENTER});
        saveButton.add_css_class('suggested-action');
        const saveRow = new Adw.ActionRow({
            title: 'Save preferences',
            subtitle: 'Apply owner, repository, author, refresh, shortcut, and preview settings together.',
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
                settings.set_string('owner-filters', serializeOwnerFilters([...owners.values()]));
                settings.set_boolean('owner-filters-configured', true);
            }
            settings.set_string('author-filter', authorEntry.get_text().trim());
            const selectedInterval = intervalRow.get_selected();
            if (selectedInterval < INTERVALS.length)
                settings.set_int('refresh-interval', INTERVALS[selectedInterval]);
            settings.set_int('hover-preview-delay', Math.round(hoverPreviewRow.get_value() * 1000));
            settings.set_strv('quick-open-shortcut', shortcutText
                ? [Gtk.accelerator_name(shortcutKey, shortcutModifiers)]
                : []);
            settings.apply();
            window.close();
        });

        monitoringGroup.add(authorRow);
        monitoringGroup.add(intervalRow);
        page.add(monitoringGroup);
        page.add(quickOpenGroup);
        page.add(ownersGroup);
        page.add(saveGroup);
        window.add(page);
        renderOwners();

        window.connect('close-request', () => {
            taskGeneration++;
            cancellable.cancel();
            return false;
        });
    }
}
