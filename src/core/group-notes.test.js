import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    BOARD_TYPES,
    PIN_ACT,
    describeItem,
    editNote,
    listBoard,
    normalizeBoardItem,
    pinActFrom,
} from "./group-notes.js";

const note = (id, title, extra = {}) => ({
    boardType: BOARD_TYPES.note,
    data: {
        id,
        params: { title },
        creatorId: "u1",
        editorId: "u2",
        createTime: 1761500000000,
        editTime: 1761550000000,
        ...extra,
    },
});
const pinnedMsg = (id, title) => ({
    boardType: BOARD_TYPES.pin,
    data: { id, params: { title }, creatorId: "u3", editorId: "u3", createTime: 1, editTime: 2 },
});
const poll = (id, question) => ({
    boardType: BOARD_TYPES.poll,
    data: { poll_id: id, question, creator: "u4", created_time: 5, updated_time: 6 },
});

describe("pinActFrom", () => {
    it("keeps the pin unless asked", () => {
        assert.equal(pinActFrom({}), PIN_ACT.keep);
        assert.equal(pinActFrom(), PIN_ACT.keep);
    });
    it("--pin pins, --unpin unpins", () => {
        assert.equal(pinActFrom({ pin: true }), PIN_ACT.pin);
        assert.equal(pinActFrom({ unpin: true }), PIN_ACT.unpin);
    });
    it("refuses both at once", () => {
        assert.throws(() => pinActFrom({ pin: true, unpin: true }), /not both/);
    });
    it("uses Zalo's action codes: 0 none, 1 pin, 2 unpin", () => {
        assert.deepEqual({ ...PIN_ACT }, { keep: 0, pin: 1, unpin: 2 });
    });
});

describe("normalizeBoardItem", () => {
    it("reads a note: text, who wrote and edited it, when", () => {
        const r = normalizeBoardItem(note("n1", "THÔNG TIN DỊCH VỤ\nNgày cưới: 12/12"));
        assert.equal(r.id, "n1");
        assert.equal(r.type, "note");
        assert.equal(r.text, "THÔNG TIN DỊCH VỤ\nNgày cưới: 12/12");
        assert.equal(r.creatorId, "u1");
        assert.equal(r.editorId, "u2");
        assert.equal(r.editTime, 1761550000000);
        assert.equal(r.pinned, null, "the board list does not say whether a note is pinned");
    });
    it("parses params when Zalo sends them as a JSON string", () => {
        const r = normalizeBoardItem({ boardType: 1, data: { id: "n2", params: '{"title":"xin chào"}' } });
        assert.equal(r.text, "xin chào");
    });
    it("a pinned message is pinned", () => {
        const r = normalizeBoardItem(pinnedMsg("p1", "hẹn chụp 9h"));
        assert.equal(r.type, "pin");
        assert.equal(r.pinned, true);
        assert.equal(r.text, "hẹn chụp 9h");
    });
    it("reads a poll", () => {
        const r = normalizeBoardItem(poll(77, "Chọn váy nào?"));
        assert.deepEqual([r.type, r.id, r.text, r.creatorId], ["poll", "77", "Chọn váy nào?", "u4"]);
    });
    it("keeps the raw item for the JSON output", () => {
        const raw = note("n3", "x", { someNewField: 1 });
        assert.equal(normalizeBoardItem(raw).raw, raw);
    });
});

/** A fake zca-js API whose board has `items`, served `count` per page. `ignorePage` mimics Zalo handing back page 1. */
function boardApi(items, { ignorePage = false } = {}) {
    const calls = [];
    return {
        calls,
        async getListBoard({ page, count }, groupId) {
            calls.push({ page, count, groupId });
            const start = ignorePage ? 0 : (page - 1) * count;
            return { items: items.slice(start, start + count), count: items.length };
        },
    };
}

