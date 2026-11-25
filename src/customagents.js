// Custom agents: the user's own commands that run Claude Code, Codex, or Antigravity under
// another name, read as the agent of their quota type. The command forms, the clash rules, the
// storage reader, the identifier, and the comparison of the list. Pure: it imports nothing from
// gi://, so node --test covers it. What needs the disk (a command found, a link to a built-in
// CLI) is the caller's: see the two messages at the end.

import {PROVIDERS, commandName, isPathCommand} from './quotas.js';

export const MAX_CUSTOM_AGENTS = 5;

/** The quota types, in the order of the drop-down, with the label it shows. */
export const AGENT_TYPES = ['claude', 'codex', 'agy'];
export const TYPE_LABELS = {claude: 'Claude', codex: 'Codex', agy: 'Antigravity'};

const NAME_FORM = /^[A-Za-z0-9._+-]+$/;

/**
 * Reads what the user typed as a command, trimmed. `kind` is `name` (looked up in PATH), `path`
 * (`/…` or `~/…`), `colon` (a path holding `:`, which could not go in PATH), or `invalid`; `name`
 * is the last path component, empty for an invalid form.
 */
export function parseCommand(text) {
    const command = String(text).trim();
    if (isPathCommand(command)) {
        const name = commandName(command);
        if (name === '')
            return {kind: 'invalid', command, name: ''};
        return {kind: command.includes(':') ? 'colon' : 'path', command, name};
    }
    return NAME_FORM.test(command)
        ? {kind: 'name', command, name: command}
        : {kind: 'invalid', command, name: ''};
}

/** A built-in agent's name, in any case, is no name for a custom agent. */
function isBuiltinName(name) {
    const lower = name.toLowerCase();
    return Object.values(PROVIDERS).some(provider => provider.name.toLowerCase() === lower);
}

/** Whether `entry` clashes with an entry of `list`: the same command, or the same name in any case. */
function clash(list, command, name) {
    if (list.some(entry => entry.command === command))
        return 'command';
    return list.some(entry => commandName(entry.command).toLowerCase() === name.toLowerCase())
        ? 'name'
        : null;
}

/**
 * Checks what does not need the disk, in the order of the reasons of the preferences: the form,
 * a `:` in a path, a built-in name, then a command or a name already listed. Returns
 * `{ok: true, command, name}`, or `{ok: false, reason}` with the first reason that holds.
 */
export function checkCommand(list, text) {
    const parsed = parseCommand(text);
    if (parsed.kind === 'invalid')
        return {ok: false, reason: 'Enter a command name or a path.'};
    if (parsed.kind === 'colon')
        return {ok: false, reason: 'A path cannot hold ":".'};
    if (isBuiltinName(parsed.name))
        return {ok: false, reason: parsed.name + ' is a built-in agent\'s name.'};
    const found = clash(list, parsed.command, parsed.name);
    if (found === 'command')
        return {ok: false, reason: parsed.command + ' is already listed.'};
    if (found === 'name')
        return {ok: false, reason: parsed.name + ' is already listed.'};
    return {ok: true, command: parsed.command, name: parsed.name};
}

/** The reason of a command the disk does not have (a name is looked up, a path must be a file). */
export {missingCliMessage as notFoundMessage} from './quotas.js';

/** The reason of a command that is the built-in agent of its type. */
export function builtinMessage(command, type) {
    return command + ' is the built-in ' + TYPE_LABELS[type] + ' agent.';
}

/** A found path as the preferences show it: the home directory as `~`, so no user name is shown. */
export function displayPath(path, home) {
    if (path === home)
        return '~';
    return home && home !== '/' && path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

/** Whether another custom agent may still be added. */
export function canAddAgent(list) {
    return list.length < MAX_CUSTOM_AGENTS;
}

/**
 * Reads `custom-agents`: text that is not a JSON array is an empty list. An entry is skipped when
 * it is not an object `{command, type, enabled}` with a string command, a known type, and a
 * boolean `enabled`, when its command has no valid form or its name is a built-in agent's, or
 * when its command or name clashes with an earlier kept entry; the list stops at five kept
 * entries. The files are never looked at: a command missing on disk stays listed.
 */
export function readCustomAgents(text) {
    let stored;
    try {
        stored = JSON.parse(text);
    } catch {
        return [];
    }
    if (!Array.isArray(stored))
        return [];
    const list = [];
    for (const entry of stored) {
        if (list.length >= MAX_CUSTOM_AGENTS)
            break;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
            typeof entry.command !== 'string' || !AGENT_TYPES.includes(entry.type) ||
            typeof entry.enabled !== 'boolean')
            continue;
        const checked = checkCommand(list, entry.command);
        if (checked.ok)
            list.push({command: checked.command, type: entry.type, enabled: entry.enabled});
    }
    return list;
}

/** The text of `custom-agents` for a list, in order. */
export function writeCustomAgents(list) {
    return JSON.stringify(list.map(({command, type, enabled}) => ({command, type, enabled})));
}

/** Whether two lists are the same setting: the same commands, types, switches, in the same order. */
export function sameCustomAgents(first, second) {
    return writeCustomAgents(first) === writeCustomAgents(second);
}

/** The identifier of a custom agent as a provider: its readings and periods are kept under it. */
export function customId({command, type}) {
    return 'custom:' + type + ':' + command;
}

/**
 * A custom agent as a provider of its own: read as its type, named by its command's last path
 * component, which takes its own line above its windows in the menu.
 */
export function customProvider(entry) {
    return {
        id: customId(entry),
        type: entry.type,
        name: commandName(entry.command),
        command: entry.command,
        slots: PROVIDERS[entry.type].slots,
        nameOnOwnLine: true,
        custom: true,
    };
}

/**
 * The providers to read and show, in menu order: the built-in agents that `isBuiltinEnabled`
 * accepts (by identifier), then the enabled custom agents in the order of the list.
 */
export function enabledProviders(list, isBuiltinEnabled) {
    return [
        ...Object.values(PROVIDERS).filter(provider => isBuiltinEnabled(provider.id)),
        ...list.filter(entry => entry.enabled).map(customProvider),
    ];
}
