/**
 * Sync state of the live connection: since when this account's messages are covered, and the
 * periods when they may not be.
 *
 * Every read tool (zalo_get_messages, zalo_get_history, zalo_search_history) serves messages this
 * server captured itself: live over the WebSocket, plus Zalo's old-message replay right after each
 * connect. Nothing asks Zalo again at read time (there is no such API for DMs). So "no message" can
 * mean two different things: the contact really did not write, or the message arrived while the
 * listener was down (a restart, an update, a dropped connection, another Zalo Web session holding
 * the push) and the replay did not bring it back. A caller deciding "has the customer approved?"
 * must be able to tell them apart (Javis report, 16/10/2026: an "OK" that never reached any of the
 * three tools).
 *
 * This log records:
 *   - trackingSince: when coverage began (the first connect ever, lowered to the oldest message the
 *     first replay brought back when that replay ran to its end).
 *   - gaps: periods with no live connection, including the time the process itself was down
 *     (measured from the last heartbeat written to disk). A gap is "recovered" when the replay that
 *     followed reached back past its start for both DMs and groups, or ran out of older messages.
 *
 * It is kept on disk (one small JSON file in the session folder) so a restart counts as a gap
 * instead of silently starting a fresh, seemingly complete history.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Disconnections shorter than this are not worth a gap entry (the next replay covers them). */
export const MIN_GAP_MS = 5000;

/** Heartbeat period while connected; the process-down gap starts at the last heartbeat. */
export const HEARTBEAT_MS = 60 * 1000;

/** How many gaps to keep (oldest dropped). */
const MAX_GAPS = 100;

/** How many gaps a status report lists. */
const MAX_REPORTED_GAPS = 5;

/**
 * Did one replay run cover a gap that started at `from`?
 * @param {{oldestTs: number|null, exhausted: boolean}|null} run - one thread type's replay result
 * @param {number} from - gap start (ms)
 * @returns {boolean}
 */
function runCovers(run, from) {
    if (!run) return false;
    if (run.exhausted) return true; // Zalo had nothing older to replay
    return run.oldestTs !== null && run.oldestTs !== undefined && run.oldestTs <= from;
}

export class SyncLog {
    /**
     * @param {string|null} filePath - JSON file; null keeps the state in memory only (tests)
     * @param {object} [opts]
     * @param {() => number} [opts.now] - clock, for tests
     */
    constructor(filePath, { now = () => Date.now() } = {}) {
        this.filePath = filePath;
        this._now = now;
        this.state = { trackingSince: null, lastAliveAt: null, gaps: [] };
        this.connectedAt = null;
        this.disconnectedAt = null; // in this process; null before the first connect
        this._lastSave = 0;
        this._load();
    }

    _load() {
        if (!this.filePath || !existsSync(this.filePath)) return;
        try {
            const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
            if (raw && typeof raw === "object") {
                this.state.trackingSince = Number.isFinite(raw.trackingSince) ? raw.trackingSince : null;
                this.state.lastAliveAt = Number.isFinite(raw.lastAliveAt) ? raw.lastAliveAt : null;
                this.state.gaps = Array.isArray(raw.gaps) ? raw.gaps.filter((g) => g && Number.isFinite(g.from)) : [];
            }
        } catch (e) {
            console.error(`[sync-log] Could not read ${this.filePath}: ${e.message}`);
        }
    }

