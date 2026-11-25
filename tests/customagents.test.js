import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    MAX_CUSTOM_AGENTS,
    builtinMessage,
    canAddAgent,
    checkCommand,
    customId,
    customProvider,
    displayPath,
    enabledProviders,
    notFoundMessage,
    parseCommand,
    readCustomAgents,
    sameCustomAgents,
    writeCustomAgents,
} from '../src/customagents.js';
import {
    MESSAGES,
    PROVIDERS,
    forgetPeriods,
    missingCliMessage,
    notificationTitle,
    parseAgyRun,
    parseClaudeRun,
    parseCodexResponse,
    readQuotaCache,
    trackPeriods,
} from '../src/quotas.js';
import {planChanges} from '../src/changes.js';

const agent = (command, type = 'claude', enabled = true) => ({command, type, enabled});
const NOW = 1795000000;

test('a command is a name or a path, and its name is its last component', () => {
    assert.deepEqual(parseCommand(' claude-work '), {kind: 'name', command: 'claude-work', name: 'claude-work'});
    assert.deepEqual(parseCommand('~/bin/codex-team'),
        {kind: 'path', command: '~/bin/codex-team', name: 'codex-team'});
    assert.deepEqual(parseCommand('/opt/agy+alt.2/agy_alt'),
        {kind: 'path', command: '/opt/agy+alt.2/agy_alt', name: 'agy_alt'});
    // A path may hold characters a name cannot, and is shown as typed.
    assert.equal(parseCommand('/opt/a&b <c>/run').kind, 'path');
    assert.equal(parseCommand('/opt/a&b <c>/run').name, 'run');
    // A NUL would end the path at launch, so `/opt/claude\0-work` would run `/opt/claude`.
    assert.equal(parseCommand('/opt/agents/claude\0-work').kind, 'invalid');
    assert.deepEqual(readCustomAgents(JSON.stringify([agent('/opt/agents/claude\u0000-work')])), []);
    for (const text of ['', '   ', 'claude work', 'bin/claude-work', './claude-work', '~claude', '~', 'a:b', '/', '~/', '/bin/'])
        assert.equal(parseCommand(text).kind, 'invalid', JSON.stringify(text));
});

test('a path holding a colon is refused, since it could not go in PATH', () => {
    assert.equal(parseCommand('/opt/a:b/run').kind, 'colon');
    assert.equal(parseCommand('~/bin/x:y').kind, 'colon');
});

test('the reasons come in the order of the spec', () => {
    const list = [agent('claude-work'), agent('~/bin/codex-team', 'codex')];
    assert.deepEqual(checkCommand(list, 'codex-alt'), {ok: true, command: 'codex-alt', name: 'codex-alt'});
    assert.deepEqual(checkCommand(list, ' ~/bin/agy-alt '),
        {ok: true, command: '~/bin/agy-alt', name: 'agy-alt'});
    assert.equal(checkCommand(list, 'not a command').reason, 'Enter a command name or a path.');
    assert.equal(checkCommand(list, '/a:b/c').reason, 'A path cannot hold ":".');
    // The form comes before anything else, the colon before a built-in name.
    assert.equal(checkCommand(list, '/a:b/claude').reason, 'A path cannot hold ":".');
    assert.equal(checkCommand(list, 'claude').reason, 'claude is a built-in agent\'s name.');
    assert.equal(checkCommand(list, 'CODEX').reason, 'CODEX is a built-in agent\'s name.');
    assert.equal(checkCommand(list, '~/bin/Antigravity').reason, 'Antigravity is a built-in agent\'s name.');
    assert.equal(checkCommand(list, 'claude-work').reason, 'claude-work is already listed.');
    // The same command first, then the same name in any case.
    assert.equal(checkCommand(list, '~/bin/codex-team').reason, '~/bin/codex-team is already listed.');
    assert.equal(checkCommand(list, '/srv/CODEX-TEAM').reason, 'CODEX-TEAM is already listed.');
    assert.equal(checkCommand(list, '/other/claude-work').reason, 'claude-work is already listed.');
    // `agy` is the built-in command, not a built-in name: the disk decides.
    assert.equal(checkCommand(list, 'agy').ok, true);
    // The built-in name rule comes before the listed rule.
    assert.equal(checkCommand([agent('/x/claude')], '/y/claude').reason, 'claude is a built-in agent\'s name.');
});

