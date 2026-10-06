/**
 * Group join requests: people waiting for approval to join a group that requires it.
 *
 * Zalo pushes a "join_request" group event (uids only, no names) when someone asks to join. The
 * authoritative list is getPendingGroupMembers(groupId), which also carries display names, and
 * reviewPendingMemberRequest approves or rejects. Both need this account to be the group's owner
 * or a deputy, and the group to require approval.
 */

/** zca-js GroupEventType.JOIN_REQUEST */
const JOIN_REQUEST = "join_request";

/** Buffer message type for a join request, read by agents next to ordinary messages. */
export const JOIN_REQUEST_MESSAGE_TYPE = "group.join_request";

/** zca-js ReviewPendingMemberRequestStatus → readable outcome. */
const REVIEW_STATUS = {
    0: "done",
    170: "not_pending",
    178: "already_member",
    166: "no_permission",
};

/**
 * Turn one zca-js group event into join-request records (one per person). Anything else gives [].
 * @param {object} event - zca-js group_event ({ type, threadId, data })
 * @param {number} [now]
 * @returns {Array<{groupId: string, userId: string, time: number, totalPending: number|null}>}
 */
export function joinRequestRecordsFromEvent(event, now = Date.now()) {
    if (!event || event.type !== JOIN_REQUEST) return [];
    const data = event.data || {};
    const groupId = String(event.threadId || data.groupId || data.group_id || "");
    if (!groupId) return [];
    const t = Number(data.time);
    const time = Number.isFinite(t) && t > 0 ? t : now;
    const total = Number(data.totalPending);
    const uids = Array.isArray(data.uids) ? data.uids : [];
    const seen = new Set();
    const out = [];
    for (const u of uids) {
        const userId = String(u || "").trim();
        if (!userId || seen.has(userId)) continue;
        seen.add(userId);
        out.push({ groupId, userId, time, totalPending: Number.isFinite(total) ? total : null });
    }
    return out;
}

/**
 * The live-buffer message for one join request. The applicant is the sender.
 * @param {ReturnType<typeof joinRequestRecordsFromEvent>[number]} rec
 * @param {string|null} [name] - display name from getPendingGroupMembers, when known
 * @returns {object}
 */
export function joinRequestToBufferMessage(rec, name = null) {
    const who = name || rec.userId;
    return {
        id: `joinreq:${rec.groupId}:${rec.userId}:${rec.time}`,
        threadId: rec.groupId,
        threadType: "group",
        senderId: rec.userId,
        senderName: name || null,
        text: `[${who} asked to join the group]`,
        timestamp: rec.time,
        type: JOIN_REQUEST_MESSAGE_TYPE,
        attachment: null,
        replyTo: null,
        event: { kind: "join_request", totalPending: rec.totalPending, time: rec.time },
    };
}

/**
 * Normalise getPendingGroupMembers output into { time, requests: [{userId, name, avatar}] }.
 * @param {object} res
 */
export function pendingFromApi(res) {
    const users = Array.isArray(res?.users) ? res.users : [];
    return {
        time: Number(res?.time) || null,
        requests: users
            .map((u) => ({ userId: String(u?.uid || ""), name: u?.dpn || null, avatar: u?.avatar || null }))
            .filter((u) => u.userId),
    };
}

/**
 * Normalise reviewPendingMemberRequest output into one outcome per requested member.
 * A member Zalo did not report back is "unknown" rather than silently counted as done.
 * @param {object} res - { [memberId]: statusCode }
 * @param {string[]} userIds
 * @returns {Array<{userId: string, outcome: string, code: number|null}>}
 */
export function reviewOutcomes(res, userIds) {
    const map = res && typeof res === "object" ? res : {};
    return userIds.map((id) => {
        const raw = map[id];
        const code = raw === undefined || raw === null || raw === "" ? null : Number(raw);
        let outcome = "unknown";
        if (code !== null && Number.isFinite(code)) outcome = REVIEW_STATUS[code] || `error_${code}`;
        return { userId: id, outcome, code: Number.isFinite(code) ? code : null };
    });
}

/** Hint added to errors: the usual reason a review or listing fails. */
export const ADMIN_HINT =
    "This account must be the group's owner or a deputy, and the group must require approval for new members.";
