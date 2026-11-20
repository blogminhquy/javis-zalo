import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { __setSessionForTests, clearSession } from "../core/zalo-client.js";
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

describe("zalo_get_group_settings and zalo_update_group_settings", () => {
    afterEach(() => clearSession());

    function groupApi(overrides = {}) {
        const setting = {
            blockName: 1,
            signAdminMsg: 1,
            addMemberOnly: 0,
            setTopicOnly: 0,
            enableMsgHistory: 1,
            joinAppr: 1,
            lockCreatePost: 0,
            lockCreatePoll: 0,
            lockSendMsg: 0,
            lockViewMember: 0,
            bannFeature: 0,
            dirtyMedia: 0,
            banDuration: 0,
            ...overrides.setting,
        };
        const calls = [];
        return {
            calls,
            setting,
            api: {
                getOwnId: () => overrides.ownId ?? "admin-1",
                getGroupInfo: async (id) => {
                    calls.push(["getGroupInfo", id]);
                    return {
                        gridInfoMap: {
                            g1: {
                                groupId: "g1",
                                name: overrides.name ?? "Nhóm K12",
                                creatorId: "owner-1",
                                adminIds: ["admin-1"],
                                setting: structuredClone(setting),
                            },
                        },
                    };
                },
                getGroupBlockedMember: async (payload, id) => {
                    calls.push(["getGroupBlockedMember", payload, id]);
                    return overrides.blocked ?? { blocked_members: [], has_more: 0 };
                },
                updateGroupSettings: async (next, id) => {
                    calls.push(["updateGroupSettings", structuredClone(next), id]);
                    for (const [k, v] of Object.entries(next)) {
                        setting[k] = v ? 1 : 0;
                    }
                    return "";
                },
            },
        };
    }

    it("reads and updates normalized boolean group settings via live() session", async () => {
        const stale = groupApi({ name: "Stale" });
        const fresh = groupApi({ name: "Live Group" });
        __setSessionForTests(fresh.api, "admin-1");

        const h = tools(stale.api);
        const r = await h.zalo_get_group_settings({ threadId: "g1" });
        const body = parse(r);
        assert.equal(body.threadId, "g1");
        assert.equal(body.groupName, "Live Group");
        assert.equal(body.isAdmin, true);
        assert.equal(body.settings.signAdminMsg, true);
        assert.equal(body.settings.enableMsgHistory, true);
        assert.equal(body.settings.lockSendMsg, false);

        const u = await h.zalo_update_group_settings({ threadId: "g1", setTopicOnly: true });
        assert.equal(parse(u).changed, true);
        assert.equal(fresh.setting.setTopicOnly, 1);
        assert.equal(stale.calls.length, 0);
    });

    it("updates only requested settings while preserving omitted flags", async () => {
        const { api, setting } = groupApi();
        const h = tools(api);

        const r = await h.zalo_update_group_settings({ threadId: "g1", lockSendMsg: true });
        const body = parse(r);
        assert.equal(body.success, true);
        assert.equal(body.changed, true);
        assert.deepEqual(body.changedFlags, ["lockSendMsg"]);
        assert.equal(body.settings.lockSendMsg, true);
        assert.equal(body.settings.blockName, true);
        assert.equal(body.settings.signAdminMsg, true);
        assert.equal(body.settings.enableMsgHistory, true);
        assert.equal(body.settings.joinAppr, true);
        assert.equal(setting.lockSendMsg, 1);
        assert.equal(setting.enableMsgHistory, 1);
    });

    it("returns an MCP error when SDK-unpreserved settings or empty patch block the write", async () => {
        const { api, calls } = groupApi({ setting: { banDuration: 15 } });
        const h = tools(api);

        const r1 = await h.zalo_update_group_settings({ threadId: "g1", lockSendMsg: true });
        assert.equal(r1.isError, true);
        assert.match(r1.content[0].text, /cannot be preserved/);
        assert.equal(calls.filter((c) => c[0] === "updateGroupSettings").length, 0);

        const r2 = await h.zalo_update_group_settings({ threadId: "g1" });
        assert.equal(r2.isError, true);
        assert.match(r2.content[0].text, /at least one/);
    });
});
