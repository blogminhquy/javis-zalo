import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLabelReader, labelsOfThread, normalizeLabels, threadOfConversation } from "./labels.js";
import { registerTools } from "./mcp-tools.js";

/** Shape of a zca-js getLabels() result. */
function raw() {
    return {
        labelData: [
            { id: 2, text: "Gia đình", conversations: ["111", "g900", "111"], color: "#f00", emoji: "🏠", offset: 1 },
            { id: 1, text: "Khách hàng", conversations: ["222"], color: "#0f0", emoji: "", offset: 0 },
            { id: 3, text: "  ", conversations: ["333"] },
            null,
        ],
        version: 7,
        lastUpdateTime: 1760000000000,
    };
}

describe("threadOfConversation", () => {
    it("reads a user id and a g-prefixed group id", () => {
        assert.deepEqual(threadOfConversation("111"), { threadId: "111", threadType: 0 });
        assert.deepEqual(threadOfConversation("g900"), { threadId: "900", threadType: 1 });
        assert.equal(threadOfConversation(""), null);
        assert.equal(threadOfConversation(null), null);
    });
});

describe("normalizeLabels", () => {
    it("keeps named labels in the owner's order, threads deduplicated", () => {
        const labels = normalizeLabels(raw());
        assert.deepEqual(
            labels.map((l) => l.name),
            ["Khách hàng", "Gia đình"],
        );
        assert.deepEqual(labels[1].threads, [
            { threadId: "111", threadType: 0 },
            { threadId: "900", threadType: 1 },
        ]);
        assert.equal(labels[1].emoji, "🏠");
    });

    it("never throws on garbage", () => {
        assert.deepEqual(normalizeLabels(null), []);
        assert.deepEqual(normalizeLabels({ labelData: "x" }), []);
    });
});

describe("labelsOfThread", () => {
    it("returns the labels of one chat without member lists", () => {
        const labels = normalizeLabels(raw());
        assert.deepEqual(labelsOfThread(labels, "900"), [{ id: 2, name: "Gia đình", emoji: "🏠", color: "#f00" }]);
        assert.deepEqual(labelsOfThread(labels, "999"), []);
        assert.deepEqual(labelsOfThread(labels, ""), []);
    });
});

describe("createLabelReader", () => {
    it("caches for the ttl and refetches after it or on refresh", async () => {
        let calls = 0;
        let t = 0;
        const read = createLabelReader({ getLabels: async () => (calls++, raw()) }, { ttlSeconds: 60, now: () => t });
        assert.equal((await read()).cached, false);
        t = 59_000;
        assert.equal((await read()).cached, true);
        assert.equal(calls, 1);
        await read({ refresh: true });
        assert.equal(calls, 2);
        t = 200_000;
        await read();
        assert.equal(calls, 3);
    });

    it("shares one request between concurrent callers", async () => {
        let calls = 0;
        const read = createLabelReader({ getLabels: async () => (calls++, raw()) });
        await Promise.all([read(), read(), read()]);
        assert.equal(calls, 1);
    });

    it("a failure is not cached", async () => {
        let fail = true;
        const read = createLabelReader({
            getLabels: async () => {
                if (fail) throw new Error("boom");
                return raw();
            },
        });
        await assert.rejects(read(), /boom/);
        fail = false;
        assert.equal((await read()).labels.length, 2);
    });
});

describe("zalo_get_labels tool", () => {
    function tools(api) {
        const handlers = {};
        registerTools({ registerTool: (name, _spec, fn) => (handlers[name] = fn) }, api, {}, {}, {}, null, null, null);
        return handlers;
    }
    const parse = (r) => JSON.parse(r.content[0].text);

    it("lists every label with its chats", async () => {
        const out = parse(await tools({ getLabels: async () => raw() }).zalo_get_labels({ refresh: false }));
        assert.equal(out.count, 2);
        assert.equal(out.version, 7);
        assert.equal(out.labels[0].threads[0].threadId, "222");
    });

    it("with threadId returns only that chat's labels", async () => {
        const out = parse(
            await tools({ getLabels: async () => raw() }).zalo_get_labels({ threadId: "111", refresh: false }),
        );
        assert.equal(out.threadId, "111");
        assert.deepEqual(
            out.labels.map((l) => l.name),
            ["Gia đình"],
        );
    });

    it("a Zalo error comes back as a tool error", async () => {
        const r = await tools({
            getLabels: async () => {
                throw new Error("not logged in");
            },
        }).zalo_get_labels({ refresh: false });
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /not logged in/);
    });
});
