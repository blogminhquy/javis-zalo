import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    canOpenGui,
    downloadMedia,
    guessExtension,
    isDownloadableMedia,
    normalizeMediaKind,
    sanitize,
    sniffMediaBuffer,
    validateMediaPayload,
    validateMediaUrl,
    verifyLocalMediaFile,
} from "./media-downloader.js";

const FIXTURES_DIR = process.env.ZALO_MEDIA_FIXTURES_DIR || "";
const HAS_FIXTURES = Boolean(FIXTURES_DIR && existsSync(join(FIXTURES_DIR, "manifest.json")));

/** Minimal valid headers for synthetic tests */
const SAMPLE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const SAMPLE_MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00]);
const SAMPLE_M4A = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00]);
const SAMPLE_HTML_403 = Buffer.from(
    "<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>Expired</body></html>",
);

function makeResponse({ status = 200, headers = {}, body = Buffer.alloc(0) } = {}) {
    const normalizedHeaders = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: (name) => normalizedHeaders.get(String(name).toLowerCase()) ?? null,
        },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
}

describe("isDownloadableMedia & normalizeMediaKind (Trap 1: zca-js raw msgType support)", () => {
    it("returns true for normalized media types", () => {
        for (const t of ["image", "audio", "voice", "video", "gif", "file"]) {
            assert.equal(isDownloadableMedia(t), true, `expected ${t} to be downloadable`);
        }
    });

    it("returns true for raw zca-js msgType values", () => {
        assert.equal(normalizeMediaKind("chat.photo"), "image");
        assert.equal(normalizeMediaKind("chat.voice"), "voice");
        assert.equal(normalizeMediaKind("chat.video.msg"), "video");
        assert.equal(normalizeMediaKind("share.file"), "file");
        assert.equal(normalizeMediaKind("chat.gif"), "gif");

        for (const t of ["chat.photo", "chat.voice", "chat.video.msg", "share.file", "chat.gif"]) {
            assert.equal(isDownloadableMedia(t), true, `expected raw msgType ${t} to be downloadable`);
        }
    });

    it("returns false for non-media types", () => {
        for (const t of ["text", "link", "sticker", "chat.sticker", "webchat", undefined, null, ""]) {
            assert.equal(isDownloadableMedia(t), false);
        }
    });

    it("guesses fallback extensions for raw zca-js msgTypes when URL has no extension", () => {
        assert.equal(guessExtension("https://cdn.zalo.me/media/123", "", "chat.photo"), "jpg");
        assert.equal(guessExtension("https://cdn.zalo.me/media/123", "", "chat.voice"), "mp3");
        assert.equal(guessExtension("https://cdn.zalo.me/media/123", "", "chat.video.msg"), "mp4");
        assert.equal(guessExtension("https://cdn.zalo.me/media/123", "", "chat.gif"), "gif");
        assert.equal(guessExtension("https://cdn.zalo.me/media/123", "", "share.file"), "bin");
    });
});

describe("sanitize (Trap 2: traversal & control-char safety)", () => {
    it("rejects dot segments and path separators", () => {
        assert.equal(sanitize(".."), "unknown");
        assert.equal(sanitize("."), "unknown");
        assert.equal(sanitize("..."), "unknown");
        assert.equal(sanitize("../etc/passwd"), "_etc_passwd");
        assert.equal(sanitize("..\\..\\Windows"), "___Windows");
        assert.equal(sanitize(""), "unknown");
        assert.equal(sanitize(null), "unknown");
    });
});

