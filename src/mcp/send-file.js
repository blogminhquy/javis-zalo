/**
 * Logic of the MCP tool `zalo_send_file`, kept apart from the registration so it can be tested
 * with a fake API.
 *
 * The tool runs inside `mcp start`, the one process whose listener is connected, so Zalo's
 * upload confirmation reaches it (see core/send-files.js). It sends only files placed in the
 * session's outbox folder: the tool is visible to the model, and a free path would let one
 * crafted prompt send any file on the server (credentials, keys) to a chat.
 */

import { basename } from "node:path";
import { filesInside, OUTBOX_DIR, sendAttachments, UPLOAD_CONFIRM_TIMEOUT_MS } from "../core/send-files.js";

/** zca-js MAX_FILE is read from Zalo settings at login; keep one call small anyway. */
export const MAX_FILES_PER_SEND = 10;

/**
 * Send files from the outbox to a thread.
 * @param {object} api - zca-js API instance holding the live listener
 * @param {{ threadId: string, threadType?: number, paths: string[], caption?: string }} args
 * @param {{ outbox?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ success: true, sent: number, files: string[], messageIds: string[] }>}
 */
export async function sendFileFromOutbox(api, args, opts = {}) {
    const { threadId, threadType = 0, paths, caption = "" } = args;
    if (!paths?.length) throw new Error("No paths given");
    if (paths.length > MAX_FILES_PER_SEND) throw new Error(`At most ${MAX_FILES_PER_SEND} files per send`);
    const files = filesInside(paths, opts.outbox ?? OUTBOX_DIR);
    const result = await sendAttachments(api, { msg: caption, paths: files }, threadId, Number(threadType), {
        timeoutMs: opts.timeoutMs ?? UPLOAD_CONFIRM_TIMEOUT_MS,
    });
    const messageIds = (result?.attachment ?? [])
        .map((a) => a?.msgId)
        .filter((id) => id !== undefined && id !== null)
        .map(String);
    return { success: true, sent: files.length, files: files.map((f) => basename(f)), messageIds };
}
