/**
 * Sending attachments with a deadline.
 *
 * zca-js uploads an image and gets its URL back in the HTTP reply. Every other file (xlsx, pdf,
 * docx, zip, mp4...) goes to `asyncfile/upload`, and Zalo only reports the finished file
 * (`file_done`) over the live WebSocket. zca-js waits for that event with no deadline, so a
 * process without an open listener (every one-shot CLI command) hangs forever on a file.
 *
 * Opening a second listener is not a fix either: Zalo keeps one Web connection per account and
 * evicts the older one, and the MCP server exits when it is evicted. So files are sent from the
 * process that already holds the connection (MCP tool `zalo_send_file`), and every send here has
 * a deadline that turns a missing confirmation into a clear error.
 */

import fs from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { CONFIG_DIR } from "./credentials.js";

/** Extensions zca-js uploads as images or GIFs: their URL comes back in the HTTP reply. */
const NO_CONFIRM_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

/** How long to wait for Zalo to confirm a file upload. Callers on a 120 s budget need room to spare. */
export const UPLOAD_CONFIRM_TIMEOUT_MS = 60_000;

/** Files the MCP tool may send must sit here (see `zalo_send_file`). */
export const OUTBOX_DIR = resolve(CONFIG_DIR, "outbox");

/**
 * Whether Zalo confirms this file only over the live connection.
 * @param {string} path
 * @returns {boolean}
 */
export function needsLiveConfirm(path) {
    return !NO_CONFIRM_EXTS.has(extname(String(path)).slice(1).toLowerCase());
}

/**
 * Whether the listener's WebSocket is open right now.
 * @param {object} api - zca-js API instance
 * @returns {boolean}
 */
export function isListening(api) {
    return api?.listener?.ws?.readyState === 1;
}

/**
 * Resolve `paths` and check each is a regular file inside `root`. Throws on the first bad one.
 * @param {string[]} paths
 * @param {string} root
 * @returns {string[]} absolute paths
 */
export function filesInside(paths, root) {
    let base;
    try {
        base = fs.realpathSync(root);
    } catch {
        throw new Error(`${root} does not exist; copy the files to send there first`);
    }
    return paths.map((p) => {
        let full;
        try {
            full = fs.realpathSync(resolve(String(p)));
        } catch {
            throw new Error(`File not found: ${p}`);
        }
        if (full !== base && !full.startsWith(base + sep)) {
            throw new Error(`${basename(String(p))} is outside ${root}; only files placed there can be sent`);
        }
        if (!fs.statSync(full).isFile()) throw new Error(`Not a file: ${p}`);
        return full;
    });
}

// One attachment send at a time per process, so the upload wrapper below knows which send a
// confirmation belongs to.
let queue = Promise.resolve();
let activeSend = null;
const wrapped = new WeakSet();

/**
 * Wrap `api.uploadAttachment` once so an upload confirmed after its send was cancelled throws
 * instead of letting zca-js go on to post the message. sendMessage calls it as a property of
 * `api`, which is the only hook zca-js leaves.
 */
function guardUploads(api) {
    if (wrapped.has(api)) return;
    const original = api.uploadAttachment;
    api.uploadAttachment = async (...args) => {
        const send = activeSend;
        const res = await original.apply(api, args);
        if (send?.cancelled) throw new Error("upload confirmed after the deadline; send cancelled");
        return res;
    };
    wrapped.add(api);
}

/**
 * Send files with an optional caption, failing after `timeoutMs` instead of hanging.
 *
 * On timeout the send is cancelled: if Zalo confirms the upload later, the message is NOT sent,
 * so a caller told "failed" never ends up with the file delivered behind its back.
 *
 * @param {object} api - zca-js API instance
 * @param {{ msg?: string, paths: string[] }} content
 * @param {string} threadId
 * @param {number} type - 0 = user, 1 = group
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object>} the sendMessage result
 */
export function sendAttachments(api, content, threadId, type, opts = {}) {
    const run = queue.then(() => sendOnce(api, content, threadId, type, opts));
    queue = run.catch(() => {});
    return run;
}

async function sendOnce(api, { msg = "", paths }, threadId, type, { timeoutMs = UPLOAD_CONFIRM_TIMEOUT_MS } = {}) {
    const waiting = paths.filter(needsLiveConfirm);
    if (waiting.length && !isListening(api)) {
        throw new Error(
            "Zalo confirms file uploads only over the live connection, and it is not open in this process. " +
                "Send files with the MCP tool zalo_send_file (the MCP server keeps that connection open).",
        );
    }

    guardUploads(api);
    const send = { cancelled: false };
    activeSend = send;

    let timer;
    const sending = api.sendMessage({ msg, attachments: paths }, threadId, type);
    // The race below may settle first; a late rejection must not crash the process.
    sending.catch(() => {});
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            send.cancelled = true;
            const names = (waiting.length ? waiting : paths).map((p) => basename(p)).join(", ");
            reject(
                new Error(
                    `Zalo did not confirm the upload of ${names} within ${Math.round(timeoutMs / 1000)}s. ` +
                        "Nothing was sent. Check the connection and try again.",
                ),
            );
        }, timeoutMs);
    });
    try {
        return await Promise.race([sending, deadline]);
    } finally {
        clearTimeout(timer);
        if (activeSend === send) activeSend = null;
    }
}
