import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    createPoll,
    extractPollOptions,
    getPollDetail,
    getPollInfoWithVoters,
    lockPoll,
    normalizePollVoter,
    resolveVoterNames,
} from "./polls.js";

describe("normalizePollVoter", () => {
    it("normalizes string UIDs", () => {
        assert.deepEqual(normalizePollVoter("12345"), { id: "12345", name: null });
        assert.deepEqual(normalizePollVoter("  6789  "), { id: "6789", name: null });
    });

    it("normalizes object voters with id/uid and display/zalo/dName/name", () => {
        assert.deepEqual(normalizePollVoter({ id: "u1", dName: "Lan" }), { id: "u1", name: "Lan" });
        assert.deepEqual(normalizePollVoter({ uid: "u2", displayName: "Minh", dName: "Fallback" }), {
            id: "u2",
            name: "Minh",
        });
        assert.deepEqual(normalizePollVoter({ id: "u3", zaloName: "Hoa" }), { id: "u3", name: "Hoa" });
        assert.deepEqual(normalizePollVoter({ id: "u4", name: "An" }), { id: "u4", name: "An" });
        assert.deepEqual(normalizePollVoter({ id: "u5", dName: "   " }), { id: "u5", name: null });
        assert.deepEqual(normalizePollVoter({ uid: 99, displayName: "Num" }), { id: "99", name: "Num" });
    });

    it("ignores empty or invalid values", () => {
        assert.equal(normalizePollVoter(""), null);
        assert.equal(normalizePollVoter("   "), null);
        assert.equal(normalizePollVoter(null), null);
        assert.equal(normalizePollVoter(undefined), null);
        assert.equal(normalizePollVoter(123), null);
        assert.equal(normalizePollVoter({}), null);
        assert.equal(normalizePollVoter({ id: "   " }), null);
        assert.equal(normalizePollVoter({ id: true }), null);
    });
});

describe("extractPollOptions", () => {
    it("normalizes options and deduplicates voters keeping the first non-null name", () => {
        const options = extractPollOptions([
            {
                option_id: 1,
                content: "Option A",
                votes: 2,
                voted: true,
                voters: ["u1", { id: "u1", dName: "Lan" }, { id: "u1", dName: "Other" }, { uid: "u2" }, "", null],
            },
            {
                optionId: 2,
                content: "Option B",
                votes: 0,
                voted: false,
                voters: [],
            },
        ]);
        assert.deepEqual(options, [
            {
                optionId: 1,
                content: "Option A",
                votes: 2,
                voted: true,
                voters: [
                    { id: "u1", name: "Lan" },
                    { id: "u2", name: null },
                ],
            },
            {
                optionId: 2,
                content: "Option B",
                votes: 0,
                voted: false,
                voters: [],
            },
        ]);
    });

    it("returns [] for non-array input", () => {
        assert.deepEqual(extractPollOptions(null), []);
        assert.deepEqual(extractPollOptions(undefined), []);
    });
});

