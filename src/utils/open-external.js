/**
 * Open a URL or file with the system's default handler, without a shell.
 *
 * Arguments go to the process as an array, so a URL or file name containing
 * quotes, `&`, `|`, `;` or `$()` is passed through as data and never parsed
 * as a command. On Windows, `explorer.exe` is used instead of the cmd.exe
 * builtin `start`, which would need a shell.
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Pick the opener command for a platform.
 * @param {string} [os] - Value of os.platform(); defaults to the current one
 * @returns {string}
 */
export function openerFor(os = platform()) {
    if (os === "darwin") return "open";
    if (os === "win32") return "explorer.exe";
    return "xdg-open";
}

/**
 * Open `target` (URL or path) in the default app. Fire-and-forget: failures are logged to stderr.
 * @param {string} target
 * @param {object} [deps] - injectable for tests
 * @param {Function} [deps.spawnFn]
 * @param {string} [deps.os]
 */
export function openExternal(target, { spawnFn = spawn, os = platform() } = {}) {
    try {
        const child = spawnFn(openerFor(os), [String(target)], {
            detached: true,
            stdio: "ignore",
            shell: false,
            windowsHide: true,
        });
        child.on?.("error", (err) => console.error(`[open] Failed to open ${target}: ${err.message}`));
        child.unref?.();
    } catch (err) {
        console.error(`[open] Failed to open ${target}: ${err.message}`);
    }
}

/**
 * Check whether an executable is on PATH, without a shell.
 * @param {string} name
 * @param {object} [deps]
 * @param {Function} [deps.spawnFn]
 * @param {string} [deps.os]
 * @returns {Promise<boolean>}
 */
export function hasExecutable(name, { spawnFn = spawn, os = platform() } = {}) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(name))) return Promise.resolve(false);
    const finder = os === "win32" ? "where" : "which";
    return new Promise((resolve) => {
        try {
            const child = spawnFn(finder, [String(name)], { stdio: "ignore", shell: false, windowsHide: true });
            child.on("error", () => resolve(false));
            child.on("exit", (code) => resolve(code === 0));
        } catch {
            resolve(false);
        }
    });
}
