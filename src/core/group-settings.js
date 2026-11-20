/**
 * Safe group settings reader and updater.
 *
 * Why this module exists:
 *   - `group settings <groupId>` previously built its payload with `opts.xxx ?? false`, so passing `--lock-msg`
 *     alone sent `false` for every omitted flag (`enableMsgHistory`, `signAdminMsg`, `joinAppr`, `blockName`, ...)
 *     and wiped the group's other settings; `setTopicOnly` was not exposed at all and always reset to `0`.
 *   - zca-js `updateGroupSettings` sends all 9 boolean flags on every call AND hardcodes `bannFeature: 0`,
 *     `dirtyMedia: 0`, `banDuration: 0`, `blocked_members: []` while omitting `addMemberOnly`. Updating a group
 *     where any of those unpreserved fields is active, or where `getGroupBlockedMember` is non-empty, would
 *     silently erase them.
 *
 * `updateGroupSettings` therefore reads `getGroupInfo` and `getGroupBlockedMember` first, refuses to write when
 * this account lacks admin rights or when the group carries state zca-js would erase, merges only the requested
 * boolean flags onto the group's current settings, and verifies readback after the write.
 */

/** Boolean setting flags supported by zca-js `updateGroupSettings`. */
export const SETTING_FLAGS = Object.freeze([
    "blockName",
    "signAdminMsg",
    "setTopicOnly",
    "enableMsgHistory",
    "joinAppr",
    "lockCreatePost",
    "lockCreatePoll",
    "lockSendMsg",
    "lockViewMember",
]);

/** GroupSetting numeric fields that zca-js `updateGroupSettings` resets to 0 or omits. */
export const UNPRESERVED_ZERO_FIELDS = Object.freeze(["addMemberOnly", "bannFeature", "dirtyMedia", "banDuration"]);

/** Commander option keys on `group settings` mapped to Zalo `GroupSetting` keys. */
export const CLI_OPTION_TO_FLAG = Object.freeze({
    blockName: "blockName",
    signAdmin: "signAdminMsg",
    setTopicOnly: "setTopicOnly",
    msgHistory: "enableMsgHistory",
    joinAppr: "joinAppr",
    lockPost: "lockCreatePost",
    lockPoll: "lockCreatePoll",
    lockMsg: "lockSendMsg",
    lockViewMember: "lockViewMember",
});

const SETTING_FLAG_SET = new Set(SETTING_FLAGS);
const UNPRESERVED_ZERO_SET = new Set(UNPRESERVED_ZERO_FIELDS);
const inFlight = new Set();

/**
 * Extract only the flags explicitly passed on the CLI (`--lock-msg`, `--no-lock-msg`, etc.).
 * Omitted options stay out of the patch so their current group values are preserved.
 * @param {object} [opts]
 * @returns {Record<string, boolean>}
 */
export function settingsFromCliOpts(opts = {}) {
    const patch = {};
    for (const [cliKey, flag] of Object.entries(CLI_OPTION_TO_FLAG)) {
        if (typeof opts?.[cliKey] === "boolean") {
            patch[flag] = opts[cliKey];
        }
    }
    return patch;
}

/**
 * Validate and strip `undefined` entries from a partial settings patch.
 * @param {object} changes
 * @returns {Record<string, boolean>}
 */
export function normalizeSettingsPatch(changes) {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        throw new Error("Specify at least one group setting to update.");
    }
    const patch = {};
    for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) continue;
        if (!SETTING_FLAG_SET.has(key)) {
            throw new Error(`Unknown group setting "${key}".`);
        }
        if (typeof value !== "boolean") {
            throw new Error(`Group setting "${key}" must be a boolean.`);
        }
        patch[key] = value;
    }
    if (Object.keys(patch).length === 0) {
        throw new Error("Specify at least one group setting to update.");
    }
    return patch;
}

/**
 * Convert Zalo's numeric `GroupSetting` flags (`0` / `1`) into booleans.
 * @param {object} setting
 * @returns {Record<string, boolean>}
 */
export function normalizeGroupSettings(setting) {
    if (!setting || typeof setting !== "object" || Array.isArray(setting)) {
        throw new Error("Group settings are missing from getGroupInfo response.");
    }
    const out = {};
    for (const flag of SETTING_FLAGS) {
        out[flag] = setting[flag] === 1 || setting[flag] === true;
    }
    return out;
}

/**
 * Ensure every boolean flag is a valid `0`/`1` snapshot and no SDK-unpreserved field is active.
 * @param {object} setting
 */
export function assertPreservableSettings(setting) {
    if (!setting || typeof setting !== "object" || Array.isArray(setting)) {
        throw new Error("Group settings cannot be preserved: setting snapshot is missing.");
    }
    for (const flag of SETTING_FLAGS) {
        if (setting[flag] !== 0 && setting[flag] !== 1) {
            throw new Error(
                `Group settings cannot be preserved: "${flag}" has unexpected value ${JSON.stringify(setting[flag])}.`,
            );
        }
    }
    for (const field of UNPRESERVED_ZERO_FIELDS) {
        if (setting[field] !== undefined && setting[field] !== 0) {
            throw new Error(
                `Group settings cannot be preserved by zca-js: "${field}" is ${JSON.stringify(setting[field])} and would be reset to 0.`,
            );
        }
    }
    for (const [key, value] of Object.entries(setting)) {
        if (!SETTING_FLAG_SET.has(key) && !UNPRESERVED_ZERO_SET.has(key) && value !== 0) {
            throw new Error(
                `Group settings cannot be preserved by zca-js: unknown field "${key}" is ${JSON.stringify(value)}.`,
            );
        }
    }
}

