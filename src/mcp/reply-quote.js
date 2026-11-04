/**
 * Quote-reply (1.11.0): send a message as a reply to one earlier message, so Zalo shows the quote bubble above it.
 *
 * zca-js `sendMessage({ msg, quote })` needs the quoted message's content, type, owner, both ids, time and ttl.
 * The MCP server already keeps most of that (live buffer and history store), so the caller only passes `msgId`.
 * Only TEXT messages can be quoted this way: the stores keep the text of a message, not the full payload of an
 * image, sticker or file, and zca-js refuses some payload types anyway.
 *
 * Kept free of zca-js imports so it can be unit-tested in isolation.
 */

/**
 * Find a stored message by its id, live buffer first, then history.
 * @param {string} threadId
 * @param {string} msgId
 * @param {{ buffer?: object, historyStore?: object }} stores
 * @returns {{ senderId: string|null, text: string|null, type: string|null, cliMsgId: string|null, timestamp: number|null }|null}
 */
function findStored(threadId, msgId, { buffer, historyStore } = {}) {
    const old = historyStore?.find?.(threadId, msgId);
    if (old) {
        return {
            senderId: old.senderId ?? null,
            text: old.text ?? null,
            type: old.type ?? null,
            cliMsgId: old.cliMsgId ?? null,
            timestamp: old.timestamp ?? null,
        };
    }
    const live = buffer?.find?.(threadId, msgId);
    if (live) {
        return {
            senderId: live.senderId ?? null,
            text: live.text ?? null,
            type: live.type ?? null,
            cliMsgId: live.cliMsgId ?? null,
            timestamp: live.timestamp ?? null,
        };
    }
    return null;
}

/**
 * Build the zca-js `quote` object for a stored text message.
 * @param {string} threadId
 * @param {string} msgId - id of the message to reply to (`id` / `msgId` from zalo_get_messages / zalo_get_history)
 * @param {{ buffer?: object, historyStore?: object }} stores
 * @returns {object} zca-js SendMessageQuote
 * @throws {Error} the message is unknown, has no client id, is not a text message, or has no sender
 */
export function buildQuote(threadId, msgId, stores = {}) {
    const m = findStored(threadId, String(msgId), stores);
    if (!m) {
        throw new Error(
            `Message ${msgId} is not in the live buffer or history of thread ${threadId}, so it cannot be quoted. ` +
                "Read it first with zalo_get_messages / zalo_get_history, or send without replyToMsgId.",
        );
    }
    if (!m.cliMsgId) {
        throw new Error(`Message ${msgId} has no client id (cliMsgId), so it cannot be quoted.`);
    }
    if (!m.senderId) {
        throw new Error(`Message ${msgId} has no sender id, so it cannot be quoted.`);
    }
    if (m.type !== "text" || typeof m.text !== "string" || m.text === "") {
        throw new Error(
            `Message ${msgId} is not a text message (type: ${m.type ?? "unknown"}); only text messages can be quoted.`,
        );
    }
    return {
        content: m.text,
        msgType: "webchat",
        propertyExt: undefined,
        uidFrom: String(m.senderId),
        msgId: String(msgId),
        cliMsgId: String(m.cliMsgId),
        ts: String(m.timestamp ?? Date.now()),
        ttl: 0,
    };
}
