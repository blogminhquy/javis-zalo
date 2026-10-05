import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { openerFor, openExternal, hasExecutable } from "./open-external.js";

function fakeSpawn(exitCode = 0) {
    const calls = [];
    const fn = (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        const child = new EventEmitter();
        child.unref = () => {};
        setImmediate(() => child.emit("exit", exitCode));
        return child;
    };
    return { fn, calls };
}

describe("openerFor", () => {
    it("uses a shell-free opener per platform", () => {
        assert.equal(openerFor("darwin"), "open");
        assert.equal(openerFor("win32"), "explorer.exe");
        assert.equal(openerFor("linux"), "xdg-open");
    });
});

describe("openExternal", () => {
    it("passes a hostile URL as one argument, never through a shell", () => {
        const { fn, calls } = fakeSpawn();
        const url = 'https://example.com/?a=1&b=2" & calc & echo "$(id)';
        openExternal(url, { spawnFn: fn, os: "win32" });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].cmd, "explorer.exe");
        assert.deepEqual(calls[0].args, [url]);
        assert.equal(calls[0].opts.shell, false);
    });
});

describe("hasExecutable", () => {
    it("rejects names with shell metacharacters without spawning", async () => {
        const { fn, calls } = fakeSpawn();
        assert.equal(await hasExecutable("ngrok; rm -rf /", { spawnFn: fn, os: "linux" }), false);
        assert.equal(calls.length, 0);
    });

    it("reports presence from the finder's exit code", async () => {
        const ok = fakeSpawn(0);
        assert.equal(await hasExecutable("ngrok", { spawnFn: ok.fn, os: "linux" }), true);
        assert.deepEqual(ok.calls[0].args, ["ngrok"]);
        assert.equal(ok.calls[0].cmd, "which");
        const missing = fakeSpawn(1);
        assert.equal(await hasExecutable("ngrok", { spawnFn: missing.fn, os: "win32" }), false);
        assert.equal(missing.calls[0].cmd, "where");
    });
});
