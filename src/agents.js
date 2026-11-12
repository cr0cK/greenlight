import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    AGY_ARGS,
    CLAUDE_ARGS,
    MESSAGES,
    PROVIDERS,
    codexMessages,
    failed,
    isAgyAuthError,
    missingCliMessage,
    parseAgyRun,
    parseClaudeRun,
    parseCodexResponse,
    unavailable,
} from './quotas.js';

const CLAUDE_TIMEOUT_SECONDS = 30;
const CODEX_TIMEOUT_SECONDS = 15;
const AGY_TIMEOUT_SECONDS = 30;

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

/**
 * Runs the CLI from home, with its own directory first in PATH for any helper it starts, after
 * the directories in `leadingDirs`.
 */
function spawn(path, args, flags, leadingDirs = []) {
    const launcher = new Gio.SubprocessLauncher({flags});
    const searchPath = [...leadingDirs, GLib.path_get_dirname(path), localBin(), GLib.getenv('PATH') ?? '']
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
        return Promise.resolve(failed('could not start: ' + error.message));
    }

    // Reads stop on the caller's cancel or on the timeout, even when a child of the CLI still
    // holds its output open after the process is killed.
    const reading = new Gio.Cancellable();
    let timedOut = false;
    const clearTimeout = startTimeout(CLAUDE_TIMEOUT_SECONDS, () => {
        timedOut = true;
        process.force_exit();
        reading.cancel();
    });
    const cancelledId = cancellable.connect(() => {
        process.force_exit();
        reading.cancel();
    });

    return new Promise((resolve, reject) => {
        process.communicate_utf8_async(null, reading, (subprocess, result) => {
            clearTimeout();
            cancellable.disconnect(cancelledId);
            try {
                const [, stdout] = subprocess.communicate_utf8_finish(result);
                if (timedOut) {
                    resolve(failed('timed out'));
                } else {
                    const exited = subprocess.get_if_exited();
                    resolve(parseClaudeRun({
                        stdout: stdout ?? '',
                        exitCode: exited ? subprocess.get_exit_status() : null,
                        signal: exited ? null : subprocess.get_term_sig(),
                    }, Date.now() / 1000));
                }
            } catch (error) {
                if (cancellable.is_cancelled())
                    reject(error);
                else
                    resolve(failed(timedOut ? 'timed out' : error.message));
            }
        });
    });
}

/** The server closed its output before answering: it ended. */
class EndOfStream extends Error {}

