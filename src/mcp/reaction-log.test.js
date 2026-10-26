import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReactionLog, reactionRecords } from "./reaction-log.js";

function reaction({ actionId = "a1", msgId = "m1", uid = "u1", icon = "/-heart", ts = 1000, content } = {}) {
    return {
        threadId: "g1",
        isGroup: true,
        data: {
            actionId,
            uidFrom: uid,
            dName: "Diem",
            ts: String(ts),
            content: content ?? JSON.stringify({ rIcon: icon, rMsg: [{ gMsgID: msgId, cMsgID: "c1" }] }),
        },
    };
}

test("reactionRecords maps a zca-js reaction to one record per target message", () => {
    const [rec] = reactionRecords(reaction());
    assert.deepEqual(rec, {
        threadId: "g1",
        threadType: "group",
        msgId: "m1",
        cliMsgId: "c1",
        userId: "u1",
        userName: "Diem",
        icon: "/-heart",
        ts: 1000,
        actionId: "a1",
    });
});

test("reactionRecords drops malformed content and empty targets", () => {
    assert.deepEqual(reactionRecords(null), []);
    assert.deepEqual(reactionRecords(reaction({ content: "not json" })), []);
    assert.deepEqual(reactionRecords(reaction({ msgId: "0" })), []);
});

test("ReactionLog keeps the latest state, skips replays and survives a restart", () => {
    const file = join(mkdtempSync(join(tmpdir(), "rl-")), "reactions.jsonl");
    const log = new ReactionLog(file);
    assert.equal(log.add(reactionRecords(reaction())), 1);
    assert.equal(log.add(reactionRecords(reaction())), 0, "a replayed action is not written twice");
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);

    const again = new ReactionLog(file);
    assert.deepEqual(again.query({ threadId: "g1" }), [
        { msgId: "m1", reactions: [{ userId: "u1", userName: "Diem", icon: "/-heart", ts: 1000 }] },
    ]);

    again.add(reactionRecords(reaction({ actionId: "a2", icon: "", ts: 2000 })));
    assert.deepEqual(again.query({ threadId: "g1" }), [], "an empty icon removes the reaction");
});

test("ReactionLog.query filters by thread, msgIds and since", () => {
    const log = new ReactionLog(join(mkdtempSync(join(tmpdir(), "rl-")), "reactions.jsonl"));
    log.add(reactionRecords(reaction({ actionId: "a1", msgId: "m1", ts: 1000 })));
    log.add(reactionRecords(reaction({ actionId: "a2", msgId: "m2", ts: 3000 })));
    assert.deepEqual(log.query({ threadId: "other" }), []);
    assert.deepEqual(
        log.query({ threadId: "g1", msgIds: ["m2"] }).map((m) => m.msgId),
        ["m2"],
    );
    assert.deepEqual(
        log.query({ threadId: "g1", since: 2000 }).map((m) => m.msgId),
        ["m2"],
    );
});
