/**
 * Per-thread historical message store for the MCP server.
 *
 * Unlike MessageBuffer (a short-lived ring buffer for incremental agent reads),
 * this store accumulates message *history*: it is seeded at WebSocket (re)connect
 * from Zalo's old-message backfill (cmd 510/511) and grows as live messages arrive.
 *
 * Messages are kept sorted oldest→newest, deduped by msgId, and capped per thread.
 * Timestamps are the real Zalo `ts` (not receive time), so pagination is chronological.
 * Since 1.5.0 it is also kept on disk (JSONL in the session folder) so a restart does not wipe it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Days of history kept on disk (Zalo's own replay reaches about two weeks back). */
export const DEFAULT_KEEP_DAYS = 30;

export class HistoryStore {
    /**
     * @param {number} maxPerThread - Max messages retained per thread (oldest evicted first)
     * @param {object} [opts]
     * @param {string|null} [opts.filePath] - JSONL file to keep history across restarts (1.5.0). Without it the
     *   store lived in memory only, so every restart of the MCP server (a Javis update, a crash) wiped it and only
     *   Zalo's short replay came back: a reply that arrived before the restart and fell outside the replay was gone
     *   from every read tool. null keeps the old in-memory behaviour (tests).
     * @param {number} [opts.keepDays] - Drop messages older than this when loading or compacting
     * @param {() => number} [opts.now] - clock, for tests
     */
    constructor(maxPerThread = 2000, { filePath = null, keepDays = DEFAULT_KEEP_DAYS, now = () => Date.now() } = {}) {
        /** @type {Map<string, Array>} threadId → messages sorted ascending by timestamp */
        this._threads = new Map();
        this._maxPerThread = maxPerThread;
        this._filePath = filePath;
        this._keepMs = Math.max(1, keepDays) * 86400000;
        this._now = now;
        this._lines = 0; // lines in the file, for compaction
        this._persist = false;
        this._load();
        this._persist = !!filePath;
    }

    /** Read the JSONL file back into memory (newest per thread, within keepDays). */
    _load() {
        if (!this._filePath || !existsSync(this._filePath)) return;
        const cutoff = this._now() - this._keepMs;
        const byThread = new Map();
        try {
            for (const line of readFileSync(this._filePath, "utf8").split("\n")) {
                if (!line.trim()) continue;
                this._lines++;
                try {
                    const m = JSON.parse(line);
                    if (!m || !m.threadId || m.msgId === null || m.msgId === undefined) continue;
                    if ((m.timestamp || 0) < cutoff) continue;
                    if (!byThread.has(m.threadId)) byThread.set(m.threadId, []);
                    byThread.get(m.threadId).push(m);
                } catch {
                    // A torn last line (killed mid-write) is skipped, the rest still loads
                }
            }
        } catch (e) {
            console.error(`[history-store] Could not read ${this._filePath}: ${e.message}`);
            return;
        }
        for (const [tid, msgs] of byThread) this.ingest(tid, msgs);
    }

    /** Append newly stored messages; rewrite the file when it has grown well past what is kept. */
    _append(messages) {
        if (!this._persist || messages.length === 0) return;
        try {
            mkdirSync(dirname(this._filePath), { recursive: true });
            appendFileSync(this._filePath, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
            this._lines += messages.length;
            if (this._lines > Math.max(10000, this.size() * 2)) this.compact();
        } catch (e) {
            console.error(`[history-store] Could not write ${this._filePath}: ${e.message}`);
        }
    }

    /** Rewrite the file with exactly what is kept now (drops duplicates, evicted and expired lines). */
    compact() {
        if (!this._filePath) return;
        const cutoff = this._now() - this._keepMs;
        const lines = [];
        for (const [tid, list] of this._threads) {
            const kept = list.filter((m) => (m.timestamp || 0) >= cutoff);
            if (kept.length !== list.length) {
                if (kept.length) this._threads.set(tid, kept);
                else this._threads.delete(tid);
            }
            for (const m of kept) lines.push(JSON.stringify(m));
        }
        try {
            mkdirSync(dirname(this._filePath), { recursive: true });
            const tmp = `${this._filePath}.tmp`;
            writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "");
            renameSync(tmp, this._filePath);
            this._lines = lines.length;
        } catch (e) {
            console.error(`[history-store] Could not compact ${this._filePath}: ${e.message}`);
        }
    }

    /**
     * Merge messages into a thread's history. Deduped by msgId, re-sorted by timestamp,
     * trimmed to maxPerThread (keeping the newest).
     * @param {string} threadId
     * @param {Array<{msgId: string|number, timestamp?: number}>} messages - Normalized history messages
     * @returns {number} Count of newly added (non-duplicate) messages
     */
    ingest(threadId, messages) {
        if (!threadId || !Array.isArray(messages) || messages.length === 0) return 0;

        let list = this._threads.get(threadId);
        if (!list) {
            list = [];
            this._threads.set(threadId, list);
        }

        const seen = new Set(list.map((m) => String(m.msgId)));
        const fresh = [];
        for (const m of messages) {
            if (!m || m.msgId === null || m.msgId === undefined) continue;
            const id = String(m.msgId);
            if (seen.has(id)) continue;
            seen.add(id);
            list.push(m);
            fresh.push(m);
        }
        const added = fresh.length;

        if (added > 0) {
            list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            if (list.length > this._maxPerThread) {
                this._threads.set(threadId, list.slice(list.length - this._maxPerThread));
            }
            this._append(fresh);
        }
        return added;
    }