describe("listBoard", () => {
    const many = Array.from({ length: 45 }, (_, i) => note(`n${i}`, `ghi chú ${i}`));

    it("walks every page of a big board", async () => {
        const api = boardApi(many);
        const res = await listBoard(api, "g1", { count: 20 });
        assert.equal(res.items.length, 45);
        assert.deepEqual(
            api.calls.map((c) => c.page),
            [1, 2, 3],
        );
        assert.equal(api.calls[0].groupId, "g1");
        assert.equal(res.truncated, false);
    });

    it("stops when Zalo ignores the page and repeats page 1", async () => {
        const api = boardApi(many, { ignorePage: true });
        const res = await listBoard(api, "g1", { count: 20 });
        assert.equal(res.items.length, 20);
        assert.equal(api.calls.length, 2, "one more call finds nothing new, then it stops");
    });

    it("filters by type", async () => {
        const api = boardApi([note("n1", "a"), pinnedMsg("p1", "b"), poll(3, "c")]);
        const res = await listBoard(api, "g1", { type: "note" });
        assert.deepEqual(
            res.items.map((r) => r.id),
            ["n1"],
        );
        const pins = await listBoard(boardApi([note("n1", "a"), pinnedMsg("p1", "b")]), "g1", { type: "pin" });
        assert.deepEqual(
            pins.items.map((r) => r.id),
            ["p1"],
        );
    });

    it("says when it stopped at the page cap", async () => {
        const res = await listBoard(boardApi(many), "g1", { count: 20, maxPages: 2 });
        assert.equal(res.items.length, 40);
        assert.equal(res.truncated, true);
    });

    it("rejects an unknown type", async () => {
        await assert.rejects(() => listBoard(boardApi([]), "g1", { type: "photo" }), /unknown type/);
    });
});

/** A fake zca-js API with `custom` wired the way zca-js wires it, recording the request sent to Zalo. */
function editApi() {
    const sent = [];
    const api = {
        zpwServiceMap: { group_board: ["https://board.example"] },
        custom(name, cb) {
            const ctx = { imei: "imei-1" };
            const utils = {
                makeURL: (u) => u,
                encodeAES: (s) => s,
                request: async (url, opts) => {
                    sent.push({ url, params: JSON.parse(opts.body.get("params")) });
                    return { data: { id: "n1", editTime: 1761600000000, params: '{"title":"mới"}' } };
                },
                resolve: async (res, cb2) => cb2(await res),
            };
            Object.defineProperty(api, name, { value: (props) => cb({ ctx, utils, props }), configurable: false });
        },
    };
    return { api, sent };
}

describe("editNote", () => {
    it("sends no pin action by default, so a pinned note stays pinned", async () => {
        const { api, sent } = editApi();
        const res = await editNote(api, "g1", "n1", "mới");
        assert.equal(sent.length, 1);
        assert.equal(sent[0].url, "https://board.example/api/board/topic/updatev2");
        assert.equal(sent[0].params.pinAct, 0, "zca-js editNote would have sent 2 (unpin) here");
        assert.equal(sent[0].params.topicId, "n1");
        assert.equal(sent[0].params.grid, "g1");
        assert.equal(JSON.parse(sent[0].params.params).title, "mới");
        assert.equal(res.editTime, 1761600000000, "the new edit time comes back");
        assert.equal(res.params.title, "mới");
    });

    it("pins or unpins only when asked", async () => {
        const { api, sent } = editApi();
        await editNote(api, "g1", "n1", "a", PIN_ACT.pin);
        await editNote(api, "g1", "n1", "b", PIN_ACT.unpin);
        assert.deepEqual(
            sent.map((s) => s.params.pinAct),
            [1, 2],
        );
    });

    it("registers its call once per API instance", async () => {
        const { api } = editApi();
        await editNote(api, "g1", "n1", "a");
        await editNote(api, "g1", "n1", "b"); // a second custom() on the same name would throw
    });

    it("refuses an empty text or a made-up pin action", async () => {
        const { api } = editApi();
        await assert.rejects(() => editNote(api, "g1", "n1", "   "), /empty/);
        await assert.rejects(() => editNote(api, "g1", "n1", "a", 7), /bad pin action/);
    });
});

describe("describeItem", () => {
    it("one readable line", () => {
        const line = describeItem(normalizeBoardItem(pinnedMsg("p1", "hẹn\nchụp")));
        assert.match(line, /^pin {2}p1 \[pinned\]/);
        assert.match(line, /hẹn chụp/);
    });
});
