import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { __setSessionForTests, clearSession } from "../core/zalo-client.js";
import { registerPollCommands } from "./poll.js";

function makeProgram() {
    const program = new Command();
    program.option("--json", "Output results as JSON");
    registerPollCommands(program);
    return program;
}

async function captureConsole(fn) {
    const logs = [];
    const errs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => logs.push(args.join(" "));
    console.error = (...args) => errs.push(args.join(" "));
    try {
        await fn();
    } finally {
        console.log = origLog;
        console.error = origErr;
    }
    return { logs, errs };
}

describe("poll info CLI command", () => {
    afterEach(() => clearSession());

    const rawPoll = {
        poll_id: 42,
        question: "Morning run?",
        closed: false,
        num_vote: 2,
        allow_multi_choices: false,
        is_anonymous: false,
        expired_time: 0,
        options: [
            { option_id: 1, content: "5:00", votes: 2, voted: true, voters: ["u1", "u2"] },
            { option_id: 2, content: "6:00", votes: 0, voted: false, voters: [] },
        ],
    };

    it("preserves exact legacy --json output and avoids profile lookups without --voters", async () => {
        let profileLookedUp = false;
        __setSessionForTests({
            getPollDetail: async (id) => {
                assert.equal(id, 42);
                return rawPoll;
            },
            getGroupMembersInfo: async () => {
                profileLookedUp = true;
                return {};
            },
        });

        const program = makeProgram();
        const { logs } = await captureConsole(() =>
            program.parseAsync(["node", "javis-zalo", "--json", "poll", "info", "42"]),
        );
        assert.equal(profileLookedUp, false);
        assert.deepEqual(JSON.parse(logs.join("\n")), rawPoll);
    });

    it("attaches normalized voters with resolved names when --voters is passed in --json mode", async () => {
        __setSessionForTests({
            getPollDetail: async () => rawPoll,
            getGroupMembersInfo: async () => ({
                profiles: { u1: { displayName: "An" } },
            }),
            getUserInfo: async () => ({
                changed_profiles: { u2: { zaloName: "Binh" } },
            }),
        });

        const program = makeProgram();
        const { logs } = await captureConsole(() =>
            program.parseAsync(["node", "javis-zalo", "--json", "poll", "info", "42", "--voters"]),
        );
        const parsed = JSON.parse(logs.join("\n"));
        assert.equal(parsed.poll_id, 42);
        assert.equal(parsed.num_vote, 2);
        assert.equal(parsed.options[0].option_id, 1);
        assert.deepEqual(parsed.options[0].voters, [
            { id: "u1", name: "An" },
            { id: "u2", name: "Binh" },
        ]);
        assert.deepEqual(parsed.voterIds, ["u1", "u2"]);
    });

    it("prints voter names in human output when --voters is passed", async () => {
        __setSessionForTests({
            getPollDetail: async () => rawPoll,
            getGroupMembersInfo: async () => ({
                profiles: { u1: { displayName: "An" } },
            }),
            getUserInfo: async () => ({}),
        });

        const program = makeProgram();
        const { logs } = await captureConsole(() =>
            program.parseAsync(["node", "javis-zalo", "poll", "info", "42", "--voters"]),
        );
        const stdout = logs.join("\n");
        assert.match(stdout, /5:00/);
        assert.match(stdout, /Voters: An \(u1\), u2/);
    });
});
