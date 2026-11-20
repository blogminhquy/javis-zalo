import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { linkMessageText, sendLinkCard } from "./send-link.js";
import { registerTools } from "./mcp-tools.js";

const URL = "https://meet.google.com/gdp-fthu-kbo";

function fakeApi(calls, { parseFails = false, sendFails = false } = {}) {
    return {
        parseLink: async (link) => {
            calls.push(["parse", link]);
            if (parseFails) throw new Error("no preview");
            return { data: { title: "Google Meet" } };
        },
        sendLink: async (opts, threadId, type) => {
            calls.push(["link", opts, threadId, type]);
            if (sendFails) throw new Error("send failed");
            return { msgId: 777, cliMsgId: 5 };
        },
        sendMessage: async (content, threadId, type) => (
            calls.push(["send", content, threadId, type]),
            { message: { msgId: "m1", cliMsgId: 6 } }
        ),
    };
}

describe("linkMessageText", () => {
    it("keeps text that already holds the link", () => {
        assert.equal(linkMessageText(URL, `Họp ở đây: ${URL}`), `Họp ở đây: ${URL}`);
    });
    it("appends the link when the text lacks it", () => {
        assert.equal(linkMessageText(URL, "Họp ở đây:"), `Họp ở đây: ${URL}`);
    });
    it("is the link alone without text", () => {
        assert.equal(linkMessageText(URL, "  "), URL);
    });
});

describe("sendLinkCard", () => {
    it("sends a card with the text", async () => {
        const calls = [];
        const r = await sendLinkCard(fakeApi(calls), { threadId: "9", url: URL, text: `Link: ${URL}`, threadType: 1 });
        assert.deepEqual(r, { success: true, messageId: "777", cliMsgId: "5", preview: true });
        assert.deepEqual(calls[1], ["link", { link: URL, msg: `Link: ${URL}` }, "9", 1]);
    });

    it("falls back to a plain message when Zalo cannot read the page", async () => {
        const calls = [];
        const r = await sendLinkCard(fakeApi(calls, { parseFails: true }), { threadId: "9", url: URL, text: "Xem" });
        assert.equal(r.preview, false);
        assert.equal(r.messageId, "m1");
        assert.equal(r.cliMsgId, "6");
        assert.deepEqual(calls[1], ["send", `Xem ${URL}`, "9", 0]);
        assert.equal(calls.length, 2);
    });

    it("a failed send is not retried as plain text", async () => {
        const calls = [];
        await assert.rejects(sendLinkCard(fakeApi(calls, { sendFails: true }), { threadId: "9", url: URL }));
        assert.equal(calls.filter((c) => c[0] === "send").length, 0);
    });
});

describe("zalo_send_link tool", () => {
    it("is registered and reports a Zalo error instead of throwing", async () => {
        const handlers = {};
        const api = fakeApi([], { sendFails: true });
        registerTools({ registerTool: (name, _s, fn) => (handlers[name] = fn) }, api, {}, {}, {}, null, null, null);
        const r = await handlers.zalo_send_link({ threadId: "1", url: URL, text: "", threadType: 0 });
        assert.equal(r.isError, true);
    });
});
