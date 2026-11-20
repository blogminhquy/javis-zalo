/**
 * Logic of the MCP tool `zalo_undo_message`, kept apart from the registration so it can be tested with a fake API.
 * Recalls a message this account sent, for both sides. Zalo needs the client id (`cliMsgId`) next to `msgId`.
 */

import { lookupCliMsgId } from "./reactions.js";

/**
 * Recall a sent message. `cliMsgId` is taken from the call when given, else from the live buffer, else from the
 * history store. When none knows it, this throws before anything is sent to Zalo.
 * @param {object} api - zca-js API instance (the live one)
 * @param {{ threadId: string, threadType?: number, msgId: string, cliMsgId?: string }} args
 * @param {{ buffer?: object, historyStore?: object }} [stores]
 * @returns {Promise<{ success: true, msgId: string, cliMsgId: string, status: * }>}
 * @throws {Error} a message whose client id nobody knows
 */
export async function undoSentMessage(api, { threadId, threadType = 0, msgId, cliMsgId }, stores = {}) {
    const resolved = cliMsgId ? String(cliMsgId) : lookupCliMsgId(threadId, String(msgId), stores);
    if (!resolved) {
        throw new Error(
            `Message ${msgId} has no known cliMsgId (not in the live buffer or history). Pass cliMsgId: it is returned by zalo_send_message / zalo_send_link / zalo_send_file.`,
        );
    }
    const result = await api.undo({ msgId: String(msgId), cliMsgId: resolved }, threadId, Number(threadType));
    return { success: true, msgId: String(msgId), cliMsgId: resolved, status: result?.status ?? null };
}
