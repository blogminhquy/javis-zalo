/**
 * Pure helpers that normalize raw zca-js message events into the shapes used by the
 * MCP live buffer and history store. Kept dependency-light (only extractMessageText)
 * so the zca-js field mapping can be unit-tested in isolation.
 */

import { extractMessageText } from "../utils/extract-message-text.js";

/** Map a zca-js thread type (0/1) to the string label used across the buffer/history. */
export function threadTypeLabel(type) {
    return type === 0 ? "dm" : "group";
}

/**
 * Resolve a zca-js message's content into a plain-text string and a type label.
 * Text messages carry a string content; everything else is an object we flatten
 * via extractMessageText (reply/bubble/link/etc.).
 * @param {*} rawContent - msg.data.content
 * @param {string} [msgType] - msg.data.msgType
 * @returns {{ isText: boolean, text: string, type: string }}
 */
export function resolveContent(rawContent, msgType) {
    const isText = typeof rawContent === "string";
    return {
        isText,
        text: isText ? rawContent : extractMessageText(rawContent, msgType),
        type: isText ? "text" : msgType || "attachment",
    };
}

/**
 * Extract reply/quote info from a zca-js message (who/what this message replies to).
 * Note: for replies to media (image/sticker/file), `text` may be a serialized non-text
 * payload rather than plain text, mirroring how Zalo stores the quoted content.
 * @param {object} msg - Raw zca-js message event
 * @returns {{ senderId: string|null, senderName: string|null, text: string|null, msgId: string|null } | null}
 */
export function extractReplyTo(msg) {
    const q = msg.data?.quote;
    if (!q) return null;
    return {
        senderId: q.ownerId ?? null,
        senderName: q.fromD ?? null,
        text: q.msg ?? null,
        msgId: q.globalMsgId !== null && q.globalMsgId !== undefined ? String(q.globalMsgId) : null,
    };
}

/**
 * Extract mentioned user IDs from a group message.
 * @param {object} msg - Raw zca-js message event
 * @returns {string[]|null} Mentioned uids, or null if none
 */
export function extractMentions(msg) {
    return Array.isArray(msg.data?.mentions) && msg.data.mentions.length > 0
        ? msg.data.mentions.map((m) => m.uid)
        : null;
}

/**
 * Parse `rawContent.params` when Zalo sends it as a JSON string or an object.
 * @param {*} rawParams
 * @returns {object|null}
 */
