import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    SETTING_FLAGS,
    UNPRESERVED_ZERO_FIELDS,
    getGroupSettings,
    normalizeSettingsPatch,
    settingsFromCliOpts,
    updateGroupSettings,
} from "./group-settings.js";

function makeFixture(overrides = {}) {
    const setting = {
        blockName: 1,
        signAdminMsg: 1,
        addMemberOnly: 0,
        setTopicOnly: 1,
        enableMsgHistory: 1,
        joinAppr: 1,
        lockCreatePost: 0,
        lockCreatePoll: 0,
        lockSendMsg: 0,
        lockViewMember: 0,
        bannFeature: 0,
        dirtyMedia: 0,
        banDuration: 0,
        ...overrides.setting,
    };
    const group = {
        groupId: "g123",
        name: "Test nhóm zalo",
        creatorId: "owner-1",
        adminIds: ["deputy-1"],
        setting,
        ...overrides.group,
    };
    const calls = [];
    const api = {
        calls,
        getOwnId: () => overrides.ownId ?? "deputy-1",
        async getGroupInfo(id) {
            calls.push(["getGroupInfo", id]);
            return { gridInfoMap: { [group.groupId]: structuredClone(group) } };
        },
        async getGroupBlockedMember(payload, id) {
            calls.push(["getGroupBlockedMember", payload, id]);
            return { blocked_members: [], has_more: 0 };
        },
        async updateGroupSettings(options, id) {
            calls.push(["updateGroupSettings", structuredClone(options), id]);
            for (const flag of SETTING_FLAGS) {
                setting[flag] = options[flag] ? 1 : 0;
            }
            return "";
        },
    };
    return { setting, group, api, calls };
}

describe("settingsFromCliOpts", () => {
    it("includes only explicitly passed CLI flags so omitted flags are preserved", () => {
        assert.deepEqual(settingsFromCliOpts({ lockMsg: true }), { lockSendMsg: true });
        assert.deepEqual(settingsFromCliOpts({ lockMsg: false, setTopicOnly: true, msgHistory: false }), {
            lockSendMsg: false,
            setTopicOnly: true,
            enableMsgHistory: false,
        });
        assert.deepEqual(settingsFromCliOpts({}), {});
    });
});

describe("normalizeSettingsPatch", () => {
    it("strips undefined fields and rejects empty or invalid patches", () => {
        assert.deepEqual(normalizeSettingsPatch({ lockSendMsg: true, joinAppr: undefined }), { lockSendMsg: true });
        assert.throws(() => normalizeSettingsPatch({}), /at least one/);
        assert.throws(() => normalizeSettingsPatch({ lockSendMsg: undefined }), /at least one/);
        assert.throws(() => normalizeSettingsPatch({ unknownFlag: true }), /Unknown group setting/);
        assert.throws(() => normalizeSettingsPatch({ lockSendMsg: 1 }), /boolean/);
    });
});

describe("getGroupSettings", () => {
    it("reads boolean flags, admin status, and raw setting object", async () => {
        const { api, setting } = makeFixture();
        const res = await getGroupSettings(api, "g123");
        assert.equal(res.groupId, "g123");
        assert.equal(res.groupName, "Test nhóm zalo");
        assert.equal(res.creatorId, "owner-1");
        assert.deepEqual(res.adminIds, ["deputy-1"]);
        assert.equal(res.isAdmin, true);
        assert.deepEqual(res.settings, {
            blockName: true,
            signAdminMsg: true,
            setTopicOnly: true,
            enableMsgHistory: true,
            joinAppr: true,
            lockCreatePost: false,
            lockCreatePoll: false,
            lockSendMsg: false,
            lockViewMember: false,
        });
        assert.deepEqual(res.raw, setting);
    });

    it("marks regular members as non-admin without failing read", async () => {
        const { api } = makeFixture({ ownId: "member-9" });
        const res = await getGroupSettings(api, "g123");
        assert.equal(res.isAdmin, false);
    });

    it("rejects when group is missing", async () => {
        const { api } = makeFixture();
        await assert.rejects(() => getGroupSettings(api, "missing-id"), /not found/);
    });
});

