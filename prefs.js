import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const INTERVALS = [30, 60, 120, 300, 600];
const INTERVAL_LABELS = [
    '30 seconds',
    '1 minute',
    '2 minutes',
    '5 minutes',
    '10 minutes',
];

/** Provides a small preferences page with bounded polling choices. */
export default class BabysitPRPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Monitoring',
            description: 'BabysitPR uses the installed gh CLI and its current authentication.',
        });
        const model = Gtk.StringList.new(INTERVAL_LABELS);
        const row = new Adw.ComboRow({
            title: 'Refresh interval',
            subtitle: 'Time between check requests',
            model,
        });

        const syncSelection = () => {
            const value = settings.get_int('refresh-interval');
            const index = INTERVALS.indexOf(value);
            row.set_selected(index >= 0 ? index : 2);
        };

        syncSelection();
        row.connect('notify::selected', () => {
            const selected = row.get_selected();
            if (selected < INTERVALS.length)
                settings.set_int('refresh-interval', INTERVALS[selected]);
        });
        const settingsSignal = settings.connect('changed::refresh-interval', syncSelection);
        window.connect('close-request', () => {
            settings.disconnect(settingsSignal);
            return false;
        });

        group.add(row);
        page.add(group);
        window.add(page);
    }
}
