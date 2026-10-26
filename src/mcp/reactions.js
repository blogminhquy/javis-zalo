/**
 * Emoji reactions (1.7.0): read the ones contacts put on messages, and put one on a message.
 *
 * Zalo sends a reaction as its own event (zca-js `reaction`), not as a message. Before 1.7.0 the MCP server did not
 * listen to it, so a consumer (Javis' inbox and its bots) never knew a customer had hearted a price quote.
 * `normalizeReaction` turns the event into a live-buffer entry with `type: "reaction"`, pointing at the message it
 * was put on. To react, Zalo needs both ids of the target message (`msgId` and `cliMsgId`), so live and history
 * messages now carry `cliMsgId` too (message-normalize.js).
 *
 * Kept free of zca-js imports so the mapping can be unit-tested in isolation.
 */

import { threadTypeLabel } from "./message-normalize.js";

/**
 * The reactions Zalo shows in its picker, by a plain name a model or a person can say, with the code Zalo sends
 * (zca-js `Reactions`) and the emoji it looks like. Codes from zca-js 2.2.0 `models/Reaction`.
 */
export const REACTIONS = {
    heart: { code: "/-heart", emoji: "❤️" },
    like: { code: "/-strong", emoji: "👍" },
    haha: { code: ":>", emoji: "😆" },
    wow: { code: ":o", emoji: "😮" },
    cry: { code: ":-((", emoji: "😭" },
    angry: { code: ":-h", emoji: "😡" },
    kiss: { code: ":-*", emoji: "😘" },
    tears_of_joy: { code: ":')", emoji: "😂" },
    rose: { code: "/-rose", emoji: "🌹" },
    broken_heart: { code: "/-break", emoji: "💔" },
    dislike: { code: "/-weak", emoji: "👎" },
    love: { code: ";xx", emoji: "😍" },
    confused: { code: ";-/", emoji: "😕" },
    wink: { code: ";-)", emoji: "😉" },
    ok: { code: "/-ok", emoji: "👌" },
    peace: { code: "/-v", emoji: "✌️" },
    thanks: { code: "/-thanks", emoji: "🙏" },
    pray: { code: "_()_", emoji: "🙏" },
    handclap: { code: ":handclap", emoji: "👏" },
    sad: { code: "--b", emoji: "😞" },
    big_laugh: { code: ":))", emoji: "😄" },
    cool: { code: "x-)", emoji: "😎" },
};

const BY_CODE = new Map(Object.entries(REACTIONS).map(([name, r]) => [r.code, { name, ...r }]));
const BY_EMOJI = new Map();
for (const [name, r] of Object.entries(REACTIONS)) {
    if (!BY_EMOJI.has(r.emoji)) BY_EMOJI.set(r.emoji, { name, ...r });
}
const REMOVE_WORDS = new Set(["", "none", "remove", "clear", "off"]);

/**
 * What a reaction code means. Unknown codes keep the raw code so nothing is lost.
 * @param {string} code - Zalo reaction code (`rIcon`)
 * @returns {{ name: string|null, code: string, emoji: string|null }}
 */
export function describeReaction(code) {
    const c = String(code ?? "");
    const known = BY_CODE.get(c);
    return known ? { name: known.name, code: c, emoji: known.emoji } : { name: null, code: c, emoji: null };
}

/**
 * Resolve what a caller asked for into a Zalo reaction code. Accepts a plain name ("heart"), the emoji ("❤️" or
 * "❤"), or a raw Zalo code ("/-heart"). "none" / "remove" / "" take the reaction off.
 * @param {string} input
 * @returns {{ code: string, name: string|null, emoji: string|null, remove: boolean } | null} null when unknown
 */
export function resolveReaction(input) {
    const raw = String(input ?? "").trim();
    const low = raw.toLowerCase();
    if (REMOVE_WORDS.has(low)) return { code: "", name: null, emoji: null, remove: true };
    if (REACTIONS[low]) return { code: REACTIONS[low].code, name: low, emoji: REACTIONS[low].emoji, remove: false };
    // The emoji itself, with or without the variation selector (U+FE0F) phones add.
    const bare = raw.replace(/️/g, "");
    for (const [emoji, r] of BY_EMOJI) {
        if (emoji.replace(/️/g, "") === bare) return { code: r.code, name: r.name, emoji: r.emoji, remove: false };
    }
    if (BY_CODE.has(raw)) {
        const r = BY_CODE.get(raw);
        return { code: r.code, name: r.name, emoji: r.emoji, remove: false };
    }
    return null;
}