async function fetchGroupRecord(api, groupId) {
    const res = await api.getGroupInfo(groupId);
    const group = res?.gridInfoMap?.[groupId];
    if (!group || (group.groupId !== undefined && String(group.groupId) !== groupId)) {
        throw new Error(`Group ${groupId} not found.`);
    }
    return group;
}

async function assertEmptyBlockedMembers(api, groupId, stage) {
    const blocked = await api.getGroupBlockedMember({ page: 1, count: 50 }, groupId);
    if (
        !blocked ||
        !Array.isArray(blocked.blocked_members) ||
        blocked.blocked_members.length !== 0 ||
        blocked.has_more !== 0
    ) {
        if (stage === "readback") {
            throw new Error("Blocked member readback mismatch after update; manual review required.");
        }
        throw new Error(
            "Blocked member settings cannot be preserved: group has blocked members (or incomplete list) that zca-js updateGroupSettings would clear.",
        );
    }
}

/**
 * Read a group's current boolean settings and raw Zalo `setting` object.
 * @param {object} api - zca-js API instance (`getGroupInfo`, optional `getOwnId`)
 * @param {string} groupId
 */
export async function getGroupSettings(api, groupId) {
    const id = String(groupId || "").trim();
    if (!id) throw new Error("Group ID is required.");
    const group = await fetchGroupRecord(api, id);
    const settings = normalizeGroupSettings(group.setting);
    const ownId = typeof api?.getOwnId === "function" ? String(api.getOwnId() || "") : "";
    const creatorId = group.creatorId ? String(group.creatorId) : null;
    const adminIds = Array.isArray(group.adminIds) ? group.adminIds.map(String) : [];
    const isAdmin = ownId ? creatorId === ownId || adminIds.includes(ownId) : null;
    return {
        groupId: id,
        groupName: group.name || null,
        creatorId,
        adminIds,
        isAdmin,
        settings,
        raw: group.setting,
    };
}

/**
 * Safely update only the specified boolean settings of a group while preserving all others.
 * @param {object} api - zca-js API instance (`getGroupInfo`, `getGroupBlockedMember`, `updateGroupSettings`, optional `getOwnId`)
 * @param {string} groupId
 * @param {Record<string, boolean | undefined>} changes
 */
export async function updateGroupSettings(api, groupId, changes) {
    const id = String(groupId || "").trim();
    if (!id) throw new Error("Group ID is required.");
    const patch = normalizeSettingsPatch(changes);

    const ownId = typeof api?.getOwnId === "function" ? String(api.getOwnId() || "") : "";
    const lockKey = `${ownId || "default"}:${id}`;
    if (inFlight.has(lockKey)) {
        throw new Error(`Group ${id} settings update is already in progress.`);
    }
    inFlight.add(lockKey);

    try {
        const before = await fetchGroupRecord(api, id);
        if (typeof api?.getOwnId === "function") {
            const adminIds = Array.isArray(before.adminIds) ? before.adminIds.map(String) : [];
            const isCreator = before.creatorId !== undefined && String(before.creatorId) === ownId;
            if (!ownId || (!isCreator && !adminIds.includes(ownId))) {
                throw new Error("Group admin permission required: this account must be the group's owner or a deputy.");
            }
        }

        assertPreservableSettings(before.setting);
        await assertEmptyBlockedMembers(api, id, "preflight");

        const current = normalizeGroupSettings(before.setting);
        const nextSettings = { ...current, ...patch };
        const changedFlags = SETTING_FLAGS.filter((flag) => nextSettings[flag] !== current[flag]);

        if (changedFlags.length === 0) {
            return {
                groupId: id,
                groupName: before.name || null,
                changed: false,
                changedFlags: [],
                settings: current,
            };
        }

        await api.updateGroupSettings(nextSettings, id);

        const after = await fetchGroupRecord(api, id);
        const afterSetting = after?.setting;
        const beforeKeys = Object.keys(before.setting);
        const afterKeys = afterSetting && typeof afterSetting === "object" ? Object.keys(afterSetting) : [];
        const mismatch =
            !afterSetting ||
            afterKeys.length !== beforeKeys.length ||
            SETTING_FLAGS.some((flag) => afterSetting[flag] !== Number(nextSettings[flag])) ||
            beforeKeys.some((key) => !SETTING_FLAG_SET.has(key) && afterSetting[key] !== before.setting[key]);
        if (mismatch) {
            throw new Error("Group settings readback mismatch after update; manual review required.");
        }
        await assertEmptyBlockedMembers(api, id, "readback");

        return {
            groupId: id,
            groupName: after.name || before.name || null,
            changed: true,
            changedFlags,
            settings: normalizeGroupSettings(afterSetting),
        };
    } finally {
        inFlight.delete(lockKey);
    }
}