/** Why a codex that closed its output ended: `exited with code N` or `killed by signal N`. */
async function endCause(process, reading) {
    await new Promise((resolve, reject) => {
        process.wait_async(reading, (subprocess, result) => {
            try {
                resolve(subprocess.wait_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
    return process.get_if_exited()
        ? failed('exited with code ' + process.get_exit_status())
        : failed('killed by signal ' + process.get_term_sig());
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
                    reject(new EndOfStream());
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
        return failed('could not start: ' + error.message);
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
        try {
            process.get_stdin_pipe().write_all(new TextEncoder().encode(codexMessages(version)), null);
        } catch (error) {
            // A server that already ended, such as a codex without `app-server`, breaks the pipe.
            throw error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.BROKEN_PIPE)
                ? new EndOfStream()
                : error;
        }
        const initialized = await readResponse(stdout, 1, reading);
        if (initialized.error)
            return failed(String(initialized.error.message ?? 'could not start'));
        return parseCodexResponse(await readResponse(stdout, 2, reading));
    } catch (error) {
        if (cancellable.is_cancelled())
            throw error;
        if (timedOut)
            return failed('timed out');
        if (error instanceof EndOfStream) {
            try {
                return await endCause(process, reading);
            } catch (waitError) {
                if (cancellable.is_cancelled())
                    throw waitError;
                return failed(timedOut ? 'timed out' : waitError.message);
            }
        }
        return failed(error.message);
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
 * Writes the no-op `xdg-open` that keeps a signed-out agy from opening a browser: agy starts
 * `xdg-open` from its PATH and ignores BROWSER. Returns the directory to put first in its PATH.
 */
function ensureNoBrowser() {
    const directory = GLib.build_filenamev([GLib.get_user_cache_dir(), 'greenlight', 'no-browser']);
    const script = GLib.build_filenamev([directory, 'xdg-open']);
    const present = GLib.file_test(script, GLib.FileTest.IS_EXECUTABLE) &&
        !GLib.file_test(script, GLib.FileTest.IS_DIR);
    if (!present) {
        if (GLib.mkdir_with_parents(directory, 0o755) !== 0)
            throw new Error('cannot create ' + directory);
        GLib.file_set_contents_full(script, '#!/bin/sh\nexit 0\n', GLib.FileSetContentsFlags.NONE, 0o755);
        // The process umask may have narrowed the mode.
        GLib.chmod(script, 0o755);
    }
    return directory;
}

/**
 * Reads lines of agy's stderr until an authentication error. Resolves true when it arrives, and false
 * when the stream ends, fails, or is cancelled; it never rejects.
 */
function readSignInLine(stream, cancellable) {
    return new Promise(resolve => {
        const next = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                let line;
                try {
                    [line] = source.read_line_finish_utf8(result);
                } catch {
                    resolve(false);
                    return;
                }
                if (line === null)
                    resolve(false);
                else if (isAgyAuthError(line))
                    resolve(true);
                else
                    next();
            });
        };
        next();
    });
}

/** Reads a stream to its end as text; resolves null when it fails or is cancelled. */
function readToEnd(stream, cancellable) {
    return new Promise(resolve => {
        const chunks = [];
        const next = () => {
            stream.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                let bytes;
                try {
                    bytes = source.read_bytes_finish(result);
                } catch {
                    resolve(null);
                    return;
                }
                if (bytes.get_size() === 0) {
                    // Decoded once, so a character split across two reads stays whole.
                    const whole = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
                    let offset = 0;
                    for (const chunk of chunks) {
                        whole.set(chunk, offset);
                        offset += chunk.length;
                    }
                    resolve(new TextDecoder().decode(whole));
                } else {
                    chunks.push(bytes.toArray());
                    next();
                }
            });
        };
        next();
    });
}

/** Resolves true once the process has exited, false when `cancellable` cancels the wait. */
function waitForExit(process, cancellable) {
    return new Promise(resolve => {
        process.wait_async(cancellable, (subprocess, result) => {
            try {
                subprocess.wait_finish(result);
                resolve(true);
            } catch {
                resolve(false);
            }
        });
    });
}

async function readAgy(path, cancellable) {
    let process;
    try {
        process = spawn(path, AGY_ARGS, Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE, [ensureNoBrowser()]);
    } catch (error) {
        return failed('could not start: ' + error.message);
    }

    // Reads stop on the caller's cancel, on the timeout, or at the sign-in line; either way the
    // process goes.
    const reading = new Gio.Cancellable();
    let timedOut = false;
    const clearTimeout = startTimeout(AGY_TIMEOUT_SECONDS, () => {
        timedOut = true;
        reading.cancel();
    });
    const cancelledId = cancellable.connect(() => reading.cancel());
    const stdin = process.get_stdin_pipe();
    const stdout = process.get_stdout_pipe();
    const stderr = new Gio.DataInputStream({
        base_stream: process.get_stderr_pipe(),
        close_base_stream: true,
    });

    try {
        stdin.close(null);
    } catch {
        // Already closed.
    }
    const signedOut = readSignInLine(stderr, reading);
    const answer = readToEnd(stdout, reading);
    const exited = waitForExit(process, reading);
    try {
        // A signed-out agy waits for a browser, or ends by itself when stdin is closed with an
        // error answer: either way its stderr line decides, so a process that ended is not
        // read before stderr did.
        const isSignedOut = await new Promise(resolve => {
            signedOut.then(found => found && resolve(true));
            Promise.all([answer, exited, signedOut]).then(() => resolve(false));
        });
        if (cancellable.is_cancelled())
            throw new Error('cancelled');
        if (isSignedOut)
            return unavailable(MESSAGES.agyNotSignedIn);
        if (timedOut)
            return failed('timed out');
        const stdoutText = await answer;
        if (stdoutText === null)
            return failed('could not read the answer');
        const wasExited = process.get_if_exited();
        return parseAgyRun({
            stdout: stdoutText,
            exitCode: wasExited ? process.get_exit_status() : null,
            signal: wasExited ? null : process.get_term_sig(),
        });
    } finally {
        clearTimeout();
        cancellable.disconnect(cancelledId);
        // Cancelling ends the reads still pending; a stream is closed only once they settled.
        reading.cancel();
        await Promise.all([signedOut, answer, exited]);
        for (const stream of [stdout, stderr]) {
            try {
                stream.close(null);
            } catch {
                // Already closed.
            }
        }
        // Closing its pipes and SIGTERM end a signed-out agy, which then prints an error answer
        // and exits.
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
    if (provider === 'claude')
        return readClaude(path, cancellable);
    return provider === 'agy' ? readAgy(path, cancellable) : readCodex(path, version, cancellable);
}
