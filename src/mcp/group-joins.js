/**
 * Group join tracking: who joined which group, and when.
 *
 * Zalo pushes a "join" group event over the live WebSocket the moment someone joins (by link,
 * approval, or being added). The member list API carries no join time, so this event is the
 * only source of join times. It is only seen while the listener is connected, so every join
 * is appended to a small JSONL log under the session folder and survives restarts.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** zca-js GroupEventType.JOIN */
const JOIN = "join";

/** Buffer message type for a join, read by agents next to ordinary messages. */
export const JOIN_MESSAGE_TYPE = "group.join";

/**
 * Turn one zca-js group event into join records (one per member). Anything but a join gives [].
 * The account's own join (it was added to a group) is skipped: that is not a newcomer.
 * @param {object} event - zca-js group_event ({ type, threadId, data, isSelf })
 * @param {string|null} ownId - uid of the signed-in account
 * @param {number} [now] - fallback timestamp in ms
 * @returns {Array<{groupId: string, groupName: string|null, userId: string, userName: string|null,
 *   addedBy: string|null, addedByMe: boolean, time: number}>}
 */
export function joinRecordsFromEvent(event, ownId, now = Date.now()) {
    if (!event || event.type !== JOIN) return [];
    const data = event.data || {};
    const groupId = String(event.threadId || data.groupId || data.group_id || "");
    if (!groupId) return [];
    const self = ownId ? String(ownId) : "";
    const t = Number(data.time);
    const time = Number.isFinite(t) && t > 0 ? t : now;
    const actor = data.sourceId ? String(data.sourceId) : null;
    const members = Array.isArray(data.updateMembers) ? data.updateMembers : [];
    const out = [];
    for (const m of members) {
        const userId = String((m && (m.id ?? m.uid)) || m || "").trim();
        if (!userId || userId === self) continue;
        out.push({
            groupId,
            groupName: data.groupName ? String(data.groupName) : null,
            userId,
            userName: m && m.dName ? String(m.dName) : null,
            // Who added them. Equal to the member when they joined by themselves (link/approval).
            addedBy: actor && actor !== userId ? actor : null,
            addedByMe: !!self && actor === self,
            time,
        });
    }
    return out;
}

/**
 * The live-buffer message for one join, so a poller of zalo_get_messages sees it in order with
 * the chat. The newcomer is the sender, so a reply that tags the sender tags the newcomer.
 * @param {ReturnType<typeof joinRecordsFromEvent>[number]} rec
 * @returns {object}
 */
export function joinToBufferMessage(rec) {
    const who = rec.userName || rec.userId;
    return {
        id: `join:${rec.groupId}:${rec.userId}:${rec.time}`,
        threadId: rec.groupId,
        threadType: "group",
        senderId: rec.userId,
        senderName: rec.userName,
        text: `[${who} joined the group]`,
        timestamp: rec.time,
        type: JOIN_MESSAGE_TYPE,
        attachment: null,
        replyTo: null,
        event: {
            kind: "join",
            groupName: rec.groupName,
            addedBy: rec.addedBy,
            addedByMe: rec.addedByMe,
            time: rec.time,
        },
    };
}

/** Append-only JSONL log of joins, capped at `maxEntries` (oldest dropped on compaction). */
export class GroupJoinLog {
    /**
     * @param {string|null} filePath - JSONL path; null keeps the log in memory only
     * @param {number} [maxEntries]
     */
    constructor(filePath, maxEntries = 5000) {
        this.filePath = filePath;
        this.maxEntries = maxEntries;
        this.entries = [];
        this._load();
    }

    _load() {
        if (!this.filePath || !existsSync(this.filePath)) return;
        try {
            for (const line of readFileSync(this.filePath, "utf8").split("\n")) {
                if (!line.trim()) continue;
                try {
                    const rec = JSON.parse(line);
                    if (rec && rec.groupId && rec.userId) this.entries.push(rec);
                } catch {
                    // A torn last line (crash mid-write) is skipped, the rest still loads
                }
            }
        } catch (e) {
            console.error(`[group-joins] Could not read ${this.filePath}: ${e.message}`);
        }
        if (this.entries.length > this.maxEntries) this._compact();
    }

    _key(rec) {
        return `${rec.groupId}:${rec.userId}:${rec.time}`;
    }

    /**
     * Record joins. Duplicates (same group, member and time) are ignored.
     * @param {Array} records
     * @returns {number} how many were new
     */
    add(records) {
        const seen = new Set(this.entries.slice(-500).map((r) => this._key(r)));
        const fresh = (records || []).filter((r) => r && r.groupId && r.userId && !seen.has(this._key(r)));
        if (!fresh.length) return 0;
        this.entries.push(...fresh);
        if (this.filePath) {
            try {
                mkdirSync(dirname(this.filePath), { recursive: true });
                appendFileSync(this.filePath, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
            } catch (e) {
                console.error(`[group-joins] Could not write ${this.filePath}: ${e.message}`);
            }
        }
        if (this.entries.length > Math.ceil(this.maxEntries * 1.2)) this._compact();
        return fresh.length;
    }

    _compact() {
        this.entries = this.entries.slice(-this.maxEntries);
        if (!this.filePath) return;
        try {
            writeFileSync(this.filePath, this.entries.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
        } catch (e) {
            console.error(`[group-joins] Could not compact ${this.filePath}: ${e.message}`);
        }
    }

    /**
     * Joins matching the filters, oldest to newest, keeping the most recent `limit`.
     * @param {object} [q]
     * @param {string|null} [q.threadId]
     * @param {string|null} [q.userId]
     * @param {number|null} [q.since] - ms, inclusive
     * @param {number|null} [q.until] - ms, inclusive
     * @param {number} [q.limit]
     * @returns {{ joins: Array, total: number }}
     */
    query({ threadId = null, userId = null, since = null, until = null, limit = 50 } = {}) {
        const hit = this.entries
            .filter(
                (r) =>
                    (!threadId || r.groupId === String(threadId)) &&
                    (!userId || r.userId === String(userId)) &&
                    (since === null || r.time >= since) &&
                    (until === null || r.time <= until),
            )
            .sort((a, b) => a.time - b.time);
        return { joins: hit.slice(-Math.max(1, limit)), total: hit.length };
    }
}
