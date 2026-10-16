import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEARTBEAT_MS, MIN_GAP_MS, SyncLog } from "./sync-log.js";

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
    let t = start;
    const now = () => t;
    now.add = (ms) => {
        t += ms;
        return t;
    };
    return now;
}

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "sync-log-")), "sync-state.json");
const covered = (oldestTs) => ({ oldestTs, exhausted: false });
const ranOut = () => ({ oldestTs: null, exhausted: true });

describe("SyncLog", () => {
    it("first connect ever: no gap, complete from then on", () => {
        const now = clock();
        const log = new SyncLog(null, { now });
        log.onConnected();
        const s = log.status(now(), null);
        assert.equal(s.connected, true);
        assert.equal(s.complete, true);
        assert.deepEqual(s.gaps, []);
    });

    it("a window before recording began is not complete", () => {
        const now = clock();
        const log = new SyncLog(null, { now });
        log.onConnected();
        const s = log.status(now() - 60_000, null);
        assert.equal(s.complete, false);
        assert.match(s.note, /before this account was being recorded/);
    });

    it("while disconnected, anything after the drop is not complete", () => {
        const now = clock();
        const log = new SyncLog(null, { now });
        log.onConnected();
        now.add(10_000);
        log.onDisconnected();
        now.add(30_000);
        const s = log.status(null, null);
        assert.equal(s.connected, false);
        assert.equal(s.complete, false);
        assert.equal(s.gaps.at(-1).to, null);
    });

    it("a reconnect records the outage; a replay that reaches past it recovers it", () => {
        const now = clock();
        const log = new SyncLog(null, { now });
        log.onConnected();
        const down = now.add(10_000);
        log.onDisconnected();
        now.add(60_000);
        log.onConnected();
        const gap = log.currentGap();
        assert.equal(gap.from, down);
        assert.equal(log.status(down - 1, null).complete, false);
        log.onBackfill({ dm: covered(down - 5_000), group: ranOut() });
        assert.equal(log.currentGap().recovered, true);
        assert.equal(log.status(down - 1, null).complete, true);
    });

    it("a replay that stops short of the outage (page cap, timeout) leaves it open", () => {
        const now = clock();
        const log = new SyncLog(null, { now });
        log.onConnected();
        const down = now.add(10_000);
        log.onDisconnected();
        now.add(60_000);
        log.onConnected();
        log.onBackfill({ dm: covered(down + 20_000), group: ranOut() }); // DMs only reach part of the outage
        const s = log.status(down - 1, null);
        assert.equal(s.complete, false);
        assert.equal(s.gaps.length, 1);
        assert.match(s.note, /Do not conclude there was no reply/);
        // A window entirely after the outage is still complete.
        assert.equal(log.status(now(), null).complete, true);
    });

    it("short blips are not recorded as gaps", () => {
        const now = clock();
        const log = new SyncLog(null, { now });
        log.onConnected();
        now.add(10_000);
        log.onDisconnected();
        now.add(MIN_GAP_MS - 1);
        log.onConnected();
        assert.equal(log.currentGap(), null);
    });

    it("a restart counts as a gap from the last heartbeat on disk", () => {
        const file = tmpFile();
        const now = clock();
        const a = new SyncLog(file, { now });
        a.onConnected();
        now.add(HEARTBEAT_MS);
        assert.equal(a.dueHeartbeat(), true);
        a.heartbeat();
        const lastBeat = now();
        now.add(5 * 60_000); // process killed, down for five minutes
        const b = new SyncLog(file, { now });
        assert.equal(b.state.trackingSince, a.state.trackingSince);
        b.onConnected();
        assert.equal(b.currentGap().from, lastBeat);
        assert.equal(b.status(lastBeat, null).complete, false);
    });

    it("the first replay ever lowers the start of coverage when it ran to its end", () => {
        const now = clock();
        const log = new SyncLog(null, { now });
        log.onConnected();
        log.onBackfill({
            dm: { oldestTs: now() - 86_400_000, exhausted: true },
            group: { oldestTs: now() - 3_600_000, exhausted: true },
        });
        assert.equal(log.state.trackingSince, now() - 86_400_000);
        assert.equal(log.status(now() - 3_600_000, null).complete, true);
    });

    it("a torn or foreign file is ignored, not fatal", () => {
        const file = tmpFile();
        writeFileSync(file, "{not json");
        const log = new SyncLog(file, { now: clock() });
        assert.equal(log.state.trackingSince, null);
        log.onConnected();
        assert.equal(log.status(null, null).complete, true);
    });
});