describe("resolveVoterNames", () => {
    it("deduplicates IDs, prefers getGroupMembersInfo (including _0 suffix), and falls back to getUserInfo", async () => {
        const calls = [];
        const api = {
            getGroupMembersInfo: async (ids) => {
                calls.push(["group", ids]);
                return {
                    profiles: {
                        u1: { displayName: "Lan" },
                        u2_0: { zaloName: "Minh" },
                    },
                };
            },
            getUserInfo: async (ids) => {
                calls.push(["user", ids]);
                return {
                    changed_profiles: {
                        u3: { displayName: "Hoa" },
                    },
                    profiles: {
                        u4: { dName: "Tuan" },
                    },
                };
            },
        };

        const names = await resolveVoterNames(api, ["u1", " u1 ", "u2", "u3", "u4", "u5", ""]);
        assert.deepEqual(calls, [
            ["group", ["u1", "u2", "u3", "u4", "u5"]],
            ["user", ["u3", "u4", "u5"]],
        ]);
        assert.equal(names.get("u1"), "Lan");
        assert.equal(names.get("u2"), "Minh");
        assert.equal(names.get("u3"), "Hoa");
        assert.equal(names.get("u4"), "Tuan");
        assert.equal(names.has("u5"), false);
    });

    it("falls back safely when profile APIs throw", async () => {
        const api = {
            getGroupMembersInfo: async () => {
                throw new Error("group lookup failed");
            },
            getUserInfo: async () => {
                throw new Error("user lookup failed");
            },
        };
        const names = await resolveVoterNames(api, ["u1", "u2"]);
        assert.equal(names.size, 0);
    });

    it("falls back to getUserInfo when getGroupMembersInfo throws", async () => {
        const api = {
            getGroupMembersInfo: async () => {
                throw new Error("group lookup failed");
            },
            getUserInfo: async () => ({
                changed_profiles: { u1: { displayName: "Lan" } },
            }),
        };
        const names = await resolveVoterNames(api, ["u1"]);
        assert.equal(names.get("u1"), "Lan");
    });
});

describe("createPoll", () => {
    it("validates inputs and converts expireMinutes to milliseconds", async () => {
        const calls = [];
        const api = {
            createPoll: async (opts, threadId) => {
                calls.push({ opts, threadId });
                return {
                    poll_id: 501,
                    question: opts.question,
                    options: [
                        { option_id: 1, content: "Yes", votes: 0, voted: false, voters: [] },
                        { option_id: 2, content: "No", votes: 0, voted: false, voters: [] },
                    ],
                    allow_multi_choices: opts.allowMultiChoices,
                    allow_add_new_option: opts.allowAddNewOption,
                    is_hide_vote_preview: opts.hideVotePreview,
                    is_anonymous: opts.isAnonymous,
                    expired_time: opts.expiredTime,
                    closed: false,
                };
            },
        };

        const res = await createPoll(api, {
            threadId: "g1",
            question: "Run tomorrow?",
            options: ["Yes", "No"],
            allowMultiChoices: true,
            expireMinutes: 30,
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].threadId, "g1");
        assert.deepEqual(calls[0].opts, {
            question: "Run tomorrow?",
            options: ["Yes", "No"],
            allowMultiChoices: true,
            allowAddNewOption: false,
            hideVotePreview: false,
            isAnonymous: false,
            expiredTime: 1_800_000,
        });
        assert.equal(res.pollId, 501);
        assert.equal(res.expiredTime, 1_800_000);
    });

    it("rejects invalid threadId, question, options, or expireMinutes", async () => {
        const api = { createPoll: async () => ({}) };
        await assert.rejects(() => createPoll(api, { threadId: "", question: "Q", options: ["A", "B"] }), /threadId/);
        await assert.rejects(
            () => createPoll(api, { threadId: "g1", question: "  ", options: ["A", "B"] }),
            /question/,
        );
        await assert.rejects(() => createPoll(api, { threadId: "g1", question: "Q", options: ["A"] }), /at least 2/);
        await assert.rejects(
            () => createPoll(api, { threadId: "g1", question: "Q", options: ["A", "  "] }),
            /non-empty/,
        );
        await assert.rejects(
            () => createPoll(api, { threadId: "g1", question: "Q", options: ["A", "B"], expireMinutes: -1 }),
            /expireMinutes/,
        );
    });
});

