import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { __setSessionForTests, clearSession } from "../core/zalo-client.js";
import { registerMsgCommands } from "../commands/msg.js";
import { registerTools } from "./mcp-tools.js";
import {
    assertHttpsUrl,
    assertValidTtl,
    assertValidVideoDuration,
    redactUrls,
    sendVideoMessage,
} from "./send-video.js";

const SIGNED_VIDEO_URL =
    "https://cdn.example.com/videos/lesson%2F01.mp4?X-Amz-Signature=SECRET_VIDEO_SIG_111&token=TOK_VID_222";
const SIGNED_THUMB_URL =
    "https://cdn.example.com/thumbs/lesson%2F01.jpg?X-Amz-Signature=SECRET_THUMB_SIG_333&token=TOK_THB_444";
const HTTP_VIDEO_URL = "http://cdn.example.com/videos/lesson.mp4?X-Amz-Signature=SECRET_HTTP_VID_555";
const HTTP_THUMB_URL = "http://cdn.example.com/thumbs/lesson.jpg?X-Amz-Signature=SECRET_HTTP_THB_666";
const CLI = resolve(import.meta.dirname, "../index.js");

function fakeApi(calls, { msgId = 9901, failWith = null } = {}) {
    return {
        sendVideo: async (opts, threadId, type) => {
            calls.push(["video", opts, threadId, type]);
            if (failWith) throw new Error(failWith);
            return msgId === null ? {} : { msgId };
        },
    };
}

function registerHandlers(api) {
    const handlers = {};
    registerTools({ registerTool: (name, _spec, fn) => (handlers[name] = fn) }, api, {}, {}, {}, null, null, null);
    return handlers;
}

