/**
 * Group polls: create, inspect (with normalized voters and display names), and lock.
 *
 * Zalo returns poll option voters inconsistently across responses (bare UID strings or
 * `{ id, dName, zaloName }` objects), and `lockPoll` returns `""` and cannot be undone.
 */

/**
 * Normalize one poll voter entry (string UID or profile-like object) into `{ id, name }`.
 * Returns `null` for empty or invalid entries.
 * @param {unknown} voter
 * @returns {{ id: string, name: string|null } | null}
 */
export function normalizePollVoter(voter) {
    if (typeof voter === "string") {
        const id = voter.trim();
        return id ? { id, name: null } : null;
    }
    if (voter && typeof voter === "object") {
        const rawId = voter.id ?? voter.uid;
        if (typeof rawId !== "string" && (typeof rawId !== "number" || !Number.isFinite(rawId))) {
            return null;
        }
        const id = String(rawId).trim();
        if (!id) return null;
        const name = pickFirstNonEmpty([voter.displayName, voter.zaloName, voter.dName, voter.name]);
        return { id, name };
    }
    return null;
}

function pickFirstNonEmpty(values) {
    for (const val of values) {
        if (typeof val === "string" && val.trim()) {
            return val.trim();
        }
    }
    return null;
}

function extractProfileName(profile) {
    if (!profile || typeof profile !== "object") return null;
    return pickFirstNonEmpty([profile.displayName, profile.zaloName, profile.dName, profile.name]);
}

/**
 * Normalize poll options and deduplicate voters per option, keeping the first non-null name.
 * @param {unknown} options
 * @returns {Array<{ optionId: number|string|null, content: string, votes: number, voted: boolean, voters: Array<{ id: string, name: string|null }> }>}
 */
export function extractPollOptions(options) {
    if (!Array.isArray(options)) return [];
    return options.map((opt) => {
        const byId = new Map();
        const rawVoters = Array.isArray(opt?.voters) ? opt.voters : [];
        for (const rawVoter of rawVoters) {
            const normalized = normalizePollVoter(rawVoter);
            if (!normalized) continue;
            const existing = byId.get(normalized.id);
            if (!existing) {
                byId.set(normalized.id, normalized);
            } else if (!existing.name && normalized.name) {
                existing.name = normalized.name;
            }
        }
        return {
            optionId: opt?.option_id ?? opt?.optionId ?? null,
            content: String(opt?.content ?? ""),
            votes: Number(opt?.votes) || 0,
            voted: Boolean(opt?.voted),
            voters: [...byId.values()],
        };
    });
}

/**
 * Resolve Zalo user IDs to display names using group member info first, then user info.
 * Never throws on profile lookup errors; missing entries simply stay unresolved.
 * @param {object} api - zca-js API instance
 * @param {string[]} voterIds
 * @returns {Promise<Map<string, string>>}
 */
export async function resolveVoterNames(api, voterIds) {
    const ids = [
        ...new Set(
            (Array.isArray(voterIds) ? voterIds : [])
                .map((id) => (typeof id === "string" || typeof id === "number" ? String(id).trim() : ""))
                .filter(Boolean),
        ),
    ];
    const resolved = new Map();
    if (ids.length === 0 || !api) return resolved;

    if (typeof api.getGroupMembersInfo === "function") {
        try {
            const res = await api.getGroupMembersInfo(ids);
            const profiles = res?.profiles || {};
            for (const id of ids) {
                const name = extractProfileName(profiles[id] ?? profiles[`${id}_0`]);
                if (name) resolved.set(id, name);
            }
        } catch {
            // Safe fallback: try getUserInfo or leave name as null.
        }
    }

    const missing = ids.filter((id) => !resolved.has(id));
    if (missing.length > 0 && typeof api.getUserInfo === "function") {
        try {
            const res = await api.getUserInfo(missing);
            const changed = res?.changed_profiles || {};
            const profiles = res?.profiles || {};
            for (const id of missing) {
                const name = extractProfileName(
                    changed[id] ?? profiles[id] ?? changed[`${id}_0`] ?? profiles[`${id}_0`],
                );
                if (name) resolved.set(id, name);
            }
        } catch {
            // Safe fallback: leave missing voter names as null.
        }
    }

    return resolved;
}

function parsePositivePollId(pollId) {
    const raw = typeof pollId === "string" ? pollId.trim() : pollId;
    const num = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(num) || num <= 0) {
        throw new Error("pollId must be a positive integer.");
    }
    return num;
}

/**
 * Create a poll in a Zalo group.
 * @param {object} api - zca-js API instance
 * @param {{
 *   threadId: string,
 *   question: string,
 *   options: string[],
 *   allowMultiChoices?: boolean,
 *   allowAddNewOption?: boolean,
 *   hideVotePreview?: boolean,
 *   isAnonymous?: boolean,
 *   expireMinutes?: number,
 * }} params
 */
