import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { filesInside, isListening, needsLiveConfirm, sendAttachments } from "./send-files.js";

/**
 * A fake zca-js API shaped like the real one where it matters: sendMessage calls
 * `api.uploadAttachment` as a property, a non-image upload waits for `file_done` on the
 * listener (ctx.uploadCallbacks), and only then is the message posted.
 */
function fakeApi({ listening = true } = {}) {
    const callbacks = new Map();
    const listener = new EventEmitter();
    listener.ws = listening ? { readyState: 1 } : null;
    let nextFileId = 1;
    const api = {
        listener,
        posted: [],
        uploads: 0,
        async uploadAttachment(paths) {
            api.uploads++;
            return Promise.all(
                paths.map((p) =>
                    needsLiveConfirm(p)
                        ? new Promise((res) => callbacks.set(String(nextFileId++), (ws) => res({ p, ...ws })))
                        : Promise.resolve({ p, normalUrl: "https://img" }),
                ),
            );
        },
        async sendMessage({ msg, attachments }, threadId, type) {
            const uploaded = await api.uploadAttachment(attachments, threadId, type);
            api.posted.push({ msg, threadId, type, uploaded });
            return { message: null, attachment: uploaded.map((_, i) => ({ msgId: 100 + i })) };
        },
        /** What the listener does on a `file_done` control frame. */
        fileDone() {
            for (const [id, cb] of callbacks) {
                cb({ fileId: id, fileUrl: `https://f/${id}` });
                callbacks.delete(id);
            }
        },
        pending: () => callbacks.size,
    };
    return api;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("needsLiveConfirm", () => {
    it("images and GIFs come back over HTTP", () => {
        for (const p of ["a.jpg", "a.JPEG", "b.png", "c.webp", "d.gif"]) assert.equal(needsLiveConfirm(p), false, p);
    });
    it("every other file waits for the live connection", () => {
        for (const p of ["list.xlsx", "r.pdf", "d.docx", "z.zip", "v.mp4", "x.bmp", "noext"])
            assert.equal(needsLiveConfirm(p), true, p);
    });
});

describe("isListening", () => {
    it("reads the listener socket state", () => {
        assert.equal(isListening(fakeApi()), true);
        assert.equal(isListening(fakeApi({ listening: false })), false);
        assert.equal(isListening({}), false);
    });
});

describe("sendAttachments", () => {
    it("a file without a live connection fails at once and uploads nothing (the old 120 s hang)", async () => {
        const api = fakeApi({ listening: false });
        const t0 = Date.now();
        await assert.rejects(
            sendAttachments(api, { paths: ["/x/list.xlsx"] }, "123", 0, { timeoutMs: 5000 }),
            /live connection.*zalo_send_file/s,
        );
        assert.ok(Date.now() - t0 < 1000);
        assert.equal(api.uploads, 0);
        assert.equal(api.posted.length, 0);
    });

    it("images still go without a live connection", async () => {
        const api = fakeApi({ listening: false });
        const res = await sendAttachments(api, { msg: "hi", paths: ["/x/a.png"] }, "123", 1);
        assert.equal(api.posted.length, 1);
        assert.equal(res.attachment[0].msgId, 100);
    });

    it("a file is sent once Zalo confirms the upload", async () => {
        const api = fakeApi();
        const sending = sendAttachments(api, { msg: "Danh sách", paths: ["/x/list.xlsx"] }, "123", 0, {
            timeoutMs: 2000,
        });
        await tick(10);
        assert.equal(api.pending(), 1);
        api.fileDone();
        const res = await sending;
        assert.equal(api.posted.length, 1);
        assert.equal(api.posted[0].uploaded[0].fileUrl, "https://f/1");
        assert.equal(res.attachment.length, 1);
    });

    it("no confirmation: clear error at the deadline, and a late confirmation sends nothing", async () => {
        const api = fakeApi();
        await assert.rejects(
            sendAttachments(api, { paths: ["/x/list.xlsx"] }, "123", 0, { timeoutMs: 50 }),
            /did not confirm the upload of list\.xlsx within 0s\. Nothing was sent/,
        );
        api.fileDone();
        await tick(10);
        assert.equal(api.posted.length, 0);
    });

    it("the next send after a timeout works normally", async () => {
        const api = fakeApi();
        await assert.rejects(sendAttachments(api, { paths: ["/x/a.pdf"] }, "1", 0, { timeoutMs: 30 }));
        const sending = sendAttachments(api, { paths: ["/x/b.pdf"] }, "1", 0, { timeoutMs: 2000 });
        await tick(10);
        api.fileDone();
        await sending;
        assert.equal(api.posted.length, 1);
        assert.equal(api.posted[0].uploaded[0].p, "/x/b.pdf");
    });
});

describe("filesInside", () => {
    let root;
    let outside;
    beforeEach(() => {
        root = fs.mkdtempSync(join(os.tmpdir(), "outbox-"));
        outside = fs.mkdtempSync(join(os.tmpdir(), "other-"));
        fs.writeFileSync(join(root, "list.xlsx"), "x");
        fs.writeFileSync(join(outside, "secret.json"), "{}");
    });
    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    it("accepts a file in the folder", () => {
        assert.deepEqual(filesInside([join(root, "list.xlsx")], root), [fs.realpathSync(join(root, "list.xlsx"))]);
    });
    it("refuses a file outside it, also through ..", () => {
        assert.throws(() => filesInside([join(outside, "secret.json")], root), /outside/);
        assert.throws(
            () => filesInside([join(root, "..", outside.split(/[\\/]/).pop(), "secret.json")], root),
            /outside/,
        );
    });
    it("refuses a missing file, a folder and a missing outbox", () => {
        assert.throws(() => filesInside([join(root, "nope.pdf")], root), /not found/);
        fs.mkdirSync(join(root, "sub"));
        assert.throws(() => filesInside([join(root, "sub")], root), /Not a file/);
        assert.throws(() => filesInside(["a"], join(root, "missing")), /does not exist/);
    });
});
