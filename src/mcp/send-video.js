/**
 * Logic and input validation for `zalo_send_video` and `msg send-video`.
 *
 * Enforces HTTPS-only `videoUrl` and `thumbnailUrl`, non-negative `ttl`, positive dimensions,
 * hard-blocks group video sends (`threadType === 1`) without `duration > 0` (ms) before calling
 * Zalo (preventing Zalo's HTTP 500 on 0/missing group video duration), and strips signed URLs
 * from error messages.
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
 * Validate positive integer pixel dimension (`width` or `height`).
 * @param {unknown} value
 * @param {string} label
 * @param {number} defaultValue
 * @returns {number}
 */
export function assertPositiveDimension(value, label, defaultValue) {
    const resolved = value === undefined ? defaultValue : value;
    if (typeof resolved !== "number" || !Number.isFinite(resolved) || !Number.isInteger(resolved) || resolved <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return resolved;
}

/**
 * Validate video `duration` in milliseconds:
 * - Group (`threadType === 1`): REQUIRED positive integer `> 0` (Zalo returns HTTP 500 when 0/missing).
 * - DM (`threadType === 0`): optional, defaults to `0`, must be a non-negative integer when given.
 * @param {unknown} duration
 * @param {0|1} threadType
 * @returns {number}
 */
export function assertValidVideoDuration(duration, threadType) {
    if (threadType === 1) {
        if (
            typeof duration !== "number" ||
            !Number.isFinite(duration) ||
            !Number.isInteger(duration) ||
            duration <= 0
        ) {
            throw new Error("Group sendVideo requires duration > 0 (milliseconds).");
        }
        return duration;
    }
    if (duration === undefined) return 0;
    if (typeof duration !== "number" || !Number.isFinite(duration) || !Number.isInteger(duration) || duration < 0) {
        throw new Error("duration must be a non-negative integer (milliseconds).");
    }
    return duration;
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
 * Validate all inputs for sending a video message.
 * @param {{
 *   threadId: unknown,
 *   videoUrl: unknown,
 *   thumbnailUrl: unknown,
 *   caption?: unknown,
 *   duration?: unknown,
 *   width?: unknown,
 *   height?: unknown,
 *   ttl?: unknown,
 *   threadType?: unknown,
 * }} args
 */
export function validateSendVideoInput({
    threadId,
    videoUrl,
    thumbnailUrl,
    caption = "",
    duration,
    width = 1280,
    height = 720,
    ttl = 0,
    threadType = 0,
} = {}) {
    const validThreadId = assertThreadId(threadId);
    const validThreadType = assertThreadType(threadType);
    const validVideoUrl = assertHttpsUrl(videoUrl, "videoUrl");
    const validThumbnailUrl = assertHttpsUrl(thumbnailUrl, "thumbnailUrl");
    if (typeof caption !== "string") {
        throw new Error("caption must be a string.");
    }
    const validDuration = assertValidVideoDuration(duration, validThreadType);
    const validWidth = assertPositiveDimension(width, "width", 1280);
    const validHeight = assertPositiveDimension(height, "height", 720);
    const validTtl = assertValidTtl(ttl);
    return {
        threadId: validThreadId,
        videoUrl: validVideoUrl,
        thumbnailUrl: validThumbnailUrl,
        caption,
        duration: validDuration,
        width: validWidth,
        height: validHeight,
        ttl: validTtl,
        threadType: validThreadType,
    };
}

/**
 * Send a video message from HTTPS `videoUrl` and `thumbnailUrl` to a Zalo DM or group thread.
 * @param {object} api - zca-js API instance
 * @param {{
 *   threadId: string,
 *   videoUrl: string,
 *   thumbnailUrl: string,
 *   caption?: string,
 *   duration?: number,
 *   width?: number,
 *   height?: number,
 *   ttl?: number,
 *   threadType?: number,
 * }} args
 * @returns {Promise<{ success: true, messageId: string|null, threadId: string, threadType: number }>}
 */
export async function sendVideoMessage(api, args = {}) {
    const valid = validateSendVideoInput(args);
    let result;
    try {
        result = await api.sendVideo(
            {
                videoUrl: valid.videoUrl,
                thumbnailUrl: valid.thumbnailUrl,
                msg: valid.caption,
                duration: valid.duration,
                width: valid.width,
                height: valid.height,
                ttl: valid.ttl,
            },
            valid.threadId,
            valid.threadType,
        );
    } catch (e) {
        throw new Error(redactUrls(String(e?.message || e), [args?.videoUrl, args?.thumbnailUrl]));
    }
    const rawMsgId = result?.msgId ?? result?.message?.msgId ?? null;
    return {
        success: true,
        messageId: rawMsgId !== null && rawMsgId !== undefined ? String(rawMsgId) : null,
        threadId: valid.threadId,
        threadType: valid.threadType,
    };
}