    _save() {
        this._lastSave = this._now();
        if (!this.filePath) return;
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            // Write then rename: a crash mid-write must not leave a torn file that hides every gap.
            const tmp = `${this.filePath}.tmp`;
            writeFileSync(tmp, JSON.stringify(this.state));
            renameSync(tmp, this.filePath);
        } catch (e) {
            console.error(`[sync-log] Could not write ${this.filePath}: ${e.message}`);
        }
    }

    /** Live connection is up. Records the gap since the last time this account was connected. */
    onConnected() {
        const t = this._now();
        if (this.connectedAt !== null) return; // already connected (duplicate event)
        // In this process: since the last disconnect. First connect of a process: since the last
        // heartbeat the previous process wrote (the time it was down, restart or update included).
        const from = this.disconnectedAt !== null ? this.disconnectedAt : this.state.lastAliveAt;
        if (from !== null && t - from >= MIN_GAP_MS) {
            this.state.gaps.push({ from, to: t, recovered: false });
            if (this.state.gaps.length > MAX_GAPS) this.state.gaps = this.state.gaps.slice(-MAX_GAPS);
        }
        if (this.state.trackingSince === null) this.state.trackingSince = t;
        this.connectedAt = t;
        this.disconnectedAt = null;
        this.state.lastAliveAt = t;
        this._save();
    }

    /** Live connection dropped (or closed). */
    onDisconnected() {
        if (this.connectedAt === null) return;
        const t = this._now();
        this.connectedAt = null;
        this.disconnectedAt = t;
        this.state.lastAliveAt = t;
        this._save();
    }

    /** Called periodically while connected, so a hard kill loses at most one period. */
    heartbeat() {
        if (this.connectedAt === null) return;
        this.state.lastAliveAt = this._now();
        this._save();
    }

    /**
     * The gap that ended at the current connect, if any (the one the replay should cover).
     * @returns {{from: number, to: number, recovered: boolean}|null}
     */
    currentGap() {
        if (this.connectedAt === null) return null;
        const last = this.state.gaps[this.state.gaps.length - 1];
        return last && last.to === this.connectedAt ? last : null;
    }

    /**
     * Record what the replay after the current connect brought back.
     * @param {{dm: {oldestTs: number|null, exhausted: boolean}|null,
     *          group: {oldestTs: number|null, exhausted: boolean}|null}} result
     */
    onBackfill(result) {
        const dm = result?.dm || null;
        const group = result?.group || null;
        const gap = this.currentGap();
        if (gap && runCovers(dm, gap.from) && runCovers(group, gap.from)) gap.recovered = true;
        // First connect ever: coverage reaches back as far as the replay that ran to its end.
        if (this.state.trackingSince !== null && this.state.trackingSince === this.connectedAt) {
            const olds = [dm, group]
                .filter((r) => r && r.exhausted && Number.isFinite(r.oldestTs))
                .map((r) => r.oldestTs);
            if (olds.length === 2) this.state.trackingSince = Math.min(this.state.trackingSince, ...olds);
        }
        this._save();
    }

    /**
     * Coverage report for one read, for a time window [from, to] (ms; null = open).
     * `complete: true` means: the listener was connected for the whole window, or every outage in
     * it was recovered by a replay. `false` means a message in the window may be missing here even
     * though it exists in Zalo: say so instead of concluding "no reply".
     * @param {number|null} [from]
     * @param {number|null} [to]
     * @returns {{connected: boolean, connectedSince: number|null, trackingSince: number|null,
     *            complete: boolean, gaps: Array<{from: number, to: number|null}>, note?: string}}
     */
    status(from = null, to = null) {
        const now = this._now();
        const lo = from === null || from === undefined ? (this.state.trackingSince ?? now) : from;
        const hi = to === null || to === undefined ? now : to;
        const open = [];
        for (const g of this.state.gaps) {
            if (g.recovered) continue;
            if (g.to > lo && g.from <= hi) open.push({ from: g.from, to: g.to });
        }
        // Currently down: everything since the drop (or since the last heartbeat) is uncertain.
        if (this.connectedAt === null) {
            const since = this.disconnectedAt ?? this.state.lastAliveAt;
            if (since === null || since <= hi) open.push({ from: since ?? lo, to: null });
        }
        const beforeTracking = this.state.trackingSince === null || lo < this.state.trackingSince;
        const complete = open.length === 0 && !beforeTracking;
        const out = {
            connected: this.connectedAt !== null,
            connectedSince: this.connectedAt,
            trackingSince: this.state.trackingSince,
            complete,
            gaps: open.slice(-MAX_REPORTED_GAPS),
        };
        if (!complete) {
            // An outage is the actionable case, so it wins over "before recording began".
            out.note = open.length
                ? "The connection was down during part of this period and Zalo's replay did not cover it; " +
                  "a message from then may be missing here. Do not conclude there was no reply."
                : "Part of this period is before this account was being recorded; older messages may be missing here.";
        }
        return out;
    }

    /** Whether the state is due a heartbeat write (cheap check for a timer). */
    dueHeartbeat() {
        return this.connectedAt !== null && this._now() - this._lastSave >= HEARTBEAT_MS;
    }
}
