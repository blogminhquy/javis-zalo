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
import { assertHttpsUrl, assertValidTtl, redactUrls, sendVoiceMessage } from "./send-voice.js";

const SIGNED_VOICE_URL =
    "https://cdn.example.com/audio/clip%2F01.m4a?X-Amz-Signature=SECRET_VOICE_SIG_999&token=TOK_VOICE_777";
const HTTP_SIGNED_URL = "http://cdn.example.com/audio/clip.m4a?X-Amz-Signature=SECRET_HTTP_SIG_888";
const CLI = resolve(import.meta.dirname, "../index.js");

function fakeApi(calls, { msgId = "v101", failWith = null } = {}) {
    return {
        sendVoice: async (opts, threadId, type) => {
            calls.push(["voice", opts, threadId, type]);
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

describe("assertHttpsUrl and assertValidTtl", () => {
    it("accepts valid https URL without mutating percent-encoding", () => {
        assert.equal(assertHttpsUrl(SIGNED_VOICE_URL, "voiceUrl"), SIGNED_VOICE_URL);
    });

    it("rejects http, file, empty, whitespace, and malformed URLs without leaking query secrets", () => {
        const badInputs = [
            HTTP_SIGNED_URL,
            "file:///etc/passwd?sig=SECRET_FILE_SIG",
            "ftp://cdn.example.com/a.m4a?sig=SECRET_FTP_SIG",
            "not-a-url?sig=SECRET_BAD_SIG",
            "https://cdn.example.com/has space.m4a?sig=SECRET_SPACE_SIG",
            "",
            "   ",
            null,
        ];
        for (const candidate of badInputs) {
            assert.throws(
                () => assertHttpsUrl(candidate, "voiceUrl"),
                (err) => {
                    assert.match(err.message, /voiceUrl/);
                    assert.doesNotMatch(err.message, /SECRET_/);
                    assert.doesNotMatch(err.message, /X-Amz-Signature/);
                    return true;
                },
            );
        }
    });

    it("validates ttl >= 0 integer and rejects negative, NaN, float, or non-number", () => {
        assert.equal(assertValidTtl(), 0);
        assert.equal(assertValidTtl(0), 0);
        assert.equal(assertValidTtl(60000), 60000);
        for (const bad of [-1, -100, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "0", null]) {
            assert.throws(() => assertValidTtl(bad), /ttl must be a non-negative integer/);
        }
    });

    it("redactUrls strips full URLs and query secrets", () => {
        const dirty = `Fetch failed for ${SIGNED_VOICE_URL} (query ?X-Amz-Signature=SECRET_VOICE_SIG_999&token=TOK_VOICE_777)`;
        const clean = redactUrls(dirty, [SIGNED_VOICE_URL]);
        assert.doesNotMatch(clean, /SECRET_VOICE_SIG_999/);
        assert.doesNotMatch(clean, /TOK_VOICE_777/);
        assert.doesNotMatch(clean, /cdn\.example\.com/);
    });
});

describe("sendVoiceMessage", () => {
    it("sends voice to DM and group with normalized response", async () => {
        const calls = [];
        const dmRes = await sendVoiceMessage(fakeApi(calls, { msgId: 8899 }), {
            threadId: "u123",
            voiceUrl: SIGNED_VOICE_URL,
        });
        assert.deepEqual(dmRes, {
            success: true,
            messageId: "8899",
            threadId: "u123",
            threadType: 0,
        });
        assert.deepEqual(calls[0], ["voice", { voiceUrl: SIGNED_VOICE_URL, ttl: 0 }, "u123", 0]);

        const grpRes = await sendVoiceMessage(fakeApi(calls, { msgId: null }), {
            threadId: "g456",
            voiceUrl: SIGNED_VOICE_URL,
            threadType: 1,
            ttl: 30000,
        });
        assert.deepEqual(grpRes, {
            success: true,
            messageId: null,
            threadId: "g456",
            threadType: 1,
        });
        assert.deepEqual(calls[1], ["voice", { voiceUrl: SIGNED_VOICE_URL, ttl: 30000 }, "g456", 1]);
    });

    it("rejects invalid threadId or threadType before calling API", async () => {
        const calls = [];
        await assert.rejects(
            sendVoiceMessage(fakeApi(calls), { threadId: "", voiceUrl: SIGNED_VOICE_URL }),
            /threadId/,
        );
        await assert.rejects(
            sendVoiceMessage(fakeApi(calls), { threadId: "u1", voiceUrl: SIGNED_VOICE_URL, threadType: 2 }),
            /threadType/,
        );
        assert.equal(calls.length, 0);
    });

    it("redacts signed URL if upstream zca-js error includes it", async () => {
        const calls = [];
        await assert.rejects(
            sendVoiceMessage(
                fakeApi(calls, { failWith: `Unable to get voice content: ${SIGNED_VOICE_URL} timed out` }),
                { threadId: "u1", voiceUrl: SIGNED_VOICE_URL },
            ),
            (err) => {
                assert.match(err.message, /Unable to get voice content/);
                assert.doesNotMatch(err.message, /SECRET_VOICE_SIG_999/);
                assert.doesNotMatch(err.message, /TOK_VOICE_777/);
                return true;
            },
        );
    });
});

describe("zalo_send_voice MCP tool", () => {
    afterEach(() => clearSession());

    it("registers cleanly on McpServer with Zod schema", () => {
        const server = new McpServer({ name: "test", version: "1.0.0" });
        registerTools(server, fakeApi([]), {}, {}, {}, null, null, null);
    });

    it("uses live() API instance after re-login", async () => {
        const calls = [];
        const oldApi = {
            sendVoice: async (opts, tid, t) => (calls.push(["old", opts, tid, t]), { msgId: "old-id" }),
        };
        const newApi = {
            sendVoice: async (opts, tid, t) => (calls.push(["new", opts, tid, t]), { msgId: "new-id" }),
        };
        const h = registerHandlers(oldApi);
        __setSessionForTests(oldApi);
        const r1 = JSON.parse(
            (await h.zalo_send_voice({ threadId: "u1", voiceUrl: SIGNED_VOICE_URL, threadType: 0, ttl: 0 })).content[0]
                .text,
        );
        assert.equal(r1.messageId, "old-id");

        __setSessionForTests(newApi);
        const r2 = JSON.parse(
            (await h.zalo_send_voice({ threadId: "g1", voiceUrl: SIGNED_VOICE_URL, threadType: 1, ttl: 5000 }))
                .content[0].text,
        );
        assert.equal(r2.messageId, "new-id");
        assert.deepEqual(
            calls.map((c) => c[0]),
            ["old", "new"],
        );
    });

    it("blocks http:// and negative/NaN ttl without logging signed URLs to console", async () => {
        const calls = [];
        const h = registerHandlers(fakeApi(calls, { failWith: `HEAD ${SIGNED_VOICE_URL} failed` }));

        const c1 = await captureConsole(() =>
            h.zalo_send_voice({ threadId: "u1", voiceUrl: HTTP_SIGNED_URL, threadType: 0, ttl: 0 }),
        );
        assert.equal(c1.value.isError, true);
        assert.doesNotMatch(c1.value.content[0].text, /SECRET_HTTP_SIG_888/);
        assert.doesNotMatch(c1.stderr, /SECRET_HTTP_SIG_888/);

        const c2 = await captureConsole(() =>
            h.zalo_send_voice({ threadId: "u1", voiceUrl: SIGNED_VOICE_URL, threadType: 0, ttl: -5 }),
        );
        assert.equal(c2.value.isError, true);
        assert.match(c2.value.content[0].text, /ttl/);
        assert.doesNotMatch(c2.stderr, /SECRET_VOICE_SIG_999/);
        assert.equal(calls.length, 0);

        const c3 = await captureConsole(() =>
            h.zalo_send_voice({ threadId: "u1", voiceUrl: SIGNED_VOICE_URL, threadType: 0, ttl: 0 }),
        );
        assert.equal(c3.value.isError, true);
        assert.doesNotMatch(c3.value.content[0].text, /SECRET_VOICE_SIG_999/);
        assert.doesNotMatch(c3.stderr, /SECRET_VOICE_SIG_999/);
    });
});

describe("CLI msg send-voice", () => {
    afterEach(() => clearSession());

    function buildProgram() {
        const program = new Command();
        program.option("--json", "JSON output");
        registerMsgCommands(program);
        return program;
    }

    it("preserves raw --json output and never logs signed URL in JSON or human mode", async () => {
        const calls = [];
        __setSessionForTests(fakeApi(calls, { msgId: "cli-v-1" }));

        const jsonRun = await captureConsole(() =>
            buildProgram().parseAsync([
                "node",
                "javis-zalo",
                "--json",
                "msg",
                "send-voice",
                "u99",
                SIGNED_VOICE_URL,
                "--ttl",
                "1200",
            ]),
        );
        assert.deepEqual(JSON.parse(jsonRun.stdout), { msgId: "cli-v-1" });
        assert.doesNotMatch(jsonRun.stdout, /SECRET_VOICE_SIG_999/);
        assert.doesNotMatch(jsonRun.stderr, /SECRET_VOICE_SIG_999/);
        assert.deepEqual(calls[0], ["voice", { voiceUrl: SIGNED_VOICE_URL, ttl: 1200 }, "u99", 0]);

        const humanRun = await captureConsole(() =>
            buildProgram().parseAsync(["node", "javis-zalo", "msg", "send-voice", "u99", SIGNED_VOICE_URL]),
        );
        assert.equal(humanRun.stdout, "");
        assert.doesNotMatch(humanRun.stderr, /SECRET_VOICE_SIG_999/);
        assert.doesNotMatch(humanRun.stderr, /cdn\.example\.com/);
        assert.match(humanRun.stderr, /Voice sent to u99/);
    });

    it("rejects http URL and invalid ttl in CLI before calling getApi()", () => {
        const outHttp = execFileSync("node", [CLI, "--json", "msg", "send-voice", "u1", HTTP_SIGNED_URL], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, HOME: join(tmpdir(), "javis-zalo-voice-cli-test") },
        });
        assert.equal(outHttp, "");
    });

    it("writes redacted error to stderr on invalid inputs without calling API", async () => {
        const calls = [];
        __setSessionForTests(fakeApi(calls));

        const badHttp = await captureConsole(() =>
            buildProgram().parseAsync(["node", "javis-zalo", "msg", "send-voice", "u1", HTTP_SIGNED_URL]),
        );
        assert.match(badHttp.stderr, /Send voice failed:.*https:\/\//);
        assert.doesNotMatch(badHttp.stderr, /SECRET_HTTP_SIG_888/);

        const badTtl = await captureConsole(() =>
            buildProgram().parseAsync([
                "node",
                "javis-zalo",
                "msg",
                "send-voice",
                "u1",
                SIGNED_VOICE_URL,
                "--ttl",
                "-10",
            ]),
        );
        assert.match(badTtl.stderr, /Send voice failed:.*ttl/);
        assert.doesNotMatch(badTtl.stderr, /SECRET_VOICE_SIG_999/);
        assert.equal(calls.length, 0);
    });
});