async function captureConsole(fn) {
    const stdout = [];
    const stderr = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => stdout.push(args.join(" "));
    console.error = (...args) => stderr.push(args.join(" "));
    try {
        const value = await fn();
        return { value, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    } finally {
        console.log = origLog;
        console.error = origErr;
    }
}

describe("send-video validators", () => {
    it("accepts https URLs without mutating percent-encoding and rejects non-https without leaking secrets", () => {
        assert.equal(assertHttpsUrl(SIGNED_VIDEO_URL, "videoUrl"), SIGNED_VIDEO_URL);
        assert.equal(assertHttpsUrl(SIGNED_THUMB_URL, "thumbnailUrl"), SIGNED_THUMB_URL);

        for (const [candidate, label] of [
            [HTTP_VIDEO_URL, "videoUrl"],
            [HTTP_THUMB_URL, "thumbnailUrl"],
            ["file:///tmp/a.mp4?sig=SECRET_FILE", "videoUrl"],
            ["not-a-url?sig=SECRET_MALFORMED", "thumbnailUrl"],
            ["", "videoUrl"],
        ]) {
            assert.throws(
                () => assertHttpsUrl(candidate, label),
                (err) => {
                    assert.match(err.message, new RegExp(label));
                    assert.doesNotMatch(err.message, /SECRET_/);
                    return true;
                },
            );
        }
    });

    it("hard-blocks group (threadType=1) duration when missing, 0, negative, float, or NaN", () => {
        for (const bad of [undefined, 0, -1, -5000, Number.NaN, Number.POSITIVE_INFINITY, 12.5, "5000", null]) {
            assert.throws(
                () => assertValidVideoDuration(bad, 1),
                /Group sendVideo requires duration > 0 \(milliseconds\)\./,
            );
        }
        assert.equal(assertValidVideoDuration(5500, 1), 5500);
    });

    it("allows optional or 0 duration for DM (threadType=0), rejecting negative/NaN", () => {
        assert.equal(assertValidVideoDuration(undefined, 0), 0);
        assert.equal(assertValidVideoDuration(0, 0), 0);
        assert.equal(assertValidVideoDuration(4200, 0), 4200);
        for (const bad of [-1, Number.NaN, 1.5]) {
            assert.throws(() => assertValidVideoDuration(bad, 0), /duration must be a non-negative integer/);
        }
    });

    it("validates ttl >= 0 and redacts signed URLs", () => {
        assert.equal(assertValidTtl(0), 0);
        assert.throws(() => assertValidTtl(-1), /ttl must be a non-negative integer/);
        const clean = redactUrls(`Failed: ${SIGNED_VIDEO_URL} / ${SIGNED_THUMB_URL}`, [
            SIGNED_VIDEO_URL,
            SIGNED_THUMB_URL,
        ]);
        assert.doesNotMatch(clean, /SECRET_VIDEO_SIG_111/);
        assert.doesNotMatch(clean, /SECRET_THUMB_SIG_333/);
        assert.doesNotMatch(clean, /TOK_VID_222/);
        assert.doesNotMatch(clean, /TOK_THB_444/);
    });
});

describe("sendVideoMessage", () => {
    it("sends DM video with default duration 0 and dimensions 1280x720", async () => {
        const calls = [];
        const r = await sendVideoMessage(fakeApi(calls, { msgId: 7001 }), {
            threadId: "u100",
            videoUrl: SIGNED_VIDEO_URL,
            thumbnailUrl: SIGNED_THUMB_URL,
        });
        assert.deepEqual(r, {
            success: true,
            messageId: "7001",
            threadId: "u100",
            threadType: 0,
        });
        assert.deepEqual(calls[0], [
            "video",
            {
                videoUrl: SIGNED_VIDEO_URL,
                thumbnailUrl: SIGNED_THUMB_URL,
                msg: "",
                duration: 0,
                width: 1280,
                height: 720,
                ttl: 0,
            },
            "u100",
            0,
        ]);
    });

    it("blocks group sendVideo BEFORE calling API when duration is missing, 0, negative, or NaN", async () => {
        const calls = [];
        const api = fakeApi(calls);
        for (const badDuration of [undefined, 0, -100, Number.NaN]) {
            await assert.rejects(
                sendVideoMessage(api, {
                    threadId: "g200",
                    videoUrl: SIGNED_VIDEO_URL,
                    thumbnailUrl: SIGNED_THUMB_URL,
                    threadType: 1,
                    duration: badDuration,
                }),
                /Group sendVideo requires duration > 0 \(milliseconds\)\./,
            );
        }
        assert.equal(calls.length, 0);
    });

    it("sends group video when duration > 0 and custom width/height/caption/ttl are supplied", async () => {
        const calls = [];
        const r = await sendVideoMessage(fakeApi(calls, { msgId: 7002 }), {
            threadId: "g200",
            videoUrl: SIGNED_VIDEO_URL,
            thumbnailUrl: SIGNED_THUMB_URL,
            caption: "Bai tap hom nay",
            duration: 15400,
            width: 720,
            height: 1280,
            ttl: 60000,
            threadType: 1,
        });
        assert.deepEqual(r, {
            success: true,
            messageId: "7002",
            threadId: "g200",
            threadType: 1,
        });
        assert.deepEqual(calls[0], [
            "video",
            {
                videoUrl: SIGNED_VIDEO_URL,
                thumbnailUrl: SIGNED_THUMB_URL,
                msg: "Bai tap hom nay",
                duration: 15400,
                width: 720,
                height: 1280,
                ttl: 60000,
            },
            "g200",
            1,
        ]);
    });

    it("redacts signed videoUrl and thumbnailUrl if upstream zca-js error echoes them", async () => {
        const calls = [];
        await assert.rejects(
            sendVideoMessage(
                fakeApi(calls, {
                    failWith: `Unable to get video content: ${SIGNED_VIDEO_URL} thumb=${SIGNED_THUMB_URL}`,
                }),
                {
                    threadId: "u1",
                    videoUrl: SIGNED_VIDEO_URL,
                    thumbnailUrl: SIGNED_THUMB_URL,
                },
            ),
            (err) => {
                assert.match(err.message, /Unable to get video content/);
                assert.doesNotMatch(err.message, /SECRET_VIDEO_SIG_111/);
                assert.doesNotMatch(err.message, /SECRET_THUMB_SIG_333/);
                return true;
            },
        );
    });
});

describe("zalo_send_video MCP tool", () => {
    afterEach(() => clearSession());

    it("registers cleanly on McpServer with Zod schema", () => {
        const server = new McpServer({ name: "test", version: "1.0.0" });
        registerTools(server, fakeApi([]), {}, {}, {}, null, null, null);
    });

    it("uses live() API instance after re-login", async () => {
        const calls = [];
        const oldApi = {
            sendVideo: async (opts, tid, t) => (calls.push(["old", opts, tid, t]), { msgId: 1 }),
        };
        const newApi = {
            sendVideo: async (opts, tid, t) => (calls.push(["new", opts, tid, t]), { msgId: 2 }),
        };
        const h = registerHandlers(oldApi);
        __setSessionForTests(oldApi);
        const r1 = JSON.parse(
            (
                await h.zalo_send_video({
                    threadId: "u1",
                    videoUrl: SIGNED_VIDEO_URL,
                    thumbnailUrl: SIGNED_THUMB_URL,
                    threadType: 0,
                })
            ).content[0].text,
        );
        assert.equal(r1.messageId, "1");

        __setSessionForTests(newApi);
        const r2 = JSON.parse(
            (
                await h.zalo_send_video({
                    threadId: "g1",
                    videoUrl: SIGNED_VIDEO_URL,
                    thumbnailUrl: SIGNED_THUMB_URL,
                    duration: 8000,
                    threadType: 1,
                })
            ).content[0].text,
        );
        assert.equal(r2.messageId, "2");
        assert.deepEqual(
            calls.map((c) => c[0]),
            ["old", "new"],
        );
    });

    it("blocks group duration <= 0 / missing, http URLs, and negative ttl without logging signed URLs", async () => {
        const calls = [];
        const h = registerHandlers(fakeApi(calls, { failWith: `HEAD ${SIGNED_VIDEO_URL} failed` }));

        const grpMissing = await captureConsole(() =>
            h.zalo_send_video({
                threadId: "g1",
                videoUrl: SIGNED_VIDEO_URL,
                thumbnailUrl: SIGNED_THUMB_URL,
                threadType: 1,
            }),
        );
        assert.equal(grpMissing.value.isError, true);
        assert.match(grpMissing.value.content[0].text, /Group sendVideo requires duration > 0/);
        assert.doesNotMatch(grpMissing.stderr, /SECRET_VIDEO_SIG_111/);
        assert.doesNotMatch(grpMissing.stderr, /SECRET_THUMB_SIG_333/);

        const grpZero = await captureConsole(() =>
            h.zalo_send_video({
                threadId: "g1",
                videoUrl: SIGNED_VIDEO_URL,
                thumbnailUrl: SIGNED_THUMB_URL,
                duration: 0,
                threadType: 1,
            }),
        );
        assert.equal(grpZero.value.isError, true);
        assert.match(grpZero.value.content[0].text, /Group sendVideo requires duration > 0/);

        const badThumb = await captureConsole(() =>
            h.zalo_send_video({
                threadId: "u1",
                videoUrl: SIGNED_VIDEO_URL,
                thumbnailUrl: HTTP_THUMB_URL,
                threadType: 0,
            }),
        );
        assert.equal(badThumb.value.isError, true);
        assert.doesNotMatch(badThumb.value.content[0].text, /SECRET_HTTP_THB_666/);
        assert.doesNotMatch(badThumb.stderr, /SECRET_HTTP_THB_666/);
        assert.equal(calls.length, 0);

        const upstreamFail = await captureConsole(() =>
            h.zalo_send_video({
                threadId: "u1",
                videoUrl: SIGNED_VIDEO_URL,
                thumbnailUrl: SIGNED_THUMB_URL,
                threadType: 0,
            }),
        );
        assert.equal(upstreamFail.value.isError, true);
        assert.doesNotMatch(upstreamFail.value.content[0].text, /SECRET_VIDEO_SIG_111/);
        assert.doesNotMatch(upstreamFail.stderr, /SECRET_VIDEO_SIG_111/);
    });
});

describe("CLI msg send-video", () => {
    afterEach(() => clearSession());

    function buildProgram() {
        const program = new Command();
        program.option("--json", "JSON output");
        registerMsgCommands(program);
        return program;
    }

    it("preserves backward-compatible --json output for DM and Group without logging signed URLs", async () => {
        const calls = [];
        __setSessionForTests(fakeApi(calls, { msgId: 4455 }));

        const dmJson = await captureConsole(() =>
            buildProgram().parseAsync([
                "node",
                "javis-zalo",
                "--json",
                "msg",
                "send-video",
                "u10",
                SIGNED_VIDEO_URL,
                "--thumb",
                SIGNED_THUMB_URL,
                "-W",
                "1920",
                "-H",
                "1080",
            ]),
        );
        assert.deepEqual(JSON.parse(dmJson.stdout), { msgId: 4455 });
        assert.doesNotMatch(dmJson.stdout, /SECRET_VIDEO_SIG_111/);
        assert.doesNotMatch(dmJson.stderr, /SECRET_VIDEO_SIG_111/);
        assert.doesNotMatch(dmJson.stderr, /SECRET_THUMB_SIG_333/);
        assert.deepEqual(calls[0], [
            "video",
            {
                videoUrl: SIGNED_VIDEO_URL,
                thumbnailUrl: SIGNED_THUMB_URL,
                msg: "",
                duration: 0,
                width: 1920,
                height: 1080,
                ttl: 0,
            },
            "u10",
            0,
        ]);

        const grpJson = await captureConsole(() =>
            buildProgram().parseAsync([
                "node",
                "javis-zalo",
                "--json",
                "msg",
                "send-video",
                "g10",
                SIGNED_VIDEO_URL,
                "--thumb",
                SIGNED_THUMB_URL,
                "-t",
                "1",
                "-d",
                "9500",
                "-m",
                "Demo",
                "--ttl",
                "30000",
            ]),
        );
        assert.deepEqual(JSON.parse(grpJson.stdout), { msgId: 4455 });
        assert.deepEqual(calls[1][1].duration, 9500);
        assert.deepEqual(calls[1][1].ttl, 30000);
        assert.equal(calls[1][3], 1);

        const humanRun = await captureConsole(() =>
            buildProgram().parseAsync([
                "node",
                "javis-zalo",
                "msg",
                "send-video",
                "u10",
                SIGNED_VIDEO_URL,
                "--thumb",
                SIGNED_THUMB_URL,
            ]),
        );
        assert.doesNotMatch(humanRun.stderr, /SECRET_VIDEO_SIG_111/);
        assert.doesNotMatch(humanRun.stderr, /SECRET_THUMB_SIG_333/);
        assert.match(humanRun.stderr, /Video sent to u10/);
    });

    it("hard-blocks group (-t 1) without duration > 0 in CLI before calling getApi()", async () => {
        const calls = [];
        __setSessionForTests(fakeApi(calls));

        for (const extraArgs of [[], ["-d", "0"], ["-d", "-500"], ["-d", "abc"]]) {
            const res = await captureConsole(() =>
                buildProgram().parseAsync([
                    "node",
                    "javis-zalo",
                    "--json",
                    "msg",
                    "send-video",
                    "g10",
                    SIGNED_VIDEO_URL,
                    "--thumb",
                    SIGNED_THUMB_URL,
                    "-t",
                    "1",
                    ...extraArgs,
                ]),
            );
            assert.equal(res.stdout, "");
            assert.match(res.stderr, /Group sendVideo requires duration > 0 \(milliseconds\)\./);
            assert.doesNotMatch(res.stderr, /SECRET_VIDEO_SIG_111/);
            assert.doesNotMatch(res.stderr, /SECRET_THUMB_SIG_333/);
        }
        assert.equal(calls.length, 0);

        const outSubproc = execFileSync(
            "node",
            [CLI, "--json", "msg", "send-video", "g10", SIGNED_VIDEO_URL, "--thumb", SIGNED_THUMB_URL, "-t", "1"],
            {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env, HOME: join(tmpdir(), "javis-zalo-video-cli-test") },
            },
        );
        assert.equal(outSubproc, "");
    });
});
