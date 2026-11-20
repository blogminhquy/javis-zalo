/**
 * Logic and input validation for `zalo_send_voice` and `msg send-voice`.
 *
 * Enforces HTTPS-only media URLs, non-negative integer `ttl`, valid thread targets,
 * and ensures signed URLs (query tokens/signatures) are never echoed in logs or errors.
 */

const VALID_PROTOCOLS = new Set(["https:"]);

/**
 * Strip URLs and any known secret URL/query substrings from an error message so signed
 * media URLs never leak to logs, stderr, stdout, or MCP error responses.
 * @param {string} message
 * @param {Array<string|undefined|null>} [secrets]
 * @returns {string}
 */
export function redactUrls(message, secrets = []) {
    let out = String(message ?? "");
    for (const raw of secrets) {
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        out = out.split(raw).join("[redacted-url]");
        out = out.split(trimmed).join("[redacted-url]");
        try {
            const parsed = new URL(trimmed);
            if (parsed.search && parsed.search.length > 1) {
                out = out.split(parsed.search).join("?[redacted]");
                out = out.split(parsed.search.slice(1)).join("[redacted]");
            }
        } catch {
            // Ignore unparseable secret candidates
        }
    }
    return out.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi, "[redacted-url]");
}

/**
 * Validate that `url` is a well-formed `https://` URL without mutating its encoding
 * (mutating percent-encoding would invalidate pre-signed storage URLs) and without
 * echoing the URL or its query string on failure.
 * @param {unknown} url
 * @param {string} [label]
 * @returns {string}
 */
export function assertHttpsUrl(url, label = "url") {
    if (typeof url !== "string") {
        throw new Error(`${label} must be a valid https:// URL.`);
    }
    const trimmed = url.trim();
    if (!trimmed || /\s/.test(trimmed)) {
        throw new Error(`${label} must be a valid https:// URL.`);
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error(`${label} must be a valid https:// URL.`);
    }
    if (!VALID_PROTOCOLS.has(parsed.protocol)) {
        const scheme = parsed.protocol || "invalid";
        throw new Error(`${label} must use https:// (got ${scheme}).`);
    }
    if (!parsed.hostname) {
        throw new Error(`${label} must be a valid https:// URL.`);
    }
    return trimmed;
}

/**
 * Validate `ttl` as a finite non-negative integer in milliseconds (default 0).
 * @param {unknown} [ttl]
 * @returns {number}
 */
export function assertValidTtl(ttl = 0) {
    if (typeof ttl !== "number" || !Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl < 0) {
        throw new Error("ttl must be a non-negative integer.");
    }
    return ttl;
}

/**
 * Validate `threadId` as a non-empty string.
 * @param {unknown} threadId
 * @returns {string}
 */
function assertThreadId(threadId) {
    if (typeof threadId !== "string" || !threadId.trim()) {
        throw new Error("threadId must be a non-empty string.");
    }
    return threadId.trim();
}

/**
 * Validate `threadType` as 0 (DM/User) or 1 (Group).
 * @param {unknown} [threadType]
 * @returns {0|1}
 */
function assertThreadType(threadType = 0) {
    if (typeof threadType === "boolean" || threadType === null) {
        throw new Error("threadType must be 0 (User) or 1 (Group).");
    }
    if (typeof threadType === "string" && !threadType.trim()) {
        throw new Error("threadType must be 0 (User) or 1 (Group).");
    }
    const n = Number(threadType);
    if (!Number.isInteger(n) || (n !== 0 && n !== 1)) {
        throw new Error("threadType must be 0 (User) or 1 (Group).");
    }
    return n;
}

/**
 * Validate all inputs for sending a voice message.
 * @param {{ threadId: unknown, voiceUrl: unknown, threadType?: unknown, ttl?: unknown }} args
 * @returns {{ threadId: string, voiceUrl: string, threadType: 0|1, ttl: number }}
 */
export function validateSendVoiceInput({ threadId, voiceUrl, threadType = 0, ttl = 0 } = {}) {
    return {
        threadId: assertThreadId(threadId),
        threadType: assertThreadType(threadType),
        voiceUrl: assertHttpsUrl(voiceUrl, "voiceUrl"),
        ttl: assertValidTtl(ttl),
    };
}

/**
 * Send a voice message from an HTTPS URL to a Zalo DM or group thread.
 * @param {object} api - zca-js API instance
 * @param {{ threadId: string, voiceUrl: string, threadType?: number, ttl?: number }} args
 * @returns {Promise<{ success: true, messageId: string|null, threadId: string, threadType: number }>}
 */
export async function sendVoiceMessage(api, args = {}) {
    const valid = validateSendVoiceInput(args);
    let result;
    try {
        result = await api.sendVoice({ voiceUrl: valid.voiceUrl, ttl: valid.ttl }, valid.threadId, valid.threadType);
    } catch (e) {
        throw new Error(redactUrls(String(e?.message || e), [args?.voiceUrl]));
    }
    const rawMsgId = result?.msgId ?? result?.message?.msgId ?? null;
    return {
        success: true,
        messageId: rawMsgId !== null && rawMsgId !== undefined ? String(rawMsgId) : null,
        threadId: valid.threadId,
        threadType: valid.threadType,
    };
}