function parseAttachmentParams(rawParams) {
    if (!rawParams) return null;
    if (typeof rawParams === "object" && !Array.isArray(rawParams)) return rawParams;
    if (typeof rawParams === "string" && rawParams.trim().startsWith("{")) {
        try {
            const parsed = JSON.parse(rawParams);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Return the first non-empty trimmed string among candidates, or null.
 * @param  {...*} values
 * @returns {string|null}
 */
function firstNonEmptyString(...values) {
    for (const v of values) {
        if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return null;
}

/**
 * Return the first finite non-negative integer among candidates, or null.
 * @param  {...*} values
 * @returns {number|null}
 */
function firstNonNegativeInt(...values) {
    for (const v of values) {
        if (v === null || v === undefined || v === "" || typeof v === "boolean") continue;
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) return Math.round(n);
    }
    return null;
}

/**
 * Build a normalized attachment metadata object from non-text `msg.data.content` (photo, video, file, link card).
 * Shared by the live buffer and the history, keeping `thumbUrl` strictly separate from `url` so a video thumbnail
 * is never treated as the video URL, and omitting optional fields (`thumbUrl`, `fileName`, `fileSize`, `duration`)
 * when absent.
 * @param {*} rawContent - msg.data.content
 * @param {string} [msgType] - msg.data.msgType
 * @returns {object|null}
 */
export function extractAttachment(rawContent, msgType) {
    if (!rawContent || typeof rawContent !== "object") return null;
    const params = parseAttachmentParams(rawContent.params);
    const url = firstNonEmptyString(
        rawContent.href,
        rawContent.hdUrl,
        rawContent.normalUrl,
        rawContent.url,
        params?.href,
        params?.hdUrl,
        params?.normalUrl,
    );
    const thumbUrl = firstNonEmptyString(rawContent.thumb, rawContent.thumbUrl, params?.thumb, params?.thumbUrl);
    const description = firstNonEmptyString(rawContent.title, rawContent.description);
    const fileName = firstNonEmptyString(rawContent.fileName, rawContent.filename, params?.fileName, params?.filename);
    const fileSize = firstNonNegativeInt(
        rawContent.fileSize,
        rawContent.fsize,
        rawContent.size,
        params?.fileSize,
        params?.fsize,
        params?.size,
    );
    const duration = firstNonNegativeInt(rawContent.duration, params?.duration, params?.du);

    const attachment = {
        type: msgType || null,
        url,
        description,
    };
    if (thumbUrl !== null) attachment.thumbUrl = thumbUrl;
    if (fileName !== null) attachment.fileName = fileName;
    if (fileSize !== null) attachment.fileSize = fileSize;
    if (duration !== null) attachment.duration = duration;
    return attachment;
}

/**
 * Normalize a raw zca-js message event into the live buffer's message shape.
 * @param {object} msg - Raw zca-js message event
 * @param {number} [timestamp] - Receive time in ms (defaults to Date.now())
 * @returns {object} Normalized message
 */
export function normalizeMessage(msg, timestamp = Date.now()) {
    const rawContent = msg.data.content;
    const { isText, text, type } = resolveContent(rawContent, msg.data.msgType);
    return {
        id: msg.data.msgId,
        // Zalo's client-side id of the same message. Reacting to it needs both ids (zalo_add_reaction).
        cliMsgId: msg.data.cliMsgId !== null && msg.data.cliMsgId !== undefined ? String(msg.data.cliMsgId) : null,
        threadId: msg.threadId,
        threadType: threadTypeLabel(msg.type),
        senderId: msg.data.uidFrom || null,
        senderName: msg.data.dName || null,
        // Sent from THIS account (the owner's phone, staff on the same account, or an agent's own reply).
        // Consumers use it to show hand-typed replies and to drop echoes of what they just sent.
        isSelf: msg.isSelf === true,
        text,
        timestamp,
        type,
        attachment: isText ? null : extractAttachment(rawContent, msg.data.msgType),
        replyTo: extractReplyTo(msg),
        // Who was tagged, as in the history: a tag inside a link card has no "@Name" in the text to find.
        mentions: extractMentions(msg),
    };
}

/**
 * Normalize a raw zca-js message into the HistoryStore shape.
 * Unlike normalizeMessage(), this preserves the real Zalo timestamp (msg.data.ts)
 * so historical messages sort chronologically.
 * @param {object} msg - Raw zca-js message event (live or old_messages backfill)
 * @param {number} [fallbackTs] - Timestamp used when msg.data.ts is absent (defaults to Date.now())
 * @returns {object} History message
 */
export function toHistoryMessage(msg, fallbackTs = Date.now()) {
    const rawContent = msg.data?.content;
    const { isText, text, type } = resolveContent(rawContent, msg.data?.msgType);
    return {
        msgId: msg.data?.msgId,
        cliMsgId: msg.data?.cliMsgId !== null && msg.data?.cliMsgId !== undefined ? String(msg.data.cliMsgId) : null,
        threadId: msg.threadId,
        threadType: threadTypeLabel(msg.type),
        senderId: msg.data?.uidFrom || null,
        senderName: msg.data?.dName || null,
        isSelf: msg.isSelf === true,
        text,
        timestamp: msg.data?.ts !== null && msg.data?.ts !== undefined ? Number(msg.data.ts) : fallbackTs,
        type,
        attachment: isText ? null : extractAttachment(rawContent, msg.data?.msgType),
        replyTo: extractReplyTo(msg),
        mentions: extractMentions(msg),
    };
}