/**
 * A zca-js `reaction` event -> a live-buffer entry. `null` when the event names no target message.
 *
 * The entry has the usual buffer fields (id, threadId, threadType, sender, isSelf, timestamp) so every consumer of
 * zalo_get_messages can file it, plus:
 *   - `type: "reaction"` and `text: null` (it is not something anyone wrote);
 *   - `reaction`: { name, code, emoji, removed, targetMsgId, targetCliMsgId }. `removed` is true when the contact
 *     took their reaction back (Zalo sends an empty code then).
 * @param {object} reaction - zca-js Reaction { data, threadId, isSelf, isGroup }
 * @param {number} [timestamp] - receive time in ms (defaults to Date.now())
 * @returns {object|null}
 */
export function normalizeReaction(reaction, timestamp = Date.now()) {
    const d = reaction?.data || {};
    const target = Array.isArray(d.content?.rMsg) ? d.content.rMsg[0] : null;
    if (!target || target.gMsgID === null || target.gMsgID === undefined) return null;
    const icon = d.content?.rIcon ?? "";
    const meaning = describeReaction(icon);
    const ts = d.ts !== null && d.ts !== undefined && !Number.isNaN(Number(d.ts)) ? Number(d.ts) : timestamp;
    return {
        id: d.msgId !== null && d.msgId !== undefined ? String(d.msgId) : `r${target.gMsgID}-${d.uidFrom || ""}-${ts}`,
        threadId: reaction.threadId,
        threadType: threadTypeLabel(reaction.isGroup ? 1 : 0),
        senderId: d.uidFrom || null,
        senderName: d.dName || null,
        isSelf: reaction.isSelf === true,
        text: null,
        timestamp: ts,
        type: "reaction",
        attachment: null,
        replyTo: null,
        reaction: {
            ...meaning,
            removed: icon === "",
            targetMsgId: String(target.gMsgID),
            targetCliMsgId: target.cMsgID !== null && target.cMsgID !== undefined ? String(target.cMsgID) : null,
        },
    };
}

/**
 * The client id Zalo needs next to `msgId` to react to a message. Taken from the call when given, else from the live
 * buffer, else from the history store. `null` when none of them knows the message.
 * @param {string} threadId
 * @param {string} msgId
 * @param {{ buffer?: object, historyStore?: object }} stores
 * @returns {string|null}
 */
export function lookupCliMsgId(threadId, msgId, { buffer, historyStore } = {}) {
    const live = buffer?.find?.(threadId, msgId);
    if (live?.cliMsgId) return String(live.cliMsgId);
    const old = historyStore?.find?.(threadId, msgId);
    if (old?.cliMsgId) return String(old.cliMsgId);
    return null;
}

/**
 * Put a reaction on a message (or take this account's reaction off). Backs the `zalo_add_reaction` tool.
 * @param {object} api - zca-js API instance (the live one)
 * @param {{ threadId: string, threadType: number, msgId: string, cliMsgId?: string, reaction: string }} args
 * @param {{ buffer?: object, historyStore?: object }} stores
 * @returns {Promise<object>} what was done
 * @throws {Error} unknown reaction, or a message whose client id nobody knows
 */
export async function reactToMessage(api, { threadId, threadType, msgId, cliMsgId, reaction }, stores = {}) {
    const resolved = resolveReaction(reaction);
    if (!resolved) {
        throw new Error(
            `Unknown reaction "${reaction}". Use one of: ${Object.keys(REACTIONS).join(", ")}, the emoji itself, or "none" to remove.`,
        );
    }
    const cli = cliMsgId ? String(cliMsgId) : lookupCliMsgId(threadId, String(msgId), stores);
    if (!cli) {
        throw new Error(
            `Message ${msgId} is not in the live buffer or history, so its cliMsgId is unknown. Pass cliMsgId (it is on every message from zalo_get_messages / zalo_get_history).`,
        );
    }
    await api.addReaction(resolved.code, {
        data: { msgId: String(msgId), cliMsgId: cli },
        threadId,
        type: Number(threadType),
    });
    return {
        success: true,
        msgId: String(msgId),
        reaction: resolved.remove ? null : resolved.name,
        emoji: resolved.remove ? null : resolved.emoji,
        removed: resolved.remove,
    };
}
