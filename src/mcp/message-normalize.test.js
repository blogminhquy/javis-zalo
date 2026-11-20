import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    threadTypeLabel,
    extractReplyTo,
    extractMentions,
    extractAttachment,
    normalizeMessage,
    toHistoryMessage,
} from "./message-normalize.js";

/** Build a fake zca-js message event. */
function fakeMsg(dataOverrides = {}, { type = 1, threadId = "g1" } = {}) {
    return {
        type,
        threadId,
        data: {
            msgId: "m1",
            uidFrom: "u1",
            dName: "Minh",
            content: "hello",
            msgType: "webchat",
            ts: "1710000000000",
            ...dataOverrides,
        },
    };
}

describe("threadTypeLabel", () => {
    it("maps 0→dm and 1→group", () => {
        assert.equal(threadTypeLabel(0), "dm");
        assert.equal(threadTypeLabel(1), "group");
    });
});

describe("extractReplyTo", () => {
    it("maps zca-js quote fields (ownerId→senderId, fromD→senderName, msg→text, globalMsgId→msgId)", () => {
        const msg = fakeMsg({
            quote: { ownerId: "u9", fromD: "Le Doan", msg: "M6 trắng sáng thấp", globalMsgId: 8084124152483 },
        });
        assert.deepEqual(extractReplyTo(msg), {
            senderId: "u9",
            senderName: "Le Doan",
            text: "M6 trắng sáng thấp",
            msgId: "8084124152483",
        });
    });

    it("returns null when there is no quote", () => {
        assert.equal(extractReplyTo(fakeMsg()), null);
    });

    it("preserves a globalMsgId of 0", () => {
        const msg = fakeMsg({ quote: { ownerId: "u9", fromD: "X", msg: "hi", globalMsgId: 0 } });
        assert.equal(extractReplyTo(msg).msgId, "0");
    });

    it("nulls missing quote sub-fields", () => {
        const msg = fakeMsg({ quote: { ownerId: "u9" } });
        assert.deepEqual(extractReplyTo(msg), { senderId: "u9", senderName: null, text: null, msgId: null });
    });
});

describe("extractMentions", () => {
    it("maps mentions[].uid to a uid array", () => {
        const msg = fakeMsg({
            mentions: [
                { uid: "u1", pos: 0, len: 3 },
                { uid: "u2", pos: 5, len: 4 },
            ],
        });
        assert.deepEqual(extractMentions(msg), ["u1", "u2"]);
    });

    it("returns null when there are no mentions", () => {
        assert.equal(extractMentions(fakeMsg()), null);
        assert.equal(extractMentions(fakeMsg({ mentions: [] })), null);
    });
});

describe("normalizeMessage (live buffer shape)", () => {
    it("normalizes a text message with an explicit receive timestamp", () => {
        const out = normalizeMessage(fakeMsg({ content: "hi there" }), 1234);
        assert.equal(out.id, "m1");
        assert.equal(out.threadId, "g1");
        assert.equal(out.threadType, "group");
        assert.equal(out.senderId, "u1");
        assert.equal(out.senderName, "Minh");
        assert.equal(out.text, "hi there");
        assert.equal(out.type, "text");
        assert.equal(out.timestamp, 1234);
        assert.equal(out.attachment, null);
        assert.equal(out.replyTo, null);
        assert.equal(out.isSelf, false);
    });

    it("flags a message sent from this account (zca-js isSelf)", () => {
        const msg = fakeMsg({ content: "em gửi báo giá" });
        msg.isSelf = true;
        assert.equal(normalizeMessage(msg, 1).isSelf, true);
        assert.equal(toHistoryMessage(msg).isSelf, true);
    });

    it("populates replyTo for a reply", () => {
        const out = normalizeMessage(
            fakeMsg({ quote: { ownerId: "u9", fromD: "Le Doan", msg: "q", globalMsgId: 7 } }),
            1,
        );
        assert.deepEqual(out.replyTo, { senderId: "u9", senderName: "Le Doan", text: "q", msgId: "7" });
    });
});

