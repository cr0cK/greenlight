import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ownerFiltersToSave, readOwnerFilters} from './filters.js';
import {describeGhFailure} from './github.js';
import {
    buttonFocusedAfterMove,
    canMoveOwnerRow,
    initialBlockOrder,
    moveOwnerRow,
    readOwnerOrder,
} from './order.js';
import {readQuota} from './agents.js';
import {PROVIDERS} from './quotas.js';
import {planSave} from './save.js';

const INTERVALS = [30, 60, 120, 300, 600];
// Repository scope modes, in ComboRow order.
const REPOSITORY_MODES = ['all', 'except', 'only'];
const REPOSITORY_MODE_LABELS = ['All', 'All except…', 'Only…'];
const REPOSITORY_MODE_HINTS = {
    all: 'Every repository, including new ones.',
    except: 'New repositories are monitored. Turn off the ones to skip.',
    only: 'Only the repositories turned on. New repositories are skipped.',
};
const QUOTA_INTERVALS = [15, 30, 60, 120, 240];
const QUOTA_INTERVAL_LABELS = ['15 minutes', '30 minutes', '1 hour', '2 hours', '4 hours'];
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

        // The Pull requests tab icon is the panel glyph, drawn as fills for GTK's symbolic loader.
        Gtk.IconTheme.get_for_display(window.get_display()).add_search_path(this.path);
        // The banner button and Ctrl+S share this action; disabling it greys the button out.
        const saveAction = new Gio.SimpleAction({name: 'save'});
        const actions = new Gio.SimpleActionGroup();
        actions.add_action(saveAction);
        window.insert_action_group('prefs', actions);
        const shortcuts = new Gtk.ShortcutController({scope: Gtk.ShortcutScope.MANAGED});
        shortcuts.add_shortcut(new Gtk.Shortcut({
            trigger: Gtk.ShortcutTrigger.parse_string('<Control>s'),
            action: Gtk.NamedAction.new('prefs.save'),
        }));
        window.add_controller(shortcuts);

        /** One tab, with the save banner at its top, outside its scrolled content. */
        const createPage = (title, iconName) => {
            const page = new Adw.PreferencesPage({title, icon_name: iconName});
            page.set_banner(new Adw.Banner({
                title: 'Save your changes to apply them',
                button_label: 'Save',
                button_style: Adw.BannerButtonStyle.SUGGESTED,
                action_name: 'prefs.save',
                revealed: true,
            }));
            return page;
        };
        const page = createPage('Pull requests', 'greenlight-pr-gtk-symbolic');
        const agentsPage = createPage('Agents', 'power-profile-balanced-symbolic');
        const aboutPage = createPage('About', 'help-about-symbolic');

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

        const quotaGroup = new Adw.PreferencesGroup({
            title: 'Agent quotas',
            description: 'Show subscription usage below the pull requests. Each agent\'s own CLI ' +
                'reports it; Greenlight never handles a credential.',
        });
        // Each switch waits for its provider's check; an unavailable one stays off.
        const quotaRows = {};
        for (const [provider, {name}] of Object.entries(PROVIDERS)) {
            quotaRows[provider] = new Adw.SwitchRow({
                title: name,
                subtitle: 'Checking…',
                active: settings.get_boolean(PROVIDERS[provider].setting),
                sensitive: false,
            });
            quotaGroup.add(quotaRows[provider]);
        }
        const quotaIntervalRow = new Adw.ComboRow({
            title: 'Refresh every',
            subtitle: 'Opening the menu also refreshes quotas older than 5 minutes',
            model: Gtk.StringList.new(QUOTA_INTERVAL_LABELS),
        });
        const currentQuotaInterval = QUOTA_INTERVALS.indexOf(settings.get_int('agent-quota-interval'));
        quotaIntervalRow.set_selected(currentQuotaInterval >= 0 ? currentQuotaInterval : 2);
        quotaGroup.add(quotaIntervalRow);
        const thresholdRow = new Adw.SpinRow({
            title: 'Notify at (%)',
            subtitle: 'Once per window, when its usage reaches this share',
            adjustment: new Gtk.Adjustment({
                lower: 50,
                upper: 100,
                step_increment: 5,
                value: settings.get_int('agent-quota-threshold'),
            }),
            // The default policy clamps invalid text to 50; this one keeps the last value.
            update_policy: Gtk.SpinButtonUpdatePolicy.IF_VALID,
        });
        // IF_VALID alone accepts 83.5: only a whole number is a value.
        thresholdRow.connect('input', () => {
            const text = thresholdRow.get_text().trim();
            return /^\d+$/.test(text) ? [true, Number(text)] : Gtk.INPUT_ERROR;
        });
        quotaGroup.add(thresholdRow);

        const quotaCancellable = new Gio.Cancellable();
        for (const [provider, row] of Object.entries(quotaRows)) {
            readQuota(provider, {version: this.metadata['version-name'] ?? '0', cancellable: quotaCancellable})
                .then(result => {
                    if (result.status === 'ok') {
                        row.set_sensitive(true);
                        row.set_subtitle('Uses the ' + PROVIDERS[provider].command + ' CLI');
                    } else if (result.status === 'unavailable') {
                        row.set_active(false);
                        row.set_subtitle(result.message);
                    } else {
                        // Not proven either way: keep the saved choice, locked.
                        row.set_subtitle('Could not check: ' + result.message +
                            '. Reopen Preferences to try again.');
                    }
                })
                .catch(() => {
                    // Cancelled when the window closes.
                });
        }

        const ownersGroup = new Adw.PreferencesGroup({
            title: 'Accounts and organizations',
            description: 'Each owner gets its own block below: discover its repositories, ' +
                'choose what to monitor, then pick repositories. ' +
                'The menu lists the owners in the order of their blocks.',
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

        // Map order is block order: the saved order, then the owners it misses, kind then login.
        // Add puts a block first, Discover accounts last, and a move reorders the map.
        const configuredOwners = readOwnerFilters(settings);
        let owners = new Map(initialBlockOrder(readOwnerOrder(settings.get_strv('owner-order')), configuredOwners)
            .map(login => {
                const owner = configuredOwners.find(candidate =>
                    candidate.login.toLowerCase() === login.toLowerCase());
                return [login.toLowerCase(), createOwner(owner, owner.enabled)];
            }));
        const ownerGroups = [];
        // Owners trashed since the running task started: its answer must not add them back.
        const removedKeys = new Set();

        let ownerSettingsTouched = false;
        let cancellable = new Gio.Cancellable();
        let taskGeneration = 0;
        let ghBusy = false;
        let removalMessage = null;

        const updateOwnerStatus = (message = '') => {
            const activeCount = [...owners.values()].filter(owner => owner.enabled).length;
            ownerStatus.set_title(owners.size === 0
                ? 'No owners yet'
                : owners.size + (owners.size === 1 ? ' owner · ' : ' owners · ') + activeCount + ' enabled');
            ownerStatus.set_subtitle(message || (owners.size === 0
                ? 'Discover your gh account or add an owner.'
                : 'Pull requests of enabled owners appear in the menu.'));
        };

        const ownerKind = owner => owner.kind === 'user'
            ? 'Personal account'
            : owner.kind === 'organization' ? 'Organization' : 'GitHub owner';

        const ownerDescription = owner => {
            const kind = ownerKind(owner);
            const noun = names => names.length === 1 ? ' repository' : ' repositories';
            const {repositories, excludedRepositories: excluded} = owner;
            const scope = owner.mode === 'only'
                ? repositories.length + ' selected' + noun(repositories)
                : owner.mode === 'except' && excluded.length > 0
                    ? 'All except ' + excluded.length + noun(excluded)
                    : 'All repositories';
            return kind + ' · ' + (owner.enabled ? 'Monitoring' : 'Paused') + ' · ' + scope;
        };

        // The one pending focus action: a move, a trash, or an answer that laid the blocks out
        // again. The next one, a key press, a click, or closing the window cancels it.
        let pendingFocus = null;
        const cancelPendingFocus = () => {
            if (!pendingFocus)
                return;
            if (pendingFocus.idleId)
                GLib.Source.remove(pendingFocus.idleId);
            if (pendingFocus.tickId)
                window.remove_tick_callback(pendingFocus.tickId);
            pendingFocus = null;
        };

        /** Scrolls the page so the widget shows, from its bounds relative to the viewport. */
        const scrollIntoView = widget => {
            const scrolled = widget.get_ancestor(Gtk.ScrolledWindow);
            const viewport = scrolled?.get_child();
            if (!viewport)
                return;
            const [ok, bounds] = widget.compute_bounds(viewport);
            if (!ok)
                return;
            const adjustment = scrolled.get_vadjustment();
            const margin = 12;
            const top = bounds.get_y();
            const bottom = top + bounds.get_height();
            if (top < margin)
                adjustment.set_value(adjustment.get_value() + top - margin);
            else if (bottom > adjustment.get_page_size() - margin)
                adjustment.set_value(adjustment.get_value() + bottom - adjustment.get_page_size() + margin);
        };

        /** Reads the caret and selection of an entry, null for any other widget. */
        const captureText = widget => {
            if (!(widget instanceof Gtk.Editable))
                return null;
            const [hasSelection, start, end] = widget.get_selection_bounds();
            return {widget, hasSelection, start, end, position: widget.get_position()};
        };

        /**
         * Focuses what `resolve` returns once the widgets are back in the window, then scrolls it
         * into view once the new layout is done. A widget removed and added again in the same
         * tick can refuse the focus, hence the idle source; the tick callbacks wait for the
         * layout, which comes after them in the frame that maps the blocks. Only the Pull
         * requests tab takes a focus move: a move still pending when another tab is shown is
         * dropped, and so is one whose answer lands while another tab is shown.
         */
        const focusLater = (resolve, saved = null) => {
            cancelPendingFocus();
            const pending = {idleId: 0, tickId: 0};
            pendingFocus = pending;
            pending.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                pending.idleId = 0;
                const target = resolve();
                if (!target || target.get_root() !== window || window.get_visible_page() !== page) {
                    pendingFocus = null;
                    return GLib.SOURCE_REMOVE;
                }
                // The caret and selection read before the widget left the window, else now.
                const text = saved?.widget === target ? saved : captureText(target);
                target.grab_focus();
                // Grabbing the focus selects the text of an entry: keep the caret and selection.
                if (text?.hasSelection)
                    target.select_region(text.position === text.start ? text.end : text.start, text.position);
                else if (text)
                    target.set_position(text.position);
                let frames = 0;
                pending.tickId = window.add_tick_callback(() => {
                    if (++frames < 3)
                        return GLib.SOURCE_CONTINUE;
                    pending.tickId = 0;
                    if (pendingFocus === pending)
                        pendingFocus = null;
                    scrollIntoView(target);
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
        };

        const keyController = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        keyController.connect('key-pressed', () => {
            cancelPendingFocus();
            return false;
        });
        window.add_controller(keyController);
        const clickGesture = new Gtk.GestureClick({
            button: 0,
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        clickGesture.connect('pressed', () => cancelPendingFocus());
        window.add_controller(clickGesture);
        window.connect('notify::visible-page', () => cancelPendingFocus());

        /** Keeps each block's move buttons in step with its place: no up first, no down last. */
        const updateMoveButtons = () => {
            const count = owners.size;
            [...owners.values()].forEach((owner, index) => {
                owner.upButton?.set_sensitive(canMoveOwnerRow(count, index, -1));
                owner.downButton?.set_sensitive(canMoveOwnerRow(count, index, 1));
            });
        };

        /** Swaps a block with its neighbor, from its place now, and refocuses the button used. */
        const moveOwner = (key, direction) => {
            const keys = [...owners.keys()];
            const index = keys.indexOf(key);
            const moved = moveOwnerRow(keys, index, direction);
            if (moved === keys)
                return;
            owners = new Map(moved.map(movedKey => [movedKey, owners.get(movedKey)]));
            renderOwners();
            const owner = owners.get(key);
            const name = buttonFocusedAfterMove(owners.size, index + direction, direction);
            focusLater(() => name === 'up' ? owner.upButton : owner.downButton);
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
            saveAction.set_enabled(!ghBusy);
        };

        /** Creates an owner's block with its header; fillOwnerGroup() builds its rows. */
        const createOwnerGroup = owner => {
            const group = new Adw.PreferencesGroup({title: owner.login});
            owner.group = group;
            owner.groupRows = [];

            const header = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
            const moveButtons = {};
            for (const [name, direction] of [['up', -1], ['down', 1]]) {
                const label = 'Move ' + owner.login + ' ' + name;
                moveButtons[name] = new Gtk.Button({
                    icon_name: 'go-' + name + '-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: label,
                });
                moveButtons[name].add_css_class('flat');
                // An icon alone does not say which owner it moves.
                moveButtons[name].update_property([Gtk.AccessibleProperty.LABEL], [label]);
                // The place is read at each press, never when the button was built.
                moveButtons[name].connect('clicked',
                    () => moveOwner(owner.login.toLowerCase(), direction));
            }
            owner.upButton = moveButtons.up;
            owner.downButton = moveButtons.down;
            const removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Remove ' + owner.login,
            });
            removeButton.add_css_class('flat');
            owner.removeButton = removeButton;
            const enabledSwitch = new Gtk.Switch({
                active: owner.enabled,
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Monitor ' + owner.login,
            });
            // Icon and switch alone do not say which owner they act on.
            removeButton.update_property([Gtk.AccessibleProperty.LABEL], ['Remove ' + owner.login]);
            enabledSwitch.update_property([Gtk.AccessibleProperty.LABEL], ['Monitor ' + owner.login]);
            header.append(moveButtons.up);
            header.append(moveButtons.down);
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
            // Removal, like every change here, only applies on Save.
            removeButton.connect('clicked', () => {
                // GTK drops the focus with the removed subtree: pick the target first, the block
                // that takes this one's place, or the one above when this was the last.
                const key = owner.login.toLowerCase();
                const keys = [...owners.keys()];
                const index = keys.indexOf(key);
                const successor = owners.get(keys[index + 1] ?? keys[index - 1]);
                owners.delete(key);
                removedKeys.add(key);
                ownerGroups.splice(ownerGroups.indexOf(group), 1);
                page.remove(group);
                updateMoveButtons();
                focusLater(() => successor
                    ? [successor.upButton, successor.downButton, successor.removeButton]
                        .find(button => button.get_sensitive())
                    : ownerEntry);
                ownerSettingsTouched = true;
                removalMessage = owner.login + ' will be removed when you save.';
                updateOwnerStatus(removalMessage);
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

        /**
         * Lays the owner blocks out in order, after the owners group. The
         * blocks leave the window and come back, which drops the focus: it returns to the widget
         * that held it, or to `starter`, the button of the task that asked for the layout.
         */
        const renderOwners = starter => {
            const focused = window.get_focus();
            // GTK clears the selection of an entry that leaves the window: read it first.
            const text = captureText(focused);
            for (const group of ownerGroups.splice(0))
                page.remove(group);

            for (const owner of owners.values()) {
                const group = owner.group ?? createOwnerGroup(owner);
                ownerGroups.push(group);
                page.add(group);
            }

            updateMoveButtons();
            updateOwnerStatus();
            updateGhButtons();
            if (starter || focused)
                focusLater(() => focused?.get_root() === window ? focused : starter, text);
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
            if (ghBusy)
                return;
            removedKeys.clear();
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
                    // An owner trashed while the answer was pending stays removed.
                    if (removedKeys.has(key))
                        continue;
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
                renderOwners(discoverButton);
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
                // A login typed meanwhile is the next draft: keep it.
                if (ownerEntry.get_text().trim() === login)
                    ownerEntry.set_text('');
                ownerSettingsTouched = true;
                renderOwners(addButton);
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

        saveAction.connect('activate', () => {
            const shortcutText = shortcutRow.get_text().trim();
            const [validShortcut, shortcutKey, shortcutModifiers] = Gtk.accelerator_parse(shortcutText);
            if (shortcutText && (!validShortcut || shortcutKey === 0)) {
                // Nothing is written, whichever tab the save came from: show the field.
                shortcutRow.add_css_class('error');
                window.set_visible_page(page);
                focusLater(() => shortcutRow);
                return;
            }

            // A fresh settings object per save: its delay() is permanent, so it is never used
            // after its apply(). Only the keys that differ are written: the shell refreshes
            // from gh on the owner and author keys without comparing values, and an order-only
            // save must not.
            const saved = this.getSettings();
            const values = [];
            if (ownerSettingsTouched) {
                // Both sides in kind-then-login order: a save that only moved blocks, or put
                // the owners back as they were, leaves owner-filters alone and refreshes nothing.
                const ownerFilters = ownerFiltersToSave(
                    readOwnerFilters(saved), [...owners.values()].map(savedOwner)
                );
                if (ownerFilters !== null) {
                    values.push({key: 'owner-filters', value: ownerFilters},
                        {key: 'owner-filters-configured', value: true});
                }
            }
            values.push({key: 'owner-order', value: [...owners.values()].map(owner => owner.login)});
            values.push({key: 'author-filter', value: authorEntry.get_text().trim()});
            const selectedInterval = intervalRow.get_selected();
            if (selectedInterval < INTERVALS.length)
                values.push({key: 'refresh-interval', value: INTERVALS[selectedInterval]});
            values.push({key: 'quick-open-shortcut', value: shortcutText
                ? [Gtk.accelerator_name(shortcutKey, shortcutModifiers)]
                : []});
            for (const [provider, row] of Object.entries(quotaRows))
                values.push({key: PROVIDERS[provider].setting, value: row.get_active()});
            const selectedQuotaInterval = quotaIntervalRow.get_selected();
            if (selectedQuotaInterval < QUOTA_INTERVALS.length)
                values.push({key: 'agent-quota-interval', value: QUOTA_INTERVALS[selectedQuotaInterval]});
            // Reads the text of a field still being typed in; invalid text keeps the last value.
            thresholdRow.update();
            values.push({key: 'agent-quota-threshold', value: Math.round(thresholdRow.get_value())});

            const plan = planSave(values, key => saved.get_value(key).deepUnpack(),
                key => saved.is_writable(key));
            if (plan.blockedKey === null) {
                saved.delay();
                for (const {key, value} of plan.writes) {
                    if (Array.isArray(value))
                        saved.set_strv(key, value);
                    else if (typeof value === 'boolean')
                        saved.set_boolean(key, value);
                    else if (typeof value === 'number')
                        saved.set_int(key, value);
                    else
                        saved.set_string(key, value);
                }
                saved.apply();
            }
            // A pending-removal message is stale once the removal is saved; others stay.
            if (plan.blockedKey === null && ownerStatus.get_subtitle() === removalMessage)
                updateOwnerStatus();
            window.add_toast(new Adw.Toast({title: plan.message}));
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
        aboutPage.add(aboutGroup);

        monitoringGroup.add(authorRow);
        monitoringGroup.add(intervalRow);
        page.add(monitoringGroup);
        page.add(quickOpenGroup);
        page.add(ownersGroup);
        agentsPage.add(quotaGroup);
        // The pages go through add(): the shell needs a visible page once this method returns.
        window.add(page);
        window.add(agentsPage);
        window.add(aboutPage);
        renderOwners();

        window.connect('close-request', () => {
            taskGeneration++;
            cancellable.cancel();
            quotaCancellable.cancel();
            cancelPendingFocus();
            return false;
        });
    }
}
