import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { MAX_FILES_PER_SEND, sendFileFromOutbox } from "./send-file.js";

function api({ listening = true } = {}) {
    const a = {
        listener: { ws: listening ? { readyState: 1 } : null },
        calls: [],
        async uploadAttachment(paths) {
            return paths.map((p) => ({ p }));
        },
        async sendMessage(content, threadId, type) {
            const up = await a.uploadAttachment(content.attachments);
            a.calls.push({ content, threadId, type });
            return { attachment: up.map((_, i) => ({ msgId: 7 + i })) };
        },
    };
    return a;
}

describe("sendFileFromOutbox", () => {
    let outbox;
    beforeEach(() => {
        outbox = fs.mkdtempSync(join(os.tmpdir(), "outbox-"));
        fs.writeFileSync(join(outbox, "Danh sach.xlsx"), "x");
    });
    afterEach(() => fs.rmSync(outbox, { recursive: true, force: true }));

    it("sends an outbox file with its caption and returns the message ids", async () => {
        const a = api();
        const res = await sendFileFromOutbox(
            a,
            { threadId: "42", threadType: 1, paths: [join(outbox, "Danh sach.xlsx")], caption: "Gửi chị" },
            { outbox },
        );
        assert.deepEqual(res, { success: true, sent: 1, files: ["Danh sach.xlsx"], messageIds: ["7"] });
        assert.equal(a.calls[0].threadId, "42");
        assert.equal(a.calls[0].type, 1);
        assert.equal(a.calls[0].content.msg, "Gửi chị");
    });

    it("refuses a path outside the outbox before touching Zalo", async () => {
        const a = api();
        await assert.rejects(
            sendFileFromOutbox(a, { threadId: "42", paths: [import.meta.filename] }, { outbox }),
            /outside/,
        );
        assert.equal(a.calls.length, 0);
    });

    it("refuses too many files and an empty list", async () => {
        const many = Array.from({ length: MAX_FILES_PER_SEND + 1 }, () => join(outbox, "Danh sach.xlsx"));
        await assert.rejects(sendFileFromOutbox(api(), { threadId: "1", paths: many }, { outbox }), /At most/);
        await assert.rejects(sendFileFromOutbox(api(), { threadId: "1", paths: [] }, { outbox }), /No paths/);
    });

    it("says so when the live connection is down", async () => {
        const paths = [join(outbox, "Danh sach.xlsx")];
        await assert.rejects(
            sendFileFromOutbox(api({ listening: false }), { threadId: "1", paths }, { outbox }),
            /live connection/,
        );
    });
});