describe("getPollDetail and getPollInfoWithVoters", () => {
    const rawPoll = {
        poll_id: 77,
        creator: "u0",
        question: "Pick a time",
        closed: false,
        allow_multi_choices: true,
        allow_add_new_option: false,
        is_hide_vote_preview: false,
        is_anonymous: false,
        num_vote: 2,
        created_time: 1000,
        updated_time: 2000,
        expired_time: 0,
        options: [
            { option_id: 1, content: "5:00 AM", votes: 2, voted: true, voters: ["u1", { id: "u2", dName: "Binh" }] },
            { option_id: 2, content: "6:00 AM", votes: 1, voted: false, voters: ["u1", "u3"] },
        ],
    };

    it("resolves voter names when includeVoters is true and aggregates voters", async () => {
        const calls = [];
        const api = {
            getPollDetail: async (id) => {
                calls.push(["poll", id]);
                return rawPoll;
            },
            getGroupMembersInfo: async (ids) => {
                calls.push(["group", ids]);
                return { profiles: { u1: { displayName: "An" } } };
            },
            getUserInfo: async (ids) => {
                calls.push(["user", ids]);
                return { changed_profiles: {} };
            },
        };

        const detail = await getPollDetail(api, { pollId: "77", includeVoters: true });
        assert.deepEqual(calls, [
            ["poll", 77],
            ["group", ["u1", "u3"]],
            ["user", ["u3"]],
        ]);
        assert.equal(detail.pollId, 77);
        assert.deepEqual(detail.options[0].voters, [
            { id: "u1", name: "An" },
            { id: "u2", name: "Binh" },
        ]);
        assert.deepEqual(detail.options[1].voters, [
            { id: "u1", name: "An" },
            { id: "u3", name: null },
        ]);
        assert.deepEqual(detail.voterIds, ["u1", "u2", "u3"]);
        assert.deepEqual(detail.voters, [
            { id: "u1", name: "An" },
            { id: "u2", name: "Binh" },
            { id: "u3", name: null },
        ]);
    });

    it("skips profile lookups when includeVoters is false", async () => {
        let profileCalled = false;
        const api = {
            getPollDetail: async () => rawPoll,
            getGroupMembersInfo: async () => {
                profileCalled = true;
                return {};
            },
        };
        const detail = await getPollDetail(api, { pollId: 77, includeVoters: false });
        assert.equal(profileCalled, false);
        assert.deepEqual(detail.options[0].voters, [
            { id: "u1", name: null },
            { id: "u2", name: "Binh" },
        ]);
    });

    it("keeps raw fields on getPollInfoWithVoters for backward-compatible CLI --json", async () => {
        const api = {
            getPollDetail: async () => rawPoll,
            getGroupMembersInfo: async () => ({ profiles: { u1: { displayName: "An" } } }),
            getUserInfo: async () => ({ changed_profiles: {} }),
        };
        const out = await getPollInfoWithVoters(api, 77);
        assert.equal(out.poll_id, 77);
        assert.equal(out.num_vote, 2);
        assert.equal(out.options[0].option_id, 1);
        assert.deepEqual(out.options[0].voters, [
            { id: "u1", name: "An" },
            { id: "u2", name: "Binh" },
        ]);
        assert.deepEqual(out.voterIds, ["u1", "u2", "u3"]);
    });

    it("rejects non-positive or non-integer pollId", async () => {
        const api = { getPollDetail: async () => rawPoll };
        await assert.rejects(() => getPollDetail(api, { pollId: 0 }), /positive integer/);
        await assert.rejects(() => getPollDetail(api, { pollId: -5 }), /positive integer/);
        await assert.rejects(() => getPollDetail(api, { pollId: "abc" }), /positive integer/);
        await assert.rejects(() => getPollDetail(api, { pollId: 1.5 }), /positive integer/);
    });
});

describe("lockPoll", () => {
    it("locks the poll and reports irreversible: true", async () => {
        const locked = [];
        const api = {
            lockPoll: async (id) => {
                locked.push(id);
                return "";
            },
        };
        const res = await lockPoll(api, { pollId: "88" });
        assert.deepEqual(locked, [88]);
        assert.deepEqual(res, { success: true, pollId: 88, closed: true, irreversible: true });
    });

    it("rejects invalid pollId", async () => {
        const api = { lockPoll: async () => "" };
        await assert.rejects(() => lockPoll(api, { pollId: 0 }), /positive integer/);
        await assert.rejects(() => lockPoll(api, { pollId: "nope" }), /positive integer/);
    });
});
