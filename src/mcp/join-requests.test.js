import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    JOIN_REQUEST_MESSAGE_TYPE,
    joinRequestRecordsFromEvent,
    joinRequestToBufferMessage,
    pendingFromApi,
    reviewOutcomes,
} from "./join-requests.js";
import { registerTools } from "./mcp-tools.js";

/** Shape of a zca-js "join_request" group_event (initializeGroupEvent output). */
function requestEvent(uids, { groupId = "G1", time = "1759700000000", totalPending = 3 } = {}) {
    return {
        type: "join_request",
        act: "join_request",
        threadId: groupId,
        isSelf: false,
        data: { uids, totalPending, groupId, time },
    };
}

describe("joinRequestRecordsFromEvent", () => {
    it("gives one record per applicant with the request time", () => {
        const recs = joinRequestRecordsFromEvent(requestEvent(["300", "301"]));
        assert.deepEqual(
            recs.map((r) => [r.groupId, r.userId, r.time, r.totalPending]),
            [
                ["G1", "300", 1759700000000, 3],
                ["G1", "301", 1759700000000, 3],
            ],
        );
    });

    it("drops duplicates and blanks, ignores other events", () => {
        assert.equal(joinRequestRecordsFromEvent(requestEvent(["300", "300", ""])).length, 1);
        assert.deepEqual(joinRequestRecordsFromEvent({ type: "join", data: { uids: ["300"] } }), []);
        assert.deepEqual(joinRequestRecordsFromEvent(null), []);
    });
});

describe("joinRequestToBufferMessage", () => {
    it("is a group message sent by the applicant, typed group.join_request", () => {
        const [rec] = joinRequestRecordsFromEvent(requestEvent(["300"]));
        const m = joinRequestToBufferMessage(rec, "Minh");
        assert.equal(m.type, JOIN_REQUEST_MESSAGE_TYPE);
        assert.equal(m.threadId, "G1");
        assert.equal(m.threadType, "group");
        assert.equal(m.senderId, "300");
        assert.equal(m.senderName, "Minh");
        assert.match(m.text, /Minh asked to join/);
        assert.equal(m.event.kind, "join_request");
    });

    it("falls back to the uid when the name is unknown", () => {
        const [rec] = joinRequestRecordsFromEvent(requestEvent(["300"]));
        assert.match(joinRequestToBufferMessage(rec).text, /300 asked to join/);
    });
});

describe("pendingFromApi / reviewOutcomes", () => {
    it("normalises the pending list", () => {
        assert.deepEqual(pendingFromApi({ time: 5, users: [{ uid: "300", dpn: "Minh", avatar: "a" }, { uid: "" }] }), {
            time: 5,
            requests: [{ userId: "300", name: "Minh", avatar: "a" }],
        });
        assert.deepEqual(pendingFromApi(null), { time: null, requests: [] });
    });

    it("maps Zalo status codes and never reports a missing member as done", () => {
        assert.deepEqual(
            reviewOutcomes({ 300: 0, 301: 170, 302: 178, 303: 166, 304: 999 }, [
                "300",
                "301",
                "302",
                "303",
                "304",
                "305",
            ]).map((r) => r.outcome),
            ["done", "not_pending", "already_member", "no_permission", "error_999", "unknown"],
        );
    });
});

describe("MCP tools", () => {
    function tools(api) {
        const handlers = {};
        registerTools({ registerTool: (name, _spec, fn) => (handlers[name] = fn) }, api, {}, {}, {}, null, null, null);
        return handlers;
    }
    const parse = (r) => JSON.parse(r.content[0].text);

    it("zalo_list_join_requests returns applicants", async () => {
        const h = tools({ getPendingGroupMembers: async () => ({ time: 1, users: [{ uid: "300", dpn: "Minh" }] }) });
        const out = parse(await h.zalo_list_join_requests({ threadId: "G1" }));
        assert.equal(out.count, 1);
        assert.equal(out.requests[0].name, "Minh");
    });

    it("zalo_review_join_requests approves with the right payload and reports per person", async () => {
        const calls = [];
        const h = tools({
            reviewPendingMemberRequest: async (payload, groupId) => {
                calls.push({ payload, groupId });
                return { 300: 0, 301: 170 };
            },
        });
        const out = parse(
            await h.zalo_review_join_requests({ threadId: "G1", userIds: ["300", "301", "300"], action: "approve" }),
        );
        assert.deepEqual(calls, [{ payload: { members: ["300", "301"], isApprove: true }, groupId: "G1" }]);
        assert.equal(out.done, 1);
        assert.deepEqual(
            out.results.map((r) => r.outcome),
            ["done", "not_pending"],
        );
    });

    it("reject sends isApprove false", async () => {
        let seen = null;
        const h = tools({ reviewPendingMemberRequest: async (payload) => ((seen = payload), { 300: 0 }) });
        await h.zalo_review_join_requests({ threadId: "G1", userIds: ["300"], action: "reject" });
        assert.equal(seen.isApprove, false);
    });

    it("a Zalo error says why (admin rights / approval mode)", async () => {
        const h = tools({
            getPendingGroupMembers: async () => {
                throw new Error("Permission denied");
            },
        });
        const r = await h.zalo_list_join_requests({ threadId: "G1" });
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /owner or a deputy/);
    });
});
