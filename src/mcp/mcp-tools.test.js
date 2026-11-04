import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearSession } from "../core/zalo-client.js";
import { registerTools } from "./mcp-tools.js";

/** Formatted text and the typing indicator (1.9.0, Javis report 30/10/2026: customers should not tell a bot from a person). */
function tools(api) {
    const handlers = {};
    registerTools({ registerTool: (name, _spec, fn) => (handlers[name] = fn) }, api, {}, {}, {}, null, null, null);
    return handlers;
}
const parse = (r) => JSON.parse(r.content[0].text);

function fakeApi(calls) {
    return {
        sendMessage: async (content, threadId, type) => (
            calls.push(["send", content, threadId, type]),
            { message: { msgId: "m1" } }
        ),
        sendTypingEvent: async (threadId, type) => (calls.push(["typing", threadId, type]), { status: 0 }),
    };
}

describe("zalo_send_message styles", () => {
    afterEach(() => clearSession());

    it("plain text goes out as a string, as before", async () => {
        const calls = [];
        await tools(fakeApi(calls)).zalo_send_message({ threadId: "1", text: "hi", threadType: 0 });
        assert.deepEqual(calls, [["send", "hi", "1", 0]]);
    });

    it("styles go out with the text", async () => {
        const calls = [];
        const styles = [
            { start: 8, len: 5, st: "b" },
            { start: 18, len: 7, st: "c_db342e" },
        ];
        const r = await tools(fakeApi(calls)).zalo_send_message({
            threadId: "1",
            text: "Dạ chai 500ml giá 85.000đ ạ.",
            threadType: 0,
            styles,
        });
        assert.equal(parse(r).messageId, "m1");
        assert.deepEqual(calls[0][1], { msg: "Dạ chai 500ml giá 85.000đ ạ.", styles });
    });

    it("a style past the end of the text is dropped, not sent", async () => {
        const calls = [];
        await tools(fakeApi(calls)).zalo_send_message({
            threadId: "1",
            text: "abc",
            threadType: 1,
            styles: [{ start: 2, len: 5, st: "b" }],
        });
        assert.deepEqual(calls, [["send", "abc", "1", 1]]);
    });
});

describe("zalo_send_typing", () => {
    afterEach(() => clearSession());

    it("shows the indicator in the thread", async () => {
        const calls = [];
        const r = await tools(fakeApi(calls)).zalo_send_typing({ threadId: "42", threadType: 0 });
        assert.equal(parse(r).success, true);
        assert.deepEqual(calls, [["typing", "42", 0]]);
    });

    it("a Zalo error is reported, not thrown", async () => {
        const api = {
            sendTypingEvent: async () => {
                throw new Error("boom");
            },
        };
        const r = await tools(api).zalo_send_typing({ threadId: "42", threadType: 1 });
        assert.equal(r.isError, true);
    });
});

/** Quote-reply (1.11.0): reply to one earlier message so the student sees which one is meant. */
describe("zalo_send_message replyToMsgId", () => {
    afterEach(() => clearSession());

    const stored = {
        msgId: "900",
        cliMsgId: "55",
        senderId: "u1",
        text: "i do anki 30 mins",
        type: "text",
        timestamp: 1700000000000,
    };
    function withHistory(api, msg) {
        const handlers = {};
        const historyStore = { find: (t, id) => (t === "g1" && String(id) === "900" ? msg : null) };
        registerTools(
            { registerTool: (name, _spec, fn) => (handlers[name] = fn) },
            api,
            {},
            {},
            {},
            null,
            historyStore,
            null,
        );
        return handlers;
    }

    it("sends the text with a quote built from the stored message", async () => {
        const calls = [];
        const r = await withHistory(fakeApi(calls), stored).zalo_send_message({
            threadId: "g1",
            text: "Say: I did Anki for 30 minutes.",
            threadType: 1,
            replyToMsgId: "900",
        });
        assert.equal(parse(r).messageId, "m1");
        const sent = calls[0][1];
        assert.equal(sent.msg, "Say: I did Anki for 30 minutes.");
        assert.deepEqual(sent.quote, {
            content: "i do anki 30 mins",
            msgType: "webchat",
            propertyExt: undefined,
            uidFrom: "u1",
            msgId: "900",
            cliMsgId: "55",
            ts: "1700000000000",
            ttl: 0,
        });
    });

    it("keeps styles when quoting", async () => {
        const calls = [];
        const styles = [{ start: 0, len: 3, st: "b" }];
        await withHistory(fakeApi(calls), stored).zalo_send_message({
            threadId: "g1",
            text: "Say it",
            threadType: 1,
            styles,
            replyToMsgId: "900",
        });
        assert.deepEqual(calls[0][1].styles, styles);
    });

    it("an unknown message sends nothing and says why", async () => {
        const calls = [];
        const r = await withHistory(fakeApi(calls), stored).zalo_send_message({
            threadId: "g1",
            text: "x",
            threadType: 1,
            replyToMsgId: "404",
        });
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /cannot be quoted/);
        assert.deepEqual(calls, []);
    });

    it("an image message cannot be quoted and nothing is sent", async () => {
        const calls = [];
        const r = await withHistory(fakeApi(calls), { ...stored, type: "chat.photo", text: null }).zalo_send_message({
            threadId: "g1",
            text: "x",
            threadType: 1,
            replyToMsgId: "900",
        });
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /only text messages/);
        assert.deepEqual(calls, []);
    });

    it("without replyToMsgId nothing changes", async () => {
        const calls = [];
        await withHistory(fakeApi(calls), stored).zalo_send_message({ threadId: "g1", text: "hi", threadType: 1 });
        assert.deepEqual(calls, [["send", "hi", "g1", 1]]);
    });
});
