import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { __setSessionForTests, clearSession } from "../core/zalo-client.js";
import { registerTools } from "./mcp-tools.js";

/**
 * After a reconnect the MCP server logs in again and the listener moves to a new API instance.
 * Every tool must call that live instance, not the one captured when the tools were registered:
 * the old one belongs to the dropped session (Javis report, 22/10/2026).
 */
function tools(api) {
    const handlers = {};
    registerTools({ registerTool: (name, _spec, fn) => (handlers[name] = fn) }, api, {}, {}, {}, null, null, null);
    return handlers;
}
const parse = (r) => JSON.parse(r.content[0].text);

function fakeApi(tag, calls) {
    return {
        sendMessage: async (text, threadId, type) => (
            calls.push([tag, "send", text, threadId, type]),
            { message: { msgId: tag } }
        ),
        getPendingGroupMembers: async () => (calls.push([tag, "pending"]), { time: 1, users: [] }),
        reviewPendingMemberRequest: async () => (calls.push([tag, "review"]), { 300: 0 }),
        getLabels: async () => (calls.push([tag, "labels"]), { labelData: [], version: 1 }),
    };
}

describe("tools use the live API after a re-login", () => {
    afterEach(() => clearSession());

    it("zalo_send_message sends through the new instance", async () => {
        const calls = [];
        const first = fakeApi("old", calls);
        const h = tools(first);
        __setSessionForTests(first);
        assert.equal(parse(await h.zalo_send_message({ threadId: "1", text: "a", threadType: 0 })).messageId, "old");
        __setSessionForTests(fakeApi("new", calls)); // what the reconnect handler does
        assert.equal(parse(await h.zalo_send_message({ threadId: "1", text: "b", threadType: 0 })).messageId, "new");
        assert.deepEqual(
            calls.map((c) => c[0]),
            ["old", "new"],
        );
    });

    it("join requests and labels follow the new instance too", async () => {
        const calls = [];
        const h = tools(fakeApi("old", calls));
        __setSessionForTests(fakeApi("new", calls));
        await h.zalo_list_join_requests({ threadId: "G1" });
        await h.zalo_review_join_requests({ threadId: "G1", userIds: ["300"], action: "approve" });
        await h.zalo_get_labels({ refresh: true });
        assert.deepEqual(
            calls.map((c) => c[0]),
            ["new", "new", "new"],
        );
    });

    it("without a session (tests, before login) the registered instance is used", async () => {
        const calls = [];
        const h = tools(fakeApi("only", calls));
        await h.zalo_send_message({ threadId: "1", text: "a", threadType: 0 });
        assert.equal(calls[0][0], "only");
    });
});
