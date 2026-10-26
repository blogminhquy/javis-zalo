/**
 * Reaction log: who reacted to which message, with which icon.
 *
 * Zalo pushes reactions over the live WebSocket (cmd 612) and replays recent ones during the sync window
 * right after a connect (cmd 610 DM / 611 group, via requestOldReactions). History messages carry no
 * reaction, so every reaction is appended to a JSONL log under the session folder and survives restarts.
 * The current state of one (reactor, message) pair is its latest record; an empty icon means removed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const present = (v) => v !== null && v !== undefined;

/**
 * Turn one zca-js Reaction into log records, one per target message.
 * @param {object} r - zca-js Reaction ({ data, threadId, isGroup, isSelf })
 * @returns {Array<{threadId: string, threadType: string, msgId: string, cliMsgId: string|null,
 *   userId: string, userName: string|null, icon: string, ts: number, actionId: string|null}>}
 */
export function reactionRecords(r) {
    if (!r || !r.data) return [];
    const d = r.data;
    let content = d.content;
    if (typeof content === "string") {
        try {
            content = JSON.parse(content);
        } catch {
            return [];
        }
    }
    if (!content || typeof content !== "object") return [];
    const targets = Array.isArray(content.rMsg) ? content.rMsg : [];
    const ts = Number(d.ts) || Date.now();
    const out = [];
    for (const t of targets) {
        const msgId = t && present(t.gMsgID) ? String(t.gMsgID) : "";
        if (!msgId || msgId === "0") continue;
        out.push({
            threadId: String(r.threadId || d.idTo || ""),
            threadType: r.isGroup ? "group" : "dm",
            msgId,
            cliMsgId: present(t.cMsgID) ? String(t.cMsgID) : null,
            userId: String(d.uidFrom || ""),
            userName: d.dName ? String(d.dName) : null,
            icon: String(content.rIcon ?? ""),
            ts,
            actionId: present(d.actionId) ? String(d.actionId) : null,
        });
    }
    return out;
}

export class ReactionLog {
    /** @param {string} filePath */
    constructor(filePath) {
        this.filePath = filePath;
        this.seen = new Set(); // actionId|msgId|userId, so a replay does not append twice
        /** @type {Map<string, Map<string, object>>} msgId -> userId -> latest record */
        this.byMsg = new Map();
        if (existsSync(filePath)) {
            for (const line of readFileSync(filePath, "utf8").split("\n")) {
                if (!line.trim()) continue;
                try {
                    this.apply(JSON.parse(line));
                } catch {
                    // skip a torn line
                }
            }
        }
    }

    key(rec) {
        return `${rec.actionId || rec.ts}|${rec.msgId}|${rec.userId}`;
    }

    apply(rec) {
        this.seen.add(this.key(rec));
        if (!this.byMsg.has(rec.msgId)) this.byMsg.set(rec.msgId, new Map());
        const m = this.byMsg.get(rec.msgId);
        const prev = m.get(rec.userId);
        if (!prev || rec.ts >= prev.ts) m.set(rec.userId, rec);
    }

    /** @returns {number} records newly written */
    add(records) {
        let n = 0;
        for (const rec of records) {
            if (!rec.threadId || !rec.msgId || !rec.userId) continue;
            if (this.seen.has(this.key(rec))) continue;
            this.apply(rec);
            try {
                mkdirSync(dirname(this.filePath), { recursive: true });
                appendFileSync(this.filePath, JSON.stringify(rec) + "\n");
            } catch (e) {
                console.error("[reactions] write failed:", e.message);
            }
            n++;
        }
        return n;
    }

    /**
     * Current reactions per message of a thread (removed ones left out).
     * @param {{threadId: string, msgIds?: string[]|null, since?: number|null}} q
     */
    query({ threadId, msgIds = null, since = null }) {
        const want = msgIds && msgIds.length ? new Set(msgIds.map(String)) : null;
        const out = [];
        for (const [msgId, users] of this.byMsg) {
            if (want && !want.has(msgId)) continue;
            const live = [...users.values()].filter(
                (r) => r.threadId === String(threadId) && r.icon && (!present(since) || r.ts >= since),
            );
            if (!live.length) continue;
            out.push({
                msgId,
                reactions: live.map((r) => ({ userId: r.userId, userName: r.userName, icon: r.icon, ts: r.ts })),
            });
        }
        return out;
    }
}
