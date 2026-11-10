import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLivePush, pushTargetFromEnv, PUSH_EVENTS } from "./live-push.js";

const TARGET = { url: "http://127.0.0.1:7777/zalo/push?conn=c1", token: "secret" };

/** Timers the test fires by hand, so nothing waits on a real clock. */
function manualTimers() {
    const timers = [];
    return {
        setTimer(fn, ms) {
            const t = { fn, ms, fired: false };
            timers.push(t);
            return t;
        },
        timers,
        /** Fire the oldest timer not fired yet and let the send it starts settle. */
        async fire() {
            const t = timers.find((x) => !x.fired);
            assert.ok(t, "a timer is waiting");
            t.fired = true;
            t.fn();
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setImmediate(r));
            return t;
        },
        waiting: () => timers.filter((x) => !x.fired),
    };
}

function fakeFetch(answers = []) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        const a = answers.length ? answers.shift() : { ok: true, status: 200 };
        if (a instanceof Error) throw a;
        return a;
    };
    return { fetchImpl, calls };
}

describe("pushTargetFromEnv", () => {
    it("is off without JAVIS_ZALO_PUSH_URL", () => {
        assert.equal(pushTargetFromEnv({}), null);
        assert.equal(pushTargetFromEnv({ JAVIS_ZALO_PUSH_URL: "  " }), null);
    });

    it("accepts a loopback URL and carries the token", () => {
        assert.deepEqual(
            pushTargetFromEnv({
                JAVIS_ZALO_PUSH_URL: "http://127.0.0.1:7777/zalo/push?conn=a",
                JAVIS_ZALO_PUSH_TOKEN: " t ",
            }),
            { url: "http://127.0.0.1:7777/zalo/push?conn=a", token: "t" },
        );
        assert.ok(pushTargetFromEnv({ JAVIS_ZALO_PUSH_URL: "http://localhost:7777/x" }));
        assert.ok(pushTargetFromEnv({ JAVIS_ZALO_PUSH_URL: "http://[::1]:7777/x" }));
    });

    it("refuses anything that is not this machine", () => {
        for (const url of [
            "https://example.com/hook",
            "http://192.168.1.10:7777/x",
            "http://127.0.0.1.example.com/x",
            "ftp://127.0.0.1/x",
            "http://user:pass@127.0.0.1:7777/x",
            "not a url",
        ]) {
            assert.equal(pushTargetFromEnv({ JAVIS_ZALO_PUSH_URL: url }), null, url);
        }
    });
});