export async function createPoll(
    api,
    {
        threadId,
        question,
        options,
        allowMultiChoices = false,
        allowAddNewOption = false,
        hideVotePreview = false,
        isAnonymous = false,
        expireMinutes = 0,
    },
) {
    const cleanThreadId =
        typeof threadId === "string" || (typeof threadId === "number" && Number.isFinite(threadId))
            ? String(threadId).trim()
            : "";
    if (!cleanThreadId) throw new Error("threadId is required.");

    const cleanQuestion = typeof question === "string" ? question.trim() : "";
    if (!cleanQuestion) throw new Error("question is required.");

    if (!Array.isArray(options) || options.length < 2) {
        throw new Error("A poll requires at least 2 options.");
    }
    const cleanOptions = [];
    for (const opt of options) {
        const text = typeof opt === "string" ? opt.trim() : "";
        if (!text) throw new Error("Poll options must be non-empty strings.");
        cleanOptions.push(text);
    }

    const exp = Number(expireMinutes ?? 0);
    if (!Number.isFinite(exp) || exp < 0) {
        throw new Error("expireMinutes must be a non-negative number.");
    }
    const expiredTime = exp > 0 ? Math.round(exp * 60_000) : 0;

    const detail = await api.createPoll(
        {
            question: cleanQuestion,
            options: cleanOptions,
            allowMultiChoices: !!allowMultiChoices,
            allowAddNewOption: !!allowAddNewOption,
            hideVotePreview: !!hideVotePreview,
            isAnonymous: !!isAnonymous,
            expiredTime,
        },
        cleanThreadId,
    );

    return {
        pollId: detail?.poll_id ?? null,
        threadId: cleanThreadId,
        question: detail?.question ?? cleanQuestion,
        options: extractPollOptions(detail?.options),
        allowMultiChoices: Boolean(detail?.allow_multi_choices ?? allowMultiChoices),
        allowAddNewOption: Boolean(detail?.allow_add_new_option ?? allowAddNewOption),
        hideVotePreview: Boolean(detail?.is_hide_vote_preview ?? hideVotePreview),
        isAnonymous: Boolean(detail?.is_anonymous ?? isAnonymous),
        expiredTime: Number(detail?.expired_time ?? expiredTime) || 0,
        closed: Boolean(detail?.closed),
    };
}

async function fetchAndNormalizePoll(api, pollId, includeVoters = true) {
    const id = parsePositivePollId(pollId);
    const raw = await api.getPollDetail(id);
    const options = extractPollOptions(raw?.options);

    if (includeVoters) {
        const missingNameIds = [];
        for (const opt of options) {
            for (const voter of opt.voters) {
                if (!voter.name) missingNameIds.push(voter.id);
            }
        }
        if (missingNameIds.length > 0) {
            const nameMap = await resolveVoterNames(api, missingNameIds);
            for (const opt of options) {
                for (const voter of opt.voters) {
                    if (!voter.name && nameMap.has(voter.id)) {
                        voter.name = nameMap.get(voter.id);
                    }
                }
            }
        }
    }

    const voterMap = new Map();
    for (const opt of options) {
        for (const voter of opt.voters) {
            const existing = voterMap.get(voter.id);
            if (!existing) {
                voterMap.set(voter.id, { ...voter });
            } else if (!existing.name && voter.name) {
                existing.name = voter.name;
            }
        }
    }
    const voters = [...voterMap.values()];
    const voterIds = voters.map((v) => v.id);

    return { id, raw, options, voters, voterIds };
}

/**
 * Fetch poll details with normalized voters and optional display name resolution.
 * @param {object} api - zca-js API instance
 * @param {{ pollId: number|string, includeVoters?: boolean }} params
 */
export async function getPollDetail(api, { pollId, includeVoters = true }) {
    const { id, raw, options, voters, voterIds } = await fetchAndNormalizePoll(api, pollId, includeVoters);
    return {
        pollId: raw?.poll_id ?? id,
        creator: raw?.creator ?? null,
        question: raw?.question ?? "",
        closed: Boolean(raw?.closed),
        allowMultiChoices: Boolean(raw?.allow_multi_choices),
        allowAddNewOption: Boolean(raw?.allow_add_new_option),
        hideVotePreview: Boolean(raw?.is_hide_vote_preview),
        isAnonymous: Boolean(raw?.is_anonymous),
        totalVotes: Number(raw?.num_vote) || 0,
        createdTime: Number(raw?.created_time) || 0,
        updatedTime: Number(raw?.updated_time) || 0,
        expiredTime: Number(raw?.expired_time) || 0,
        options,
        voterIds,
        voters,
    };
}

/**
 * Fetch raw poll detail enriched with normalized voters (keeping original snake_case fields for CLI `--json`).
 * @param {object} api - zca-js API instance
 * @param {number|string} pollId
 */
export async function getPollInfoWithVoters(api, pollId) {
    const { raw, options, voters, voterIds } = await fetchAndNormalizePoll(api, pollId, true);
    const rawOptions = Array.isArray(raw?.options) ? raw.options : [];
    const mergedOptions = options.map((opt, idx) => ({
        ...(rawOptions[idx] || { option_id: opt.optionId, content: opt.content, votes: opt.votes, voted: opt.voted }),
        voters: opt.voters,
    }));
    return {
        ...(raw || {}),
        options: mergedOptions,
        voterIds,
        voters,
    };
}

/**
 * Permanently lock/close a poll. Zalo API does not support reopening a locked poll.
 * @param {object} api - zca-js API instance
 * @param {{ pollId: number|string }} params
 */
export async function lockPoll(api, { pollId }) {
    const id = parsePositivePollId(pollId);
    await api.lockPoll(id);
    return { success: true, pollId: id, closed: true, irreversible: true };
}
