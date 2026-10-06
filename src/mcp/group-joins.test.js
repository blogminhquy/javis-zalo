import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupJoinLog, JOIN_MESSAGE_TYPE, joinRecordsFromEvent, joinToBufferMessage } from "./group-joins.js";

const ME = "100";

/** Shape of a zca-js "join" group_event (initializeGroupEvent output). */
function joinEvent({ members, sourceId = "200", time = "1759700000000", groupId = "G1" } = {}) {
    return {
        type: "join",
        act: "join",
        threadId: groupId,
        isSelf: false,
        data: {
            groupId,
            groupName: "Zoom | Javis OS",
            sourceId,
            time,
            updateMembers: members,
        },
    };
}

describe("joinRecordsFromEvent", () => {
    it("gives one record per newcomer with the real join time", () => {
        const recs = joinRecordsFromEvent(
            joinEvent({
                members: [
                    { id: "200", dName: "Lan" },
                    { id: "300", dName: "Minh" },
                ],
                sourceId: "200",
            }),
            ME,
        );
        assert.equal(recs.length, 2);
        assert.deepEqual(
            recs.map((r) => [r.userId, r.userName, r.time]),
            [
                ["200", "Lan", 1759700000000],
                ["300", "Minh", 1759700000000],
            ],
        );
        assert.equal(recs[0].groupName, "Zoom | Javis OS");
    });

    it("tells joining by oneself apart from being added", () => {
        const [self, added] = joinRecordsFromEvent(
            joinEvent({
                members: [
                    { id: "200", dName: "Lan" },
                    { id: "300", dName: "Minh" },
                ],
                sourceId: "200",
            }),
            ME,
        );
        assert.equal(self.addedBy, null);
        assert.equal(added.addedBy, "200");
        assert.equal(added.addedByMe, false);
    });

    it("keeps a join when THIS account added the member, and flags it", () => {
        const [r] = joinRecordsFromEvent(joinEvent({ members: [{ id: "300", dName: "Minh" }], sourceId: ME }), ME);
        assert.equal(r.userId, "300");
        assert.equal(r.addedByMe, true);
    });

    it("skips this account being added to a group (not a newcomer)", () => {
        assert.deepEqual(
            joinRecordsFromEvent(joinEvent({ members: [{ id: ME, dName: "Me" }], sourceId: "200" }), ME),
            [],
        );
    });

    it("ignores every other group event and malformed input", () => {
        assert.deepEqual(joinRecordsFromEvent({ ...joinEvent({ members: [{ id: "300" }] }), type: "leave" }, ME), []);
        assert.deepEqual(joinRecordsFromEvent({ type: "join_request", data: { uids: ["300"] } }, ME), []);
        assert.deepEqual(joinRecordsFromEvent(null, ME), []);
        assert.deepEqual(joinRecordsFromEvent({ type: "join", data: {} }, ME), []);
    });

    it("falls back to now when Zalo sends no usable time", () => {
        const [r] = joinRecordsFromEvent(joinEvent({ members: [{ id: "300" }], time: "" }), ME, 42);
        assert.equal(r.time, 42);
    });
});

describe("joinToBufferMessage", () => {
    it("is a group message sent BY the newcomer, so a reply that tags the sender tags them", () => {
        const [rec] = joinRecordsFromEvent(joinEvent({ members: [{ id: "300", dName: "Minh" }] }), ME);
        const m = joinToBufferMessage(rec);
        assert.equal(m.type, JOIN_MESSAGE_TYPE);
        assert.equal(m.threadId, "G1");
        assert.equal(m.threadType, "group");
        assert.equal(m.senderId, "300");
        assert.equal(m.senderName, "Minh");
        assert.equal(m.timestamp, 1759700000000);
        assert.match(m.text, /Minh joined the group/);
        assert.equal(m.event.kind, "join");
    });

    it("gives the same id for the same join (dedupe across reconnects)", () => {
        const [a] = joinRecordsFromEvent(joinEvent({ members: [{ id: "300" }] }), ME);
        const [b] = joinRecordsFromEvent(joinEvent({ members: [{ id: "300" }] }), ME);
        assert.equal(joinToBufferMessage(a).id, joinToBufferMessage(b).id);
    });
});

describe("GroupJoinLog", () => {
    const rec = (userId, time, groupId = "G1") => ({
        groupId,
        groupName: null,
        userId,
        userName: `u${userId}`,
        addedBy: null,
        addedByMe: false,
        time,
    });

    it("survives a restart: joins written to disk load back", () => {
        const file = join(mkdtempSync(join(tmpdir(), "jz-joins-")), "group-joins.jsonl");
        const log = new GroupJoinLog(file);
        assert.equal(log.add([rec("1", 1000), rec("2", 2000)]), 2);
        const again = new GroupJoinLog(file);
        assert.deepEqual(
            again.query().joins.map((r) => r.userId),
            ["1", "2"],
        );
    });

    it("ignores duplicates", () => {
        const log = new GroupJoinLog(null);
        log.add([rec("1", 1000)]);
        assert.equal(log.add([rec("1", 1000)]), 0);
        assert.equal(log.query().total, 1);
    });

    it("filters by group, member and time range, oldest first, most recent kept", () => {
        const log = new GroupJoinLog(null);
        log.add([rec("1", 1000), rec("2", 2000), rec("3", 3000), rec("4", 4000, "G2")]);
        assert.deepEqual(
            log.query({ threadId: "G1", since: 1500 }).joins.map((r) => r.userId),
            ["2", "3"],
        );
        assert.deepEqual(
            log.query({ until: 2000 }).joins.map((r) => r.userId),
            ["1", "2"],
        );
        assert.deepEqual(
            log.query({ userId: "4" }).joins.map((r) => r.groupId),
            ["G2"],
        );
        const lim = log.query({ limit: 2 });
        assert.deepEqual(
            lim.joins.map((r) => r.userId),
            ["3", "4"],
        );
        assert.equal(lim.total, 4);
    });

    it("skips a torn line instead of losing the whole log", () => {
        const file = join(mkdtempSync(join(tmpdir(), "jz-joins-")), "group-joins.jsonl");
        writeFileSync(file, JSON.stringify(rec("1", 1000)) + "\n" + '{"groupId":"G1","us', "utf8");
        assert.equal(new GroupJoinLog(file).query().total, 1);
    });

    it("stays within its cap", () => {
        const file = join(mkdtempSync(join(tmpdir(), "jz-joins-")), "group-joins.jsonl");
        const log = new GroupJoinLog(file, 10);
        for (let i = 0; i < 30; i++) log.add([rec(String(i), i)]);
        assert.ok(log.entries.length <= 12);
        assert.equal(log.query({ limit: 500 }).joins.at(-1).userId, "29");
        const lines = readFileSync(file, "utf8").trim().split("\n");
        assert.ok(lines.length <= 12, `file has ${lines.length} lines`);
    });
});