describe("toHistoryMessage (history shape)", () => {
    it("uses the real Zalo ts and carries replyTo + mentions", () => {
        const out = toHistoryMessage(
            fakeMsg({
                quote: { ownerId: "u9", fromD: "Le Doan", msg: "q", globalMsgId: 7 },
                mentions: [{ uid: "u2", pos: 0, len: 3 }],
            }),
        );
        assert.equal(out.msgId, "m1");
        assert.equal(out.timestamp, 1710000000000);
        assert.deepEqual(out.replyTo, { senderId: "u9", senderName: "Le Doan", text: "q", msgId: "7" });
        assert.deepEqual(out.mentions, ["u2"]);
    });

    it("keeps Zalo's cliMsgId on both shapes (reacting needs it), null when absent", () => {
        const msg = fakeMsg({ cliMsgId: 4242 });
        assert.equal(normalizeMessage(msg, 1).cliMsgId, "4242");
        assert.equal(toHistoryMessage(msg).cliMsgId, "4242");
        assert.equal(normalizeMessage(fakeMsg(), 1).cliMsgId, null);
        assert.equal(toHistoryMessage(fakeMsg()).cliMsgId, null);
    });

    it("keeps a link card's link, title and description (live and history alike)", () => {
        const card = {
            title: "@Bot xem giúp",
            description: "Try out Artifacts created by Claude users",
            href: "https://claude.ai/public/artifacts/abc",
            action: "recommened.link",
        };
        const msg = fakeMsg({ msgType: "chat.recommended", content: card, mentions: [{ uid: "u7", pos: 0, len: 4 }] });
        const want = { type: "chat.recommended", url: card.href, description: card.title };
        const hist = toHistoryMessage(msg);
        assert.deepEqual(hist.attachment, want);
        assert.equal(hist.text, card.description);
        const live = normalizeMessage(msg, 1);
        assert.deepEqual(live.attachment, want);
        assert.deepEqual(live.mentions, ["u7"]);
    });

    it("has no attachment for a text message", () => {
        assert.equal(toHistoryMessage(fakeMsg({ content: "hi" })).attachment, null);
        assert.equal(normalizeMessage(fakeMsg({ content: "hi" }), 1).mentions, null);
    });

    it("falls back to the provided timestamp when ts is absent", () => {
        const msg = fakeMsg();
        delete msg.data.ts;
        assert.equal(toHistoryMessage(msg, 999).timestamp, 999);
    });
});

describe("extractAttachment (inbound media normalization)", () => {
    it("falls back through href -> hdUrl -> normalUrl and keeps thumbUrl separate", () => {
        const msg = fakeMsg({
            msgType: "chat.photo",
            content: {
                hdUrl: "https://cdn.zalo.me/photo-hd.jpg",
                normalUrl: "https://cdn.zalo.me/photo-normal.jpg",
                thumb: "https://cdn.zalo.me/photo-thumb.jpg",
                title: "Báo cáo ngày 20/11",
            },
        });
        const live = normalizeMessage(msg, 1000);
        const hist = toHistoryMessage(msg, 1000);

        assert.equal(live.type, "chat.photo");
        assert.deepEqual(live.attachment, {
            type: "chat.photo",
            url: "https://cdn.zalo.me/photo-hd.jpg",
            thumbUrl: "https://cdn.zalo.me/photo-thumb.jpg",
            description: "Báo cáo ngày 20/11",
        });
        assert.deepEqual(hist.attachment, live.attachment);
    });

    it("never puts video thumb into url when href/hdUrl/normalUrl are absent", () => {
        const msg = fakeMsg({
            msgType: "chat.video.msg",
            content: {
                thumb: "https://cdn.zalo.me/video-thumb.jpg",
                title: "clip.mp4",
                params: JSON.stringify({ duration: 5000, fileSize: "130896" }),
            },
        });
        const live = normalizeMessage(msg, 1000);
        const hist = toHistoryMessage(msg, 1000);

        assert.equal(live.attachment.url, null);
        assert.equal(live.attachment.thumbUrl, "https://cdn.zalo.me/video-thumb.jpg");
        assert.equal(live.attachment.duration, 5000);
        assert.equal(live.attachment.fileSize, 130896);
        assert.deepEqual(hist.attachment, live.attachment);
    });

    it("extracts optional fileName, fileSize, and duration from object or JSON-string params", () => {
        const att = extractAttachment(
            {
                href: "https://cdn.zalo.me/voice.m4a",
                params: '{"fileName":"voice_20_11.m4a","fsize":98231,"du":6}',
            },
            "chat.voice",
        );
        assert.deepEqual(att, {
            type: "chat.voice",
            url: "https://cdn.zalo.me/voice.m4a",
            description: null,
            fileName: "voice_20_11.m4a",
            fileSize: 98231,
            duration: 6,
        });
        assert.equal("thumbUrl" in att, false);
    });
});