test('the messages of the disk rules name the command and the type', () => {
    assert.equal(notFoundMessage('codex-tem'), 'codex-tem not found in PATH or ~/.local/bin');
    assert.equal(notFoundMessage('~/bin/nope'), '~/bin/nope is not an executable file');
    assert.equal(notFoundMessage('/etc'), '/etc is not an executable file');
    assert.equal(builtinMessage('claude-link', 'claude'), 'claude-link is the built-in Claude agent.');
    assert.equal(builtinMessage('~/bin/c', 'codex'), '~/bin/c is the built-in Codex agent.');
    assert.equal(builtinMessage('x', 'agy'), 'x is the built-in Antigravity agent.');
});

test('a found path is shown with the home directory as ~', () => {
    assert.equal(displayPath('/home/user/.local/bin/claude-work', '/home/user'), '~/.local/bin/claude-work');
    assert.equal(displayPath('/home/user', '/home/user'), '~');
    assert.equal(displayPath('/home/user2/bin/x', '/home/user'), '/home/user2/bin/x');
    assert.equal(displayPath('/usr/bin/claude-work', '/home/user'), '/usr/bin/claude-work');
    assert.equal(displayPath('/usr/bin/x', '/'), '/usr/bin/x');
});

test('the list is limited to five agents', () => {
    const list = Array.from({length: MAX_CUSTOM_AGENTS}, (_, index) => agent('agent-' + index));
    assert.equal(MAX_CUSTOM_AGENTS, 5);
    assert.equal(canAddAgent(list.slice(0, 4)), true);
    assert.equal(canAddAgent(list), false);
});

test('the storage reader skips what is not an agent and keeps the order', () => {
    assert.deepEqual(readCustomAgents('[]'), []);
    for (const text of ['', 'not json', '{}', '"[]"', 'null', '3'])
        assert.deepEqual(readCustomAgents(text), [], text);
    const stored = JSON.stringify([
        agent('claude-work'),
        null, 'text', [], 7,
        {command: 'a', type: 'claude'},
        {command: 'b', type: 'claude', enabled: 'false'},
        {command: 'c', type: 'claude', enabled: 0},
        {command: 'd', type: 'gemini', enabled: true},
        {command: 5, type: 'claude', enabled: true},
        {command: 'two words', type: 'claude', enabled: true},
        {command: '/opt/a:b/run', type: 'codex', enabled: true},
        {command: 'Claude', type: 'codex', enabled: true},
        {command: '~/bin/codex', type: 'codex', enabled: true},
        {command: 'CLAUDE-WORK', type: 'codex', enabled: true},
        {command: '~/bin/claude-work', type: 'agy', enabled: true},
        {command: 'claude-work', type: 'agy', enabled: false},
        agent('~/bin/codex-team', 'codex', false),
        {command: ' agy-alt ', type: 'agy', enabled: true, extra: 1},
    ]);
    assert.deepEqual(readCustomAgents(stored), [
        agent('claude-work'),
        agent('~/bin/codex-team', 'codex', false),
        agent('agy-alt', 'agy'),
    ]);
});

