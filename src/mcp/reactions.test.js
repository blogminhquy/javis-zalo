import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Reactions } from "zca-js";
import {
    REACTIONS,
    describeReaction,
    lookupCliMsgId,
    normalizeReaction,
    reactToMessage,
    resolveReaction,
} from "./reactions.js";
import { MessageBuffer } from "./message-buffer.js";
import { HistoryStore } from "./history-store.js";

/** A zca-js `reaction` event as the listener hands it over. */
function fakeReaction({ icon = "/-heart", isGroup = false, isSelf = false, rMsg } = {}) {
    return {
        threadId: isGroup ? "g1" : "u1",
        isSelf,
        isGroup,
        data: {
            msgId: "r100",
            cliMsgId: "c100",
            uidFrom: "u1",
            dName: "Lan",
            ts: "1761400000000",
            content: {
                rMsg: rMsg ?? [{ gMsgID: 555, cMsgID: 777, msgType: 1 }],
                rIcon: icon,
                rType: 5,
                source: 6,
            },
        },
    };
}

describe("REACTIONS", () => {
    it("uses exactly the codes zca-js sends", () => {
        const known = new Set(Object.values(Reactions));
        for (const [name, r] of Object.entries(REACTIONS)) assert.ok(known.has(r.code), `${name}: ${r.code}`);
    });
});

describe("describeReaction", () => {
    it("names a known code and keeps an unknown one raw", () => {
        assert.deepEqual(describeReaction("/-heart"), { name: "heart", code: "/-heart", emoji: "❤️" });
        assert.deepEqual(describeReaction("/-new"), { name: null, code: "/-new", emoji: null });
    });
});

describe("resolveReaction", () => {
    it("accepts a name, the emoji with or without U+FE0F, or the raw code", () => {
        assert.equal(resolveReaction("heart").code, "/-heart");
        assert.equal(resolveReaction("Like").code, "/-strong");
        assert.equal(resolveReaction("❤️").code, "/-heart");
        assert.equal(resolveReaction("❤").code, "/-heart");
        assert.equal(resolveReaction("😆").code, ":>");
        assert.equal(resolveReaction(":>").name, "haha");
    });
    it("none / remove / empty take the reaction off", () => {
        for (const w of ["none", "remove", "", "Off"]) {
            assert.deepEqual(resolveReaction(w), { code: "", name: null, emoji: null, remove: true });
        }
    });
    it("unknown input is null, never a guess", () => {
        assert.equal(resolveReaction("banana"), null);
    });
});

describe("normalizeReaction", () => {
    it("maps a DM heart into a buffer entry pointing at the message reacted to", () => {
        const e = normalizeReaction(fakeReaction(), 1);
        assert.equal(e.id, "r100");
        assert.equal(e.threadId, "u1");
        assert.equal(e.threadType, "dm");
        assert.equal(e.senderId, "u1");
        assert.equal(e.senderName, "Lan");
        assert.equal(e.isSelf, false);
        assert.equal(e.type, "reaction");
        assert.equal(e.text, null);
        assert.equal(e.timestamp, 1761400000000);
        assert.deepEqual(e.reaction, {
            name: "heart",
            code: "/-heart",
            emoji: "❤️",
            removed: false,
            targetMsgId: "555",
            targetCliMsgId: "777",
        });
    });
    it("a group reaction is filed under the group", () => {
        assert.equal(normalizeReaction(fakeReaction({ isGroup: true })).threadType, "group");
    });
    it("an empty code means the contact took the reaction back", () => {
        const e = normalizeReaction(fakeReaction({ icon: "" }));
        assert.equal(e.reaction.removed, true);
        assert.equal(e.reaction.name, null);
    });
    it("no target message: nothing to file", () => {
        assert.equal(normalizeReaction(fakeReaction({ rMsg: [] })), null);
        assert.equal(normalizeReaction({}), null);
    });
});

describe("lookupCliMsgId", () => {
    it("finds the client id in the live buffer first, then history", () => {
        const buffer = new MessageBuffer();
        buffer.push("u1", { id: "m1", cliMsgId: "c1", threadId: "u1", timestamp: Date.now() });
        const historyStore = new HistoryStore();
        historyStore.ingest("u1", [{ msgId: "m2", cliMsgId: "c2", threadId: "u1", timestamp: Date.now() }]);
        assert.equal(lookupCliMsgId("u1", "m1", { buffer, historyStore }), "c1");
        assert.equal(lookupCliMsgId("u1", "m2", { buffer, historyStore }), "c2");
        assert.equal(lookupCliMsgId("u1", "m3", { buffer, historyStore }), null);
    });
});

describe("reactToMessage", () => {
    function fakeApi() {
        const calls = [];
        return { calls, addReaction: async (icon, dest) => calls.push({ icon, dest }) };
    }

    it("sends Zalo's code with both ids of the target", async () => {
        const api = fakeApi();
        const out = await reactToMessage(api, {
            threadId: "g1",
            threadType: 1,
            msgId: "555",
            cliMsgId: "777",
            reaction: "❤️",
        });
        assert.deepEqual(api.calls, [
            { icon: "/-heart", dest: { data: { msgId: "555", cliMsgId: "777" }, threadId: "g1", type: 1 } },
        ]);
        assert.deepEqual(out, { success: true, msgId: "555", reaction: "heart", emoji: "❤️", removed: false });
    });

    it("looks up cliMsgId when only msgId is given", async () => {
        const api = fakeApi();
        const buffer = new MessageBuffer();
        buffer.push("u1", { id: "m1", cliMsgId: "c1", threadId: "u1", timestamp: Date.now() });
        await reactToMessage(api, { threadId: "u1", threadType: 0, msgId: "m1", reaction: "like" }, { buffer });
        assert.equal(api.calls[0].dest.data.cliMsgId, "c1");
        assert.equal(api.calls[0].icon, "/-strong");
    });

    it("none takes the reaction off", async () => {
        const api = fakeApi();
        const out = await reactToMessage(api, {
            threadId: "u1",
            threadType: 0,
            msgId: "m1",
            cliMsgId: "c1",
            reaction: "none",
        });
        assert.equal(api.calls[0].icon, "");
        assert.equal(out.removed, true);
    });

    it("refuses an unknown reaction or an unknown message without calling Zalo", async () => {
        const api = fakeApi();
        await assert.rejects(
            reactToMessage(api, { threadId: "u1", threadType: 0, msgId: "m1", cliMsgId: "c1", reaction: "banana" }),
            /Unknown reaction/,
        );
        await assert.rejects(
            reactToMessage(api, { threadId: "u1", threadType: 0, msgId: "m9", reaction: "heart" }),
            /cliMsgId is unknown/,
        );
        assert.equal(api.calls.length, 0);
    });
});