describe("createLivePush", () => {
    it("does nothing when there is no target", () => {
        const { fetchImpl, calls } = fakeFetch();
        const push = createLivePush({ target: null, fetchImpl });
        assert.equal(push.enabled, false);
        push.notify("messages");
        assert.deepEqual(push.pending(), []);
        assert.equal(calls.length, 0);
    });

    it("sends one request for a burst, with the token and no message content", async () => {
        const t = manualTimers();
        const { fetchImpl, calls } = fakeFetch();
        const push = createLivePush({
            target: TARGET,
            fetchImpl,
            version: "1.10.0",
            state: () => ({ cursor: 42, connected: true }),
            setTimer: t.setTimer,
        });
        for (let i = 0; i < 50; i++) push.notify("messages");
        assert.equal(t.waiting().length, 1, "one timer for the whole burst");
        await t.fire();
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, TARGET.url);
        assert.equal(calls[0].init.method, "POST");
        assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
        const body = calls[0].body;
        assert.deepEqual(body.events, ["messages"]);
        assert.equal(body.cursor, 42);
        assert.equal(body.connected, true);
        assert.equal(body.source, "javis-zalo");
        assert.equal(body.version, "1.10.0");
        assert.deepEqual(
            Object.keys(body).sort(),
            ["connected", "cursor", "events", "pid", "source", "ts", "version"],
            "a wake-up only: no text, sender or thread",
        );
        assert.deepEqual(push.pending(), []);
        assert.equal(t.waiting().length, 0, "nothing more to send");
    });

    it("merges different kinds into one request, in a fixed order", async () => {
        const t = manualTimers();
        const { fetchImpl, calls } = fakeFetch();
        const push = createLivePush({ target: TARGET, fetchImpl, setTimer: t.setTimer });
        push.notify("messages");
        push.notify("connected");
        push.notify("ready");
        push.notify("nonsense");
        await t.fire();
        assert.deepEqual(calls[0].body.events, ["ready", "messages", "connected"]);
        assert.ok(calls[0].body.events.every((e) => PUSH_EVENTS.includes(e)));
    });

    it("keeps owing a failed request and retries with a growing pause", async () => {
        const t = manualTimers();
        const { fetchImpl, calls } = fakeFetch([
            new Error("ECONNREFUSED"),
            { ok: false, status: 503 },
            { ok: true, status: 200 },
        ]);
        const push = createLivePush({ target: TARGET, fetchImpl, setTimer: t.setTimer, retryMs: [1000, 2000, 5000] });
        push.notify("messages");
        await t.fire(); // attempt 1 fails
        assert.deepEqual(push.pending(), ["messages"], "still owed");
        assert.equal(t.waiting()[0].ms, 1000);
        push.notify("disconnected"); // arrives during the pause: rides the same retry, no second timer
        assert.equal(t.waiting().length, 1);
        await t.fire(); // attempt 2 fails
        assert.equal(t.waiting()[0].ms, 2000);
        await t.fire(); // attempt 3 succeeds
        assert.equal(calls.length, 3);
        assert.deepEqual(calls[2].body.events, ["messages", "disconnected"]);
        assert.deepEqual(push.pending(), []);
        assert.equal(t.waiting().length, 0);
    });

    it("sends what arrived while a request was in flight as one more request", async () => {
        const t = manualTimers();
        const calls = [];
        let release;
        const fetchImpl = (url, init) => {
            calls.push(JSON.parse(init.body));
            return new Promise((resolve) => {
                release = () => resolve({ ok: true, status: 200 });
            });
        };
        const push = createLivePush({ target: TARGET, fetchImpl, setTimer: t.setTimer });
        push.notify("messages");
        await t.fire(); // request 1 in flight
        push.notify("messages");
        push.notify("connected");
        assert.equal(t.waiting().length, 0, "no parallel request while one is in flight");
        release();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        assert.equal(t.waiting().length, 1, "the rest is scheduled once the first is done");
        await t.fire();
        release();
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1].events, ["messages", "connected"]);
    });

    it("survives a state() that throws and never throws into the caller", async () => {
        const t = manualTimers();
        const { fetchImpl, calls } = fakeFetch();
        const push = createLivePush({
            target: TARGET,
            fetchImpl,
            setTimer: t.setTimer,
            state: () => {
                throw new Error("boom");
            },
        });
        assert.doesNotThrow(() => push.notify("messages"));
        await t.fire();
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].body.events, ["messages"]);
    });

    it("stop() drops what is pending and ignores later events", async () => {
        const t = manualTimers();
        const { fetchImpl, calls } = fakeFetch();
        const push = createLivePush({ target: TARGET, fetchImpl, setTimer: t.setTimer });
        push.notify("messages");
        push.stop();
        push.notify("messages");
        assert.deepEqual(push.pending(), []);
        for (const x of t.timers) x.fn(); // a timer that still fires after stop must not send
        await new Promise((r) => setImmediate(r));
        assert.equal(calls.length, 0);
    });
});

describe("createLivePush over a real loopback socket", () => {
    it("delivers a wake-up to a local HTTP server", async () => {
        const { createServer } = await import("node:http");
        const got = [];
        const server = createServer((req, res) => {
            let raw = "";
            req.on("data", (c) => (raw += c));
            req.on("end", () => {
                got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end('{"ok":true}');
            });
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        try {
            const target = pushTargetFromEnv({
                JAVIS_ZALO_PUSH_URL: `http://127.0.0.1:${server.address().port}/zalo/push?conn=acc-1`,
                JAVIS_ZALO_PUSH_TOKEN: "tok",
            });
            const push = createLivePush({ target, debounceMs: 5, state: () => ({ cursor: 7, connected: true }) });
            push.notify("ready");
            push.notify("messages");
            const deadline = Date.now() + 3000;
            while (!got.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
            assert.equal(got.length, 1);
            assert.equal(got[0].url, "/zalo/push?conn=acc-1");
            assert.equal(got[0].auth, "Bearer tok");
            assert.deepEqual(got[0].body.events, ["ready", "messages"]);
            assert.equal(got[0].body.cursor, 7);
            push.stop();
        } finally {
            await new Promise((r) => server.close(r));
        }
    });
});