    /**
     * Read a page of history for a thread, newest messages first-filled but returned
     * oldest→newest. Paginates *backward* in time via the `before` cursor.
     * @param {string} threadId
     * @param {object} [opts]
     * @param {number} [opts.limit=50] - Max messages to return
     * @param {string|null} [opts.before=null] - Return messages strictly older than this msgId
     * @returns {{ messages: Array, cursor: string|null, hasMore: boolean }}
     *          cursor = oldest msgId in this page (feed back as `before` to page further back)
     */
    read(threadId, { limit = 50, before = null } = {}) {
        return this.query({ threadId, limit, before });
    }

    /**
     * Query history with optional filters, returned oldest→newest and paginated *backward*
     * via the `before` cursor. Omit `threadId` to search across all threads.
     * @param {object} [opts]
     * @param {string|null} [opts.threadId=null] - Restrict to one thread; null = all threads
     * @param {string|null} [opts.senderId=null] - Only messages from this sender uid
     * @param {number|null} [opts.since=null] - Only messages with timestamp >= this (epoch ms)
     * @param {number|null} [opts.until=null] - Only messages with timestamp <= this (epoch ms)
     * @param {number} [opts.limit=50] - Max messages to return
     * @param {string|null} [opts.before=null] - Return messages strictly older than this msgId
     * @returns {{ messages: Array, cursor: string|null, hasMore: boolean }}
     *          cursor = oldest msgId in this page (feed back as `before` to page further back)
     */
    query({ threadId = null, senderId = null, since = null, until = null, limit = 50, before = null } = {}) {
        const lists =
            threadId !== null && threadId !== undefined
                ? [this._threads.get(threadId) || []]
                : Array.from(this._threads.values());

        const all = [];
        for (const list of lists) {
            for (const m of list) {
                if (senderId !== null && senderId !== undefined && String(m.senderId) !== String(senderId)) continue;
                if (since !== null && since !== undefined && m.timestamp < since) continue;
                if (until !== null && until !== undefined && m.timestamp > until) continue;
                all.push(m);
            }
        }

        // Deterministic chronological order across threads. Equal-timestamp ties break by
        // lexicographic msgId — intentional (keep it stable; don't switch to numeric compare,
        // which would break non-numeric ids). Ordering of same-millisecond messages is cosmetic.
        all.sort((a, b) => a.timestamp - b.timestamp || String(a.msgId).localeCompare(String(b.msgId)));

        let scoped = all;
        if (before !== null && before !== undefined) {
            // Assumes msgId is globally unique (Zalo assigns global snowflake ids, also surfaced
            // as quote.globalMsgId), so this anchors correctly even in a merged cross-thread list.
            const idx = all.findIndex((m) => String(m.msgId) === String(before));
            // Cursor found → messages strictly older than it. Cursor absent → it (and everything
            // older) was evicted by the per-thread cap, so there's nothing older to return.
            scoped = idx >= 0 ? all.slice(0, idx) : [];
        }

        const page = scoped.slice(Math.max(0, scoped.length - limit));
        const cursor = page.length > 0 ? String(page[0].msgId) : null;
        const hasMore = scoped.length > page.length;

        // Return shallow copies so callers (e.g. threadName enrichment) can't mutate the store.
        return { messages: page.map((m) => ({ ...m })), cursor, hasMore };
    }

    /**
     * The stored message with this msgId in a thread, or null (zalo_add_reaction looks up its cliMsgId here).
     * @param {string} threadId
     * @param {string|number} msgId
     * @returns {object|null}
     */
    find(threadId, msgId) {
        const list = this._threads.get(threadId);
        if (!list || msgId === null || msgId === undefined) return null;
        const key = String(msgId);
        return list.find((m) => String(m.msgId) === key) || null;
    }

    /** Number of messages stored for a thread. */
    count(threadId) {
        return (this._threads.get(threadId) || []).length;
    }

    /** Total messages across all threads. */
    size() {
        let total = 0;
        for (const list of this._threads.values()) total += list.length;
        return total;
    }

    /** Thread IDs that currently have history. */
    threadIds() {
        return Array.from(this._threads.keys());
    }
}

/**
 * Parse a since/until boundary into epoch milliseconds.
 * Accepts a number (ms), an all-digit string (ms), a date-only "YYYY-MM-DD" (local start of
 * day, or end of day when isEnd), or any Date-parseable string (e.g. ISO datetime).
 * Numeric input is taken as-is (epoch ms) — it is NOT range-validated, so a Unix-seconds value
 * resolves to ~1970 (yielding empty results), and negative/fractional ms pass through unchanged.
 * @param {string|number|null|undefined} value
 * @param {boolean} [isEnd=false] - For a date-only value, resolve to end-of-day (inclusive)
 * @returns {number|null} Milliseconds, or null if empty/unparseable
 */
export function parseTimeBoundary(value, isEnd = false) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const str = String(value).trim();
    if (/^\d+$/.test(str)) return Number(str); // epoch milliseconds
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(str);
    const ms = new Date(dateOnly ? `${str}T00:00:00` : str).getTime();
    if (Number.isNaN(ms)) return null;
    return dateOnly && isEnd ? ms + 86400000 - 1 : ms; // inclusive end of the day
}
