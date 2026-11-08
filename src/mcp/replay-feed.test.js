import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guardHandler, listenerErrorLogger, replayFeedFrom, REPLAY_SLACK_MS } from "./replay-feed.js";

describe("replayFeedFrom", () => {
    it("first connect of a process without a recorded gap feeds nothing", () => {
        assert.equal(replayFeedFrom({}), null);
        assert.equal(replayFeedFrom({ gapFrom: null, lastDropAt: null }), null);
    });

    it("a recorded gap is fed from its start, as before", () => {
        assert.equal(replayFeedFrom({ gapFrom: 1_000_000 }), 1_000_000);
    });

    it("a SHORT drop (no gap recorded) is fed too, from a little before the drop", () => {
        // The 08/11/2026 case: zca-js reconnected within seconds, the sync log recorded nothing, and the replay
        // only reached the history.
        const drop = 10_000_000;
        assert.equal(replayFeedFrom({ gapFrom: null, lastDropAt: drop }), drop - REPLAY_SLACK_MS);
    });

    it("with both, the earlier start wins", () => {
        assert.equal(replayFeedFrom({ gapFrom: 5_000_000, lastDropAt: 10_000_000 }), 5_000_000);
        assert.equal(replayFeedFrom({ gapFrom: 9_999_000, lastDropAt: 10_000_000 }), 10_000_000 - REPLAY_SLACK_MS);
    });

    it("honours a custom slack", () => {
        assert.equal(replayFeedFrom({ lastDropAt: 1000, slackMs: 100 }), 900);
    });
});

describe("guardHandler", () => {
    it("passes arguments through and returns the handler's value", () => {
        const g = guardHandler(
            "message",
            (a, b) => a + b,
            () => {},
        );
        assert.equal(g(2, 3), 5);
    });

    it("an exception stays with its event: the loop that emits the next message keeps going", () => {
        const lines = [];
        const seen = [];
        const handler = guardHandler(
            "message",
            (msg) => {
                if (msg.data.msgId === "2") throw new Error("bad content");
                seen.push(msg.data.msgId);
            },
            (l) => lines.push(l),
        );
        // Like zca-js: one frame, several messages, emitted in a loop inside a try/catch.
        let aborted = false;
        try {
            for (const id of ["1", "2", "3"]) handler({ data: { msgId: id } });
        } catch {
            aborted = true;
        }
        assert.equal(aborted, false);
        assert.deepEqual(seen, ["1", "3"]);
        assert.equal(lines.length, 1);
        assert.match(lines[0], /msgId 2/);
        assert.match(lines[0], /bad content/);
    });
});

describe("listenerErrorLogger", () => {
    it("logs the first error at once, then folds the rest of the interval into one line", () => {
        const lines = [];
        let t = 0;
        const log = listenerErrorLogger(
            60_000,
            (l) => lines.push(l),
            () => t,
        );
        log(new Error("decode failed"));
        t = 1000;
        log(new Error("decode failed"));
        log(new Error("decode failed"));
        assert.equal(lines.length, 1);
        t = 61_000;
        log({ type: "error" });
        assert.equal(lines.length, 2);
        assert.match(lines[0], /decode failed/);
        assert.match(lines[1], /\+2 more/);
    });
});