describe("validateMediaUrl & canOpenGui", () => {
    it("accepts public HTTPS URLs and rejects HTTP, credentials, localhost, private IPs, and IPv4-mapped/link-local IPv6", () => {
        assert.equal(validateMediaUrl("https://cdn.zalo.me/photo.jpg"), "https://cdn.zalo.me/photo.jpg");
        assert.throws(() => validateMediaUrl("http://cdn.zalo.me/photo.jpg"), /only HTTPS/);
        assert.throws(() => validateMediaUrl("https://user:pass@cdn.zalo.me/photo.jpg"), /credentials/);
        assert.throws(() => validateMediaUrl("https://localhost/photo.jpg"), /unsafe or private/);
        assert.throws(() => validateMediaUrl("https://127.0.0.1/photo.jpg"), /unsafe or private/);
        assert.throws(() => validateMediaUrl("https://10.0.0.1/photo.jpg"), /unsafe or private/);
        assert.throws(() => validateMediaUrl("https://192.168.1.1/photo.jpg"), /unsafe or private/);
        assert.throws(() => validateMediaUrl("https://172.20.0.1/photo.jpg"), /unsafe or private/);
        assert.throws(() => validateMediaUrl("https://169.254.169.254/latest"), /unsafe or private/);
        assert.throws(() => validateMediaUrl("https://[::1]/photo.jpg"), /unsafe or private/);
        assert.throws(() => validateMediaUrl("https://[::ffff:127.0.0.1]/a.jpg"), /unsafe or private/);
        assert.throws(() => validateMediaUrl("https://[::ffff:169.254.169.254]/a.jpg"), /unsafe or private/);
        assert.throws(() => validateMediaUrl("https://[::ffff:10.0.0.1]/a.jpg"), /unsafe or private/);
        assert.throws(() => validateMediaUrl("https://[fe90::1]/a.jpg"), /unsafe or private/);
    });

    it("never leaks signed query tokens in URL validation or network fetch errors", async () => {
        const secretToken = "SECRET_TOKEN_998877";
        try {
            validateMediaUrl(`http://cdn.zalo.me/file.jpg?token=${secretToken}`);
            assert.fail("should have thrown");
        } catch (e) {
            assert.equal(e.message.includes(secretToken), false);
        }

        const dir = mkdtempSync(join(tmpdir(), "zalo-media-neterr-"));
        try {
            const msg = {
                id: "msg_neterr",
                threadId: "t1",
                threadType: "dm",
                senderName: "Alice",
                timestamp: 1710000000000,
                type: "chat.photo",
                attachment: { url: `https://cdn.zalo.me/file.jpg?token=${secretToken}` },
            };
            await assert.rejects(
                downloadMedia(msg, {
                    downloadDir: dir,
                    fetch: async (url) => {
                        throw new TypeError(`fetch failed for ${url}`);
                    },
                }),
                (err) => {
                    assert.match(err.message, /Download failed: network error/);
                    assert.equal(err.message.includes(secretToken), false);
                    assert.equal(err.message.includes("cdn.zalo.me"), false);
                    return true;
                },
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("disables GUI viewer on headless Linux without DISPLAY or WAYLAND_DISPLAY", () => {
        assert.equal(canOpenGui("linux", {}), false);
        assert.equal(canOpenGui("linux", { DISPLAY: ":0" }), true);
        assert.equal(canOpenGui("linux", { WAYLAND_DISPLAY: "wayland-0" }), true);
        assert.equal(canOpenGui("darwin", {}), true);
    });
});

describe("downloadMedia hardened pipeline", () => {
    it("rejects 0-byte responses without leaving any file on disk", async () => {
        const dir = mkdtempSync(join(tmpdir(), "zalo-media-0b-"));
        try {
            const msg = {
                id: "msg0001",
                threadId: "t1",
                threadType: "dm",
                senderName: "Alice",
                timestamp: 1710000000000,
                type: "chat.photo",
                attachment: { url: "https://cdn.zalo.me/empty.jpg" },
            };
            await assert.rejects(
                downloadMedia(msg, {
                    downloadDir: dir,
                    fetch: async () =>
                        makeResponse({ status: 200, headers: { "content-type": "image/jpeg" }, body: Buffer.alloc(0) }),
                }),
                /empty \(0 bytes\)/,
            );
            const threadDir = join(dir, "DM_Alice");
            const files = existsSync(threadDir) ? readdirSync(threadDir) : [];
            assert.deepEqual(files, []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects HTML error page disguised as .jpg without saving a corrupt file", async () => {
        const dir = mkdtempSync(join(tmpdir(), "zalo-media-html-"));
        try {
            const msg = {
                id: "msg0002",
                threadId: "t1",
                threadType: "dm",
                senderName: "Alice",
                timestamp: 1710000000000,
                type: "chat.photo",
                attachment: { url: "https://cdn.zalo.me/expired.jpg" },
            };
            await assert.rejects(
                downloadMedia(msg, {
                    downloadDir: dir,
                    fetch: async () =>
                        makeResponse({
                            status: 200,
                            headers: { "content-type": "application/octet-stream" },
                            body: SAMPLE_HTML_403,
                        }),
                }),
                /HTML\/XML error body/,
            );
            const threadDir = join(dir, "DM_Alice");
            const files = existsSync(threadDir) ? readdirSync(threadDir) : [];
            assert.deepEqual(files, []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects static image payload when message type is video (anti-thumbnail-masquerade)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "zalo-media-thumb-"));
        try {
            const msg = {
                id: "msg0003",
                threadId: "t1",
                threadType: "dm",
                senderName: "Alice",
                timestamp: 1710000000000,
                type: "chat.video.msg",
                attachment: { url: "https://cdn.zalo.me/thumb.jpg" },
            };
            await assert.rejects(
                downloadMedia(msg, {
                    downloadDir: dir,
                    fetch: async () =>
                        makeResponse({
                            status: 200,
                            headers: { "content-type": "image/jpeg" },
                            body: SAMPLE_JPEG,
                        }),
                }),
                /static image\/thumbnail instead of video/,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects oversized media exceeding maxBytes and aborts chunked streams without Content-Length", async () => {
        const dir = mkdtempSync(join(tmpdir(), "zalo-media-big-"));
        try {
            const msg = {
                id: "msg0004",
                threadId: "t1",
                threadType: "dm",
                senderName: "Alice",
                timestamp: 1710000000000,
                type: "chat.photo",
                attachment: { url: "https://cdn.zalo.me/big.jpg" },
            };
            await assert.rejects(
                downloadMedia(msg, {
                    downloadDir: dir,
                    maxBytes: 8,
                    fetch: async () =>
                        makeResponse({
                            status: 200,
                            headers: { "content-type": "image/jpeg" },
                            body: SAMPLE_JPEG,
                        }),
                }),
                /exceeds size limit/,
            );

            let chunksRead = 0;
            let canceled = false;
            await assert.rejects(
                downloadMedia(msg, {
                    downloadDir: dir,
                    maxBytes: 10,
                    fetch: async () => ({
                        ok: true,
                        status: 200,
                        headers: { get: () => null },
                        body: {
                            getReader() {
                                return {
                                    async read() {
                                        chunksRead++;
                                        if (chunksRead > 5) return { done: true, value: undefined };
                                        return { done: false, value: new Uint8Array(6) };
                                    },
                                    async cancel() {
                                        canceled = true;
                                    },
                                };
                            },
                        },
                    }),
                }),
                /exceeds size limit/,
            );
            assert.equal(chunksRead, 2);
            assert.equal(canceled, true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("validates redirect hops and blocks redirects to private IPs", async () => {
        const dir = mkdtempSync(join(tmpdir(), "zalo-media-redir-"));
        try {
            const msg = {
                id: "msg0005",
                threadId: "t1",
                threadType: "dm",
                senderName: "Alice",
                timestamp: 1710000000000,
                type: "chat.photo",
                attachment: { url: "https://cdn.zalo.me/start.jpg" },
            };
            await assert.rejects(
                downloadMedia(msg, {
                    downloadDir: dir,
                    fetch: async () =>
                        makeResponse({
                            status: 302,
                            headers: { location: "https://127.0.0.1/secret.jpg" },
                        }),
                }),
                /unsafe or private host/,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects symlinked download directory and prevents path traversal when threadName is '..'", async () => {
        const root = mkdtempSync(join(tmpdir(), "zalo-media-sym-"));
        const realDir = join(root, "real");
        const symDir = join(root, "link");
        try {
            writeFileSync(join(root, "marker.txt"), "safe");
            symlinkSync(root, symDir);
            const msg = {
                id: "msg0006",
                threadId: "..",
                threadType: "group",
                senderName: "..",
                timestamp: 1710000000000,
                type: "chat.photo",
                attachment: { url: "https://cdn.zalo.me/photo.jpg" },
            };
            await assert.rejects(
                downloadMedia(msg, {
                    downloadDir: symDir,
                    threadName: "..",
                    fetch: async () => makeResponse({ status: 200, body: SAMPLE_JPEG }),
                }),
                /symlink/,
            );

            const res = await downloadMedia(msg, {
                downloadDir: realDir,
                threadName: "..",
                fetch: async () => makeResponse({ status: 200, body: SAMPLE_JPEG }),
            });
            assert.equal(res.folder, "unknown");
            assert.equal(res.path.startsWith(realDir), true);
            assert.equal(res.bytes, SAMPLE_JPEG.length);
            assert.equal(res.mimeType, "image/jpeg");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("downloads valid JPEG, M4A, and MP4 atomically and populates bytes + mimeType", async () => {
        const dir = mkdtempSync(join(tmpdir(), "zalo-media-ok-"));
        try {
            for (const [type, body, expectedMime, expectedExt] of [
                ["chat.photo", SAMPLE_JPEG, "image/jpeg", ".jpg"],
                ["chat.voice", SAMPLE_M4A, "audio/mp4", ".m4a"],
                ["chat.video.msg", SAMPLE_MP4, "video/mp4", ".mp4"],
            ]) {
                const msg = {
                    id: `id_${type}`,
                    threadId: "g1",
                    threadType: "group",
                    senderName: "Cong",
                    timestamp: 1710000000000,
                    type,
                    attachment: { url: "https://cdn.zalo.me/asset" },
                };
                const res = await downloadMedia(msg, {
                    downloadDir: dir,
                    threadName: "Test Group",
                    fetch: async () => makeResponse({ status: 200, body }),
                });
                assert.equal(res.success, true);
                assert.equal(res.bytes, body.length);
                assert.equal(res.mimeType, expectedMime);
                assert.equal(res.path.endsWith(expectedExt), true);
                assert.equal(msg.attachment.localPath, res.path);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("E2E multimodal ground-truth fixtures (#12)", { skip: !HAS_FIXTURES }, () => {
    it("accepts all positive fixtures (OCR image, Vietnamese voice .m4a/.mp3, temporal video .mp4)", async () => {
        const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8"));
        const dir = mkdtempSync(join(tmpdir(), "zalo-fixtures-pos-"));
        try {
            const pos = manifest.positive_fixtures;
            const cases = [
                ["chat.photo", pos.image_ocr, "image/jpeg", ".jpg"],
                ["chat.voice", pos.voice_audio_m4a, "audio/mp4", ".m4a"],
                ["chat.voice", pos.voice_audio_mp3, "audio/mpeg", ".mp3"],
                ["chat.video.msg", pos.video_temporal_multimodal, "video/mp4", ".mp4"],
            ];
            for (const [msgType, fixture, expectedMime, expectedExt] of cases) {
                const payload = readFileSync(fixture.path);
                const sniffed = sniffMediaBuffer(payload);
                assert.ok(sniffed, `expected magic bytes of ${fixture.filename} to be recognized`);
                assert.equal(sniffed.mimeType, expectedMime);

                const msg = {
                    id: fixture.filename,
                    threadId: "1000000000000000001",
                    threadType: "group",
                    senderName: "FixtureTester",
                    timestamp: 1710000000000,
                    type: msgType,
                    attachment: {
                        type: msgType,
                        url: `https://cdn.zalo.me/${fixture.filename}`,
                        fileName: fixture.filename,
                        fileSize: fixture.bytes,
                    },
                };
                const res = await downloadMedia(msg, {
                    downloadDir: dir,
                    threadName: "Test Group",
                    fetch: async () =>
                        makeResponse({
                            status: 200,
                            headers: { "content-type": fixture.mime_type },
                            body: payload,
                        }),
                });
                assert.equal(res.success, true);
                assert.equal(res.bytes, fixture.bytes);
                assert.equal(res.mimeType, expectedMime);
                assert.equal(res.path.endsWith(expectedExt), true);

                const verified = verifyLocalMediaFile(res.path, msgType);
                assert.equal(verified.bytes, fixture.bytes);
                assert.equal(verified.mimeType, expectedMime);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects all negative fixtures (0-byte, HTML 403 disguised as .jpg, unsupported .xyz)", async () => {
        const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8"));
        const neg = manifest.negative_fixtures;
        const dir = mkdtempSync(join(tmpdir(), "zalo-fixtures-neg-"));
        try {
            // 1. 0-byte empty_zero_byte.jpg
            const zeroBytes = readFileSync(neg.empty_zero_byte.path);
            assert.equal(zeroBytes.length, 0);
            await assert.rejects(
                downloadMedia(
                    {
                        id: "neg_0b",
                        threadId: "t1",
                        threadType: "dm",
                        senderName: "Tester",
                        timestamp: 1710000000000,
                        type: "chat.photo",
                        attachment: { url: "https://cdn.zalo.me/empty_zero_byte.jpg" },
                    },
                    {
                        downloadDir: dir,
                        fetch: async () => makeResponse({ status: 200, body: zeroBytes }),
                    },
                ),
                /empty \(0 bytes\)/,
            );
            assert.throws(() => verifyLocalMediaFile(neg.empty_zero_byte.path, "chat.photo"), /empty \(0 bytes\)/);

            // 2. HTML 403 corrupt_not_an_image.jpg
            const htmlBytes = readFileSync(neg.corrupt_disguised_html.path);
            await assert.rejects(
                downloadMedia(
                    {
                        id: "neg_html",
                        threadId: "t1",
                        threadType: "dm",
                        senderName: "Tester",
                        timestamp: 1710000000000,
                        type: "chat.photo",
                        attachment: { url: "https://cdn.zalo.me/corrupt_not_an_image.jpg" },
                    },
                    {
                        downloadDir: dir,
                        fetch: async () => makeResponse({ status: 200, body: htmlBytes }),
                    },
                ),
                /HTML\/XML error body/,
            );
            assert.throws(
                () => verifyLocalMediaFile(neg.corrupt_disguised_html.path, "chat.photo"),
                /HTML\/XML error body/,
            );

            // 3. Unsupported archive unsupported_archive.xyz
            const xyzBytes = readFileSync(neg.unsupported_format.path);
            assert.throws(
                () =>
                    validateMediaPayload(
                        xyzBytes,
                        "application/octet-stream",
                        "share.file",
                        "https://cdn.zalo.me/unsupported_archive.xyz",
                        "unsupported_archive.xyz",
                    ),
                /Unsupported or unrecognized file format/,
            );
            assert.throws(
                () => verifyLocalMediaFile(neg.unsupported_format.path, "share.file"),
                /Unsupported or unrecognized file format/,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