describe("updateGroupSettings", () => {
    it("flips only requested flags and preserves all existing boolean settings", async () => {
        const { api, setting, calls } = makeFixture();
        const original = structuredClone(setting);

        const locked = await updateGroupSettings(api, "g123", { lockSendMsg: true });
        assert.equal(locked.changed, true);
        assert.deepEqual(locked.changedFlags, ["lockSendMsg"]);
        assert.equal(locked.settings.lockSendMsg, true);
        assert.equal(locked.settings.signAdminMsg, true);
        assert.equal(locked.settings.setTopicOnly, true);
        assert.equal(locked.settings.enableMsgHistory, true);
        assert.equal(locked.settings.joinAppr, true);
        assert.equal(locked.settings.blockName, true);
        assert.deepEqual(setting, { ...original, lockSendMsg: 1 });

        const updateCall = calls.find((c) => c[0] === "updateGroupSettings");
        assert.deepEqual(updateCall[1], {
            blockName: true,
            signAdminMsg: true,
            setTopicOnly: true,
            enableMsgHistory: true,
            joinAppr: true,
            lockCreatePost: false,
            lockCreatePoll: false,
            lockSendMsg: true,
            lockViewMember: false,
        });

        const unlocked = await updateGroupSettings(api, "g123", { lockSendMsg: false });
        assert.equal(unlocked.changed, true);
        assert.deepEqual(unlocked.changedFlags, ["lockSendMsg"]);
        assert.deepEqual(setting, original);
    });

    it("skips write when requested flags already match current settings", async () => {
        const { api, calls } = makeFixture();
        const res = await updateGroupSettings(api, "g123", { signAdminMsg: true, lockSendMsg: false });
        assert.equal(res.changed, false);
        assert.deepEqual(res.changedFlags, []);
        assert.equal(calls.filter((c) => c[0] === "updateGroupSettings").length, 0);
    });

    it("refuses without group owner or deputy permission", async () => {
        const { api, calls } = makeFixture({ ownId: "member-9" });
        await assert.rejects(() => updateGroupSettings(api, "g123", { lockSendMsg: true }), /admin permission/);
        assert.equal(calls.filter((c) => c[0] === "updateGroupSettings").length, 0);
    });

    it("allows group creator even when creator is not repeated in adminIds", async () => {
        const { api } = makeFixture({ ownId: "owner-1", group: { adminIds: [] } });
        const res = await updateGroupSettings(api, "g123", { setTopicOnly: false });
        assert.equal(res.changed, true);
        assert.deepEqual(res.changedFlags, ["setTopicOnly"]);
        assert.equal(res.settings.setTopicOnly, false);
    });

    it("guards against every SDK-unpreserved field when non-zero", async () => {
        for (const field of UNPRESERVED_ZERO_FIELDS) {
            const { api, calls } = makeFixture({ setting: { [field]: 1 } });
            await assert.rejects(
                () => updateGroupSettings(api, "g123", { lockSendMsg: true }),
                new RegExp(`cannot be preserved.*"${field}"`),
            );
            assert.equal(calls.filter((c) => c[0] === "updateGroupSettings").length, 0);
        }
    });

    it("guards against unknown non-zero setting fields", async () => {
        const { api, calls } = makeFixture({ setting: { futureModerationFlag: 2 } });
        await assert.rejects(
            () => updateGroupSettings(api, "g123", { lockSendMsg: true }),
            /cannot be preserved.*futureModerationFlag/,
        );
        assert.equal(calls.filter((c) => c[0] === "updateGroupSettings").length, 0);
    });

    it("guards against non-empty or paginated blocked member lists", async () => {
        const withBlocked = makeFixture();
        withBlocked.api.getGroupBlockedMember = async () => ({ blocked_members: [{ id: "u9" }], has_more: 0 });
        await assert.rejects(
            () => updateGroupSettings(withBlocked.api, "g123", { lockSendMsg: true }),
            /Blocked member settings cannot be preserved/,
        );
        assert.equal(withBlocked.calls.filter((c) => c[0] === "updateGroupSettings").length, 0);

        const withHasMore = makeFixture();
        withHasMore.api.getGroupBlockedMember = async () => ({ blocked_members: [], has_more: 1 });
        await assert.rejects(
            () => updateGroupSettings(withHasMore.api, "g123", { lockSendMsg: true }),
            /Blocked member settings cannot be preserved/,
        );
    });

    it("verifies readback and fails if Zalo did not apply the update", async () => {
        const { api } = makeFixture();
        api.updateGroupSettings = async () => "";
        await assert.rejects(() => updateGroupSettings(api, "g123", { lockSendMsg: true }), /readback mismatch/);
    });

    it("rejects concurrent updates to the same group and releases lock afterwards", async () => {
        const { api } = makeFixture();
        let releaseFirst;
        const gate = new Promise((resolve) => {
            releaseFirst = resolve;
        });
        const origGetInfo = api.getGroupInfo.bind(api);
        let firstCall = true;
        api.getGroupInfo = async (id) => {
            if (firstCall) {
                firstCall = false;
                await gate;
            }
            return origGetInfo(id);
        };

        const p1 = updateGroupSettings(api, "g123", { lockSendMsg: true });
        await assert.rejects(() => updateGroupSettings(api, "g123", { lockCreatePoll: true }), /already in progress/);
        releaseFirst();
        const r1 = await p1;
        assert.equal(r1.changed, true);

        const r2 = await updateGroupSettings(api, "g123", { lockCreatePoll: true });
        assert.equal(r2.changed, true);
    });
});
