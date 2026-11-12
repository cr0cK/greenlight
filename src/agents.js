import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    CLAUDE_ARGS,
    PROVIDERS,
    codexMessages,
    failed,
    missingCliMessage,
    parseClaudeUsage,
    parseCodexResponse,
    unavailable,
} from './quotas.js';

const CLAUDE_TIMEOUT_SECONDS = 30;
const CODEX_TIMEOUT_SECONDS = 15;

function localBin() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin']);
}

/**
 * Finds an agent CLI. GNOME Shell does not inherit the login shell's PATH, which usually lacks
 * ~/.local/bin, where both CLIs install.
 */
export function findCli(command) {
    const inPath = GLib.find_program_in_path(command);
    if (inPath)
        return inPath;
    const local = GLib.build_filenamev([localBin(), command]);
    return GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) &&
        !GLib.file_test(local, GLib.FileTest.IS_DIR)
        ? local
        : null;
}

/** Runs the CLI from home, with its own directory first in PATH for any helper it starts. */
function spawn(path, args, flags) {
    const launcher = new Gio.SubprocessLauncher({flags});
    const searchPath = [GLib.path_get_dirname(path), localBin(), GLib.getenv('PATH') ?? '']
        .filter(Boolean)
        .join(':');
    launcher.setenv('PATH', searchPath, true);
    launcher.set_cwd(GLib.get_home_dir());
    return launcher.spawnv([path, ...args]);
}

/** Calls `callback` after `seconds` unless the returned function clears it first. */
function startTimeout(seconds, callback) {
    let sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
        sourceId = 0;
        callback();
        return GLib.SOURCE_REMOVE;
    });
    return () => {
        if (sourceId)
            GLib.Source.remove(sourceId);
        sourceId = 0;
    };
}

function readClaude(path, cancellable) {
    let process;
    try {
        process = spawn(path, CLAUDE_ARGS,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (error) {
        return Promise.resolve(unavailable('Could not start claude: ' + error.message));
    }

    let timedOut = false;
    const clearTimeout = startTimeout(CLAUDE_TIMEOUT_SECONDS, () => {
        timedOut = true;
        process.force_exit();
    });
    const cancelledId = cancellable.connect(() => process.force_exit());

    return new Promise((resolve, reject) => {
        process.communicate_utf8_async(null, cancellable, (subprocess, result) => {
            clearTimeout();
            cancellable.disconnect(cancelledId);
            try {
                const [, stdout] = subprocess.communicate_utf8_finish(result);
                if (timedOut)
                    resolve(failed('timed out'));
                else if (!subprocess.get_if_exited())
                    resolve(failed('stopped before answering'));
                else if (subprocess.get_exit_status() !== 0)
                    resolve(failed('exited with code ' + subprocess.get_exit_status()));
                else
                    resolve(parseClaudeUsage(stdout ?? '', Date.now() / 1000));
            } catch (error) {
                if (cancellable.is_cancelled())
                    reject(error);
                else
                    resolve(failed(timedOut ? 'timed out' : error.message));
            }
        });
    });
}

/** Reads lines until the JSON-RPC message with `id`; other messages are skipped. */
function readResponse(stream, id, cancellable) {
    return new Promise((resolve, reject) => {
        const next = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                let line;
                try {
                    [line] = source.read_line_finish_utf8(result);
                } catch (error) {
                    reject(error);
                    return;
                }
                if (line === null) {
                    reject(new Error('exited before answering'));
                    return;
                }
                let message = null;
                try {
                    message = JSON.parse(line);
                } catch {
                    // Not a message: keep reading.
                }
                if (message?.id === id)
                    resolve(message);
                else
                    next();
            });
        };
        next();
    });
}

async function readCodex(path, version, cancellable) {
    let process;
    try {
        process = spawn(path, ['app-server'], Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (error) {
        return unavailable('Could not start codex: ' + error.message);
    }

    // Reads stop on the caller's cancel or on the timeout; either way the process goes.
    const reading = new Gio.Cancellable();
    let timedOut = false;
    const clearTimeout = startTimeout(CODEX_TIMEOUT_SECONDS, () => {
        timedOut = true;
        reading.cancel();
    });
    const cancelledId = cancellable.connect(() => reading.cancel());
    const stdout = new Gio.DataInputStream({
        base_stream: process.get_stdout_pipe(),
        close_base_stream: true,
    });

    try {
        // The server handles the three messages in order, so they go at once, while it is
        // surely alive. Stdin stays open: closing it makes the server quit before answering.
        process.get_stdin_pipe().write_all(new TextEncoder().encode(codexMessages(version)), null);
        const initialized = await readResponse(stdout, 1, reading);
        if (initialized.error)
            return failed(String(initialized.error.message ?? 'could not start'));
        return parseCodexResponse(await readResponse(stdout, 2, reading));
    } catch (error) {
        if (cancellable.is_cancelled())
            throw error;
        return failed(timedOut ? 'timed out' : error.message);
    } finally {
        clearTimeout();
        cancellable.disconnect(cancelledId);
        // Closing stdin ends the server even behind a launcher that runs it as a child, which a
        // kill of the launcher alone would leave waiting; SIGTERM lets a launcher forward it.
        for (const stream of [process.get_stdin_pipe(), stdout]) {
            try {
                stream.close(null);
            } catch {
                // Already closed.
            }
        }
        process.send_signal(15);
    }
}

/**
 * Reads one provider's quota through its own CLI. Resolves to `{status: 'ok', windows}`,
 * `{status: 'unavailable', message}`, or `{status: 'failed', message}`; rejects only when
 * `cancellable` is cancelled.
 */
export function readQuota(provider, {version, cancellable}) {
    const command = PROVIDERS[provider].command;
    const path = findCli(command);
    if (!path)
        return Promise.resolve(unavailable(missingCliMessage(command)));
    return provider === 'claude'
        ? readClaude(path, cancellable)
        : readCodex(path, version, cancellable);
}
