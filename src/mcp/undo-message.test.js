import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { undoSentMessage } from "./undo-message.js";

function fakeApi() {
    const calls = [];
    return { calls, undo: async (...a) => (calls.push(a), { status: 0 }) };
}

describe("undoSentMessage", () => {
    it("recalls with the given cliMsgId", async () => {
        const api = fakeApi();
        const res = await undoSentMessage(api, { threadId: "t1", threadType: 1, msgId: 900, cliMsgId: 55 });
        assert.deepEqual(api.calls, [[{ msgId: "900", cliMsgId: "55" }, "t1", 1]]);
        assert.deepEqual(res, { success: true, msgId: "900", cliMsgId: "55", status: 0 });
    });

    it("defaults to a DM and looks cliMsgId up in the live buffer", async () => {
        const api = fakeApi();
        const buffer = { find: (t, id) => (t === "t1" && id === "900" ? { cliMsgId: 77 } : null) };
        await undoSentMessage(api, { threadId: "t1", msgId: "900" }, { buffer });
        assert.deepEqual(api.calls, [[{ msgId: "900", cliMsgId: "77" }, "t1", 0]]);
    });

    it("falls back to the history store", async () => {
        const api = fakeApi();
        const historyStore = { find: () => ({ cliMsgId: "88" }) };
        await undoSentMessage(api, { threadId: "t1", msgId: "900" }, { buffer: { find: () => null }, historyStore });
        assert.equal(api.calls[0][0].cliMsgId, "88");
    });

    it("an explicit cliMsgId wins over the stores", async () => {
        const api = fakeApi();
        const buffer = { find: () => ({ cliMsgId: "77" }) };
        await undoSentMessage(api, { threadId: "t1", msgId: "900", cliMsgId: "11" }, { buffer });
        assert.equal(api.calls[0][0].cliMsgId, "11");
    });

    it("an unknown cliMsgId throws before Zalo is called", async () => {
        const api = fakeApi();
        await assert.rejects(
            undoSentMessage(api, { threadId: "t1", msgId: "404" }, { buffer: { find: () => null } }),
            /Message 404 has no known cliMsgId/,
        );
        assert.deepEqual(api.calls, []);
    });

    it("lets a Zalo error through", async () => {
        const api = {
            undo: async () => {
                throw new Error("boom");
            },
        };
        await assert.rejects(undoSentMessage(api, { threadId: "t1", msgId: "1", cliMsgId: "2" }), /boom/);
    });
});