test('an invalid entry before the fifth valid one does not count, and a sixth is skipped', () => {
    const valid = index => agent('agent-' + index);
    const stored = JSON.stringify([valid(1), {command: 'bad one', type: 'claude', enabled: true}, valid(2),
        valid(3), valid(4), valid(5), valid(6), valid(7)]);
    assert.deepEqual(readCustomAgents(stored).map(entry => entry.command),
        ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5']);
});

test('skipped entries are dropped once the list is written, and a missing file is no reason to skip', () => {
    const stored = JSON.stringify([agent('claude-work'), {command: 'x', type: 'nope', enabled: true},
        agent('~/bin/gone', 'codex')]);
    const list = readCustomAgents(stored);
    assert.equal(writeCustomAgents(list),
        '[{"command":"claude-work","type":"claude","enabled":true},' +
        '{"command":"~/bin/gone","type":"codex","enabled":true}]');
    assert.deepEqual(readCustomAgents(writeCustomAgents(list)), list);
});

test('the list is compared as a whole: commands, types, switches, order', () => {
    const base = [agent('claude-work'), agent('codex-team', 'codex')];
    assert.equal(sameCustomAgents(base, [agent('claude-work'), agent('codex-team', 'codex')]), true);
    assert.equal(sameCustomAgents(base, [base[1], base[0]]), false);
    assert.equal(sameCustomAgents(base, [agent('claude-work', 'claude', false), base[1]]), false);
    assert.equal(sameCustomAgents(base, [agent('claude-work', 'codex'), base[1]]), false);
    assert.equal(sameCustomAgents(base, [base[0]]), false);
    assert.equal(sameCustomAgents([], []), true);
});

test('the identifier holds the type and the command as typed', () => {
    assert.equal(customId(agent('claude-work')), 'custom:claude:claude-work');
    assert.equal(customId(agent('~/bin/codex-team', 'codex')), 'custom:codex:~/bin/codex-team');
    // Another type is a new provider.
    assert.notEqual(customId(agent('x', 'claude')), customId(agent('x', 'agy')));
});

test('a custom agent is a provider of its type, named by its command', () => {
    const provider = customProvider(agent('~/bin/codex-team', 'codex'));
    assert.deepEqual(provider, {
        id: 'custom:codex:~/bin/codex-team', type: 'codex', name: 'codex-team',
        command: '~/bin/codex-team', slots: PROVIDERS.codex.slots, nameOnOwnLine: true, custom: true,
    });
    assert.deepEqual(customProvider(agent('agy-alt', 'agy')).slots, ['gemini-5h', 'gemini-weekly']);
});

test('the menu lists the built-in agents, then the enabled custom ones in the order of the list', () => {
    const list = [agent('b-agent', 'codex'), agent('off-agent', 'claude', false), agent('a-agent')];
    const names = providers => providers.map(provider => provider.name);
    assert.deepEqual(names(enabledProviders(list, () => true)),
        ['Claude', 'Codex', 'Antigravity', 'b-agent', 'a-agent']);
    assert.deepEqual(names(enabledProviders(list, id => id === 'agy')), ['Antigravity', 'b-agent', 'a-agent']);
    assert.deepEqual(names(enabledProviders([], () => false)), []);
});

test('the unavailability messages name the custom command', () => {
    assert.equal(MESSAGES.claudeNotSubscribed(),
        'Claude Code is not signed in with a Claude subscription. Run claude, then /login.');
    assert.equal(MESSAGES.claudeNotSubscribed('claude-work'),
        'Claude Code is not signed in with a Claude subscription. Run claude-work, then /login.');
    assert.equal(MESSAGES.codexNotSignedIn('~/bin/codex-team'), 'Codex is not signed in. Run ~/bin/codex-team login.');
    assert.equal(MESSAGES.codexTooOld('~/bin/codex-team'), 'This codex-team cannot report rate limits. Update Codex.');
    assert.equal(MESSAGES.codexTooOld(), 'This codex cannot report rate limits. Update Codex.');
    assert.equal(MESSAGES.codexNoQuota('~/bin/codex-team'),
        'Codex reports no subscription quota. Sign in with ChatGPT: ~/bin/codex-team login.');
    assert.equal(MESSAGES.agyNotSignedIn('agy-alt'), 'Antigravity is not signed in. Run agy-alt and sign in.');
    assert.equal(MESSAGES.agyUnknown('agy-alt'), 'Antigravity answered /usage in an unknown form. Update agy-alt.');
    assert.equal(MESSAGES.agyUnknown(), 'Antigravity answered /usage in an unknown form. Update agy.');
    assert.equal(missingCliMessage('~/bin/x'), '~/bin/x is not an executable file');
    assert.equal(missingCliMessage('claude-work'), 'claude-work not found in PATH or ~/.local/bin');
});

test('the parsers report their messages with the command they ran', () => {
    const signedOut = {stdout: JSON.stringify({type: 'result', result: 'Total cost: $1'}), exitCode: 0, signal: null};
    assert.deepEqual(parseClaudeRun(signedOut, NOW, 'claude-work'),
        {status: 'unavailable', message: MESSAGES.claudeNotSubscribed('claude-work')});
    assert.deepEqual(parseClaudeRun(signedOut, NOW),
        {status: 'unavailable', message: MESSAGES.claudeNotSubscribed()});
    assert.deepEqual(parseCodexResponse({error: {message: 'Please sign in'}}, '~/bin/codex-team'),
        {status: 'unavailable', message: 'Codex is not signed in. Run ~/bin/codex-team login.'});
    assert.deepEqual(parseCodexResponse({error: {code: -32601, message: 'x'}}, '~/bin/codex-team'),
        {status: 'unavailable', message: 'This codex-team cannot report rate limits. Update Codex.'});
    assert.deepEqual(parseCodexResponse({result: {}}, '~/bin/codex-team'),
        {status: 'unavailable', message: MESSAGES.codexNoQuota('~/bin/codex-team')});
    const authError = {stdout: JSON.stringify({status: 'ERROR', error: 'Authentication required'}), exitCode: 1, signal: null};
    assert.deepEqual(parseAgyRun(authError, 'agy-alt'),
        {status: 'unavailable', message: 'Antigravity is not signed in. Run agy-alt and sign in.'});
    const unknown = {stdout: '{}', exitCode: 0, signal: null};
    assert.deepEqual(parseAgyRun(unknown, 'agy-alt'),
        {status: 'unavailable', message: 'Antigravity answered /usage in an unknown form. Update agy-alt.'});
    assert.deepEqual(parseAgyRun(unknown),
        {status: 'unavailable', message: MESSAGES.agyUnknown()});
});

test('a notification names the custom agent', () => {
    const provider = customProvider(agent('claude-work'));
    assert.equal(notificationTitle(provider, {label: 'Week', usedPercent: 84.2}), 'claude-work weekly quota at 84 %');
    assert.equal(notificationTitle(customProvider(agent('~/bin/codex-team', 'codex')),
        {label: '5 h', usedPercent: 90}), 'codex-team 5-hour quota at 90 %');
});

const window = (slot, resetsAt) => ({
    slot, label: 'Week', usedPercent: 90, durationSeconds: 604800, resetsAt,
});

test('periods of custom agents are kept across a reload, read from the right', () => {
    const work = customProvider(agent('/bin/team'));
    const workPlus = customProvider(agent('/bin/team-work'));
    const reset = NOW + 3600;
    const tracked = trackPeriods({
        provider: work.id, windows: [window('week', reset)], notified: ['claude:week:' + reset],
        threshold: 80, baseline: false, now: NOW,
    });
    assert.equal(tracked.alerts.length, 1);
    assert.deepEqual(tracked.notified.sort(), ['claude:week:' + reset, 'custom:claude:/bin/team:week:' + reset].sort());
    // The same period again does not notify, and another agent's period is its own.
    const again = trackPeriods({
        provider: work.id, windows: [window('week', reset)], notified: tracked.notified,
        threshold: 80, baseline: false, now: NOW,
    });
    assert.deepEqual(again.alerts, []);
    const other = trackPeriods({
        provider: workPlus.id, windows: [window('week', reset)], notified: tracked.notified,
        threshold: 80, baseline: false, now: NOW,
    });
    assert.equal(other.alerts.length, 1);

    const cache = readQuotaCache(JSON.stringify({
        providers: {[work.id]: {windows: [window('week', reset)], readAt: NOW}},
        notified: other.notified,
    }), [...Object.values(PROVIDERS), work, workPlus]);
    assert.deepEqual(cache.notified.sort(), other.notified.sort());
    assert.deepEqual(Object.keys(cache.providers), [work.id]);
});

test('removing /bin/team keeps the marks of /bin/team-work, and built-in marks are unchanged', () => {
    const marks = [
        'custom:claude:/bin/team:week:1795003600', 'custom:claude:/bin/team-work:week:1795003600',
        'custom:codex:/bin/team:primary:1795003600', 'claude:week:1795003600', 'agy:gemini-5h:1795003600',
    ];
    assert.deepEqual(forgetPeriods(marks, 'custom:claude:/bin/team'), [
        'custom:claude:/bin/team-work:week:1795003600', 'custom:codex:/bin/team:primary:1795003600',
        'claude:week:1795003600', 'agy:gemini-5h:1795003600',
    ]);
    assert.deepEqual(forgetPeriods(marks, 'claude'), marks.filter(key => key !== 'claude:week:1795003600'));
    assert.deepEqual(forgetPeriods(marks, 'custom:codex:/bin/team'), marks.filter(key => !key.startsWith('custom:codex')));
});

test('the cache drops the readings and periods of an agent that is not listed and enabled', () => {
    const work = customProvider(agent('claude-work'));
    const gone = customProvider(agent('claude-gone'));
    const asCodex = customProvider(agent('claude-work', 'codex'));
    const reset = 1795003600;
    const text = JSON.stringify({
        providers: {
            [work.id]: {windows: [window('week', reset)], readAt: NOW},
            [gone.id]: {windows: [window('week', reset)], readAt: NOW},
            claude: {windows: [window('week', reset)], readAt: NOW},
        },
        notified: [`${work.id}:week:${reset}`, `${gone.id}:week:${reset}`, `${asCodex.id}:primary:${reset}`,
            `claude:week:${reset}`, `custom:claude:claude-work:primary:${reset}`],
    });
    const cache = readQuotaCache(text, [PROVIDERS.claude, work]);
    assert.deepEqual(Object.keys(cache.providers).sort(), ['claude', work.id].sort());
    // A slot of another type is no period of the agent, and an unlisted agent has none.
    assert.deepEqual(cache.notified, [`${work.id}:week:${reset}`, `claude:week:${reset}`]);
    assert.deepEqual(readQuotaCache(text, []), {providers: {}, notified: []});
});

const opened = () => ({
    author: '@me', refreshInterval: 120, shortcut: {kind: 'blank'}, owners: [], ownerOrder: [],
    switches: {'claude-quota-enabled': true}, customAgents: [agent('claude-work'), agent('codex-team', 'codex')],
    quotaInterval: 60, threshold: 80, routines: [],
});
const plan = (shown, pending = new Set()) => planChanges(shown, opened(), pending, []);

test('the custom agents are one setting of the Agents tab', () => {
    assert.deepEqual(plan(opened()), {tabs: [], writes: [], invalidShortcut: false});
    const added = {...opened(), customAgents: [...opened().customAgents, agent('agy-alt', 'agy')]};
    assert.deepEqual(plan(added).tabs, ['Agents']);
    assert.deepEqual(plan(added).writes, [{key: 'custom-agents', value: writeCustomAgents(added.customAgents)}]);
    const removed = {...opened(), customAgents: [agent('codex-team', 'codex')]};
    assert.deepEqual(plan(removed).tabs, ['Agents']);
    const switched = {...opened(), customAgents: [agent('claude-work', 'claude', false), agent('codex-team', 'codex')]};
    assert.deepEqual(plan(switched).tabs, ['Agents']);
    // Switching back, or removing what was added, brings the list back to its baseline.
    assert.deepEqual(plan({...switched, customAgents: opened().customAgents}).tabs, []);
    assert.deepEqual(plan({...added, customAgents: added.customAgents.slice(0, 2)}).writes, []);
    // A built-in switch writes its own key only.
    assert.deepEqual(plan({...opened(), switches: {'claude-quota-enabled': false}}).writes,
        [{key: 'claude-quota-enabled', value: false}]);
});

test('a list normalized by a check is written without a banner', () => {
    // The window adjusts its baseline as it adjusts the switch, and marks the key pending.
    const baseline = {...opened(), customAgents: [agent('claude-work', 'claude', false), agent('codex-team', 'codex')]};
    const shown = {...baseline};
    assert.deepEqual(planChanges(shown, baseline, new Set(), []).writes, []);
    const normalized = planChanges(shown, baseline, new Set(['custom-agents']), []);
    assert.deepEqual(normalized.tabs, []);
    assert.deepEqual(normalized.writes, [{key: 'custom-agents', value: writeCustomAgents(shown.customAgents)}]);
});
