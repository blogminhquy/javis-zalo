/**
 * Download Zalo media (images, audio, video, files) to local filesystem, organized by thread name.
 * Folder structure: {downloadDir}/{threadName}/{date}_{time}_{sender}_{msgId}.{ext}
 * Cross-platform: opens media with the system viewer (open/xdg-open/explorer) only when a GUI is available.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { extname, join, resolve, sep } from "path";
import { openExternal } from "../utils/open-external.js";
import { CONFIG_DIR } from "../core/credentials.js";

/** Default download directory when not configured */
const DEFAULT_DIR = join(CONFIG_DIR, "media");

/** Maximum media payload size (60 MB, matching Javis video limit) */
export const MAX_MEDIA_BYTES = 60 * 1024 * 1024;

/** Maximum HTTP redirect hops allowed */
export const MAX_REDIRECTS = 3;

/** Characters unsafe for filesystem paths — stripped from folder/file names */
const UNSAFE_CHARS = /[/\\:*?"<>|]/g;

/** Map both normalized labels and raw zca-js msgType strings to canonical media kinds */
const RAW_TYPE_TO_KIND = {
    image: "image",
    photo: "image",
    "chat.photo": "image",
    gif: "gif",
    "chat.gif": "gif",
    audio: "audio",
    voice: "voice",
    "chat.voice": "voice",
    video: "video",
    "chat.video.msg": "video",
    file: "file",
    "share.file": "file",
};

/** Extension lookup by content-type prefix */
const CONTENT_TYPE_MAP = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "audio/amr": "amr",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "application/pdf": "pdf",
    "application/zip": "zip",
};

/** Reverse map from extension to canonical MIME type */
const EXT_TO_MIME = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    wav: "audio/wav",
    flac: "audio/flac",
    amr: "audio/amr",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    pdf: "application/pdf",
    zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    json: "application/json",
    yaml: "application/yaml",
    yml: "application/yaml",
    log: "text/plain",
};

/** Safe document/text extensions allowed for `file` attachments when no binary magic header matches */
const SAFE_TEXT_FILE_EXTS = new Set(["txt", "md", "csv", "tsv", "json", "yaml", "yml", "log"]);

/** Office/archive extensions that use a ZIP container */
const ZIP_CONTAINER_EXTS = new Set(["zip", "docx", "xlsx", "pptx"]);

/** Fallback extension by canonical media kind when URL and content-type give no clue */
const TYPE_DEFAULT_EXT = {
    image: "jpg",
    audio: "mp3",
    voice: "mp3",
    video: "mp4",
    gif: "gif",
    file: "bin",
};

/**
 * Normalize a message type (including raw zca-js `msgType` values like `chat.photo`,
 * `chat.voice`, `chat.video.msg`, `share.file`, `chat.gif`) into a canonical media kind.
 * @param {string} [type]
 * @returns {string} Canonical media kind ("image"|"gif"|"audio"|"voice"|"video"|"file") or ""
 */
export function normalizeMediaKind(type) {
    if (!type || typeof type !== "string") return "";
    return RAW_TYPE_TO_KIND[type.trim().toLowerCase()] || "";
}

/**
 * Sanitize a string for use as a single filesystem path component.
 * Rejects `.` / `..`, strips path separators and control characters, and caps length.
 * @param {string} name
 * @returns {string}
 */
export function sanitize(name) {
    let cleaned = "";
    for (const ch of String(name ?? "")) {
        const code = ch.charCodeAt(0);
        if (code <= 0x1f || code === 0x7f) {
            cleaned += "_";
        } else {
            cleaned += ch;
        }
    }
    cleaned = cleaned
        .trim()
        .replace(/^\.+|\.+$/g, "")
        .replace(UNSAFE_CHARS, "_")
        .replace(/\.{2,}/g, "_")
        .trim();
    if (!cleaned || cleaned === "." || cleaned === ".." || /^_+$/.test(cleaned)) return "unknown";
    return cleaned.slice(0, 120);
}

/**
 * Check if four IPv4 octets fall in any non-global range (loopback, private, link-local, CGNAT, multicast, reserved).
 * @param {number[]} parts
 * @returns {boolean}
 */
function isUnsafeIpv4Parts(parts) {
    if (!Array.isArray(parts) || parts.length !== 4) return true;
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) ||
        a >= 224
    );
}

/**
 * Check if a hostname points to localhost, a private/link-local IP, or an internal domain.
 * Handles WHATWG URL hex-normalized IPv4-mapped IPv6 addresses (`::ffff:7f00:1`) and `fe80::/10` (`fe80`..`febf`).
 * @param {string} hostname
 * @returns {boolean}
 */
function isUnsafeHost(hostname) {
    const host = String(hostname || "")
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "");
    if (!host) return true;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
        return true;
    }
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
        return true;
    }
    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
        return isUnsafeIpv4Parts(ipv4Match.slice(1).map(Number));
    }
    if (host.includes(":")) {
        if (
            host === "::1" ||
            host === "::" ||
            /^0*(?::0*){1,7}:0*[01]$/.test(host) ||
            /^fe[89ab][0-9a-f]:/.test(host) ||
            host.startsWith("fc") ||
            host.startsWith("fd") ||
            host.startsWith("ff")
        ) {
            return true;
        }
        const mappedHex = host.match(/^(?:::(?:ffff:)?|(?:0+:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (mappedHex) {
            const hi = parseInt(mappedHex[1], 16);
            const lo = parseInt(mappedHex[2], 16);
            return isUnsafeIpv4Parts([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
        }
        const mappedDotted = host.match(/^(?:::(?:ffff:)?|(?:0+:){5}ffff:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (mappedDotted) {
            return isUnsafeIpv4Parts(mappedDotted.slice(1).map(Number));
        }
    }
    return false;
}

/**
 * Validate a media download URL: must be HTTPS without embedded credentials or private/local hosts.
 * Never echoes the raw URL or query parameters in error messages.
 * @param {string} rawUrl
 * @returns {string} Validated URL string
 */
export function validateMediaUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
        throw new Error("Invalid media URL: URL is empty");
    }
    let parsed;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        throw new Error("Invalid media URL: malformed URL");
    }
    if (parsed.protocol !== "https:") {
        throw new Error("Invalid media URL: only HTTPS URLs are allowed");
    }
    if (parsed.username || parsed.password) {
        throw new Error("Invalid media URL: embedded credentials are not allowed");
    }
    if (isUnsafeHost(parsed.hostname)) {
        throw new Error("Invalid media URL: unsafe or private host is not allowed");
    }
    return parsed.toString();
}

/**
 * Sniff a buffer's leading magic bytes to determine its actual media format.
 * @param {Buffer} buffer
 * @returns {{ mimeType: string, ext: string, kind: string } | null}
 */
export function sniffMediaBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) return null;

    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { mimeType: "image/jpeg", ext: "jpg", kind: "image" };
    }
    if (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    ) {
        return { mimeType: "image/png", ext: "png", kind: "image" };
    }
    if (buffer.length >= 6) {
        const gifHead = buffer.subarray(0, 6).toString("ascii");
        if (gifHead === "GIF87a" || gifHead === "GIF89a") {
            return { mimeType: "image/gif", ext: "gif", kind: "gif" };
        }
    }
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF") {
        const subtype = buffer.subarray(8, 12).toString("ascii");
        if (subtype === "WEBP") return { mimeType: "image/webp", ext: "webp", kind: "image" };
        if (subtype === "WAVE") return { mimeType: "audio/wav", ext: "wav", kind: "audio" };
        if (subtype === "AVI ") return { mimeType: "video/x-msvideo", ext: "avi", kind: "video" };
    }
    if (buffer.length >= 14 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
        return { mimeType: "image/bmp", ext: "bmp", kind: "image" };
    }
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
        const brand = buffer.subarray(8, 12).toString("ascii");
        if (brand === "M4A " || brand === "M4B ") {
            return { mimeType: "audio/mp4", ext: "m4a", kind: "audio" };
        }
        if (brand === "qt  ") {
            return { mimeType: "video/quicktime", ext: "mov", kind: "video" };
        }
        return { mimeType: "video/mp4", ext: "mp4", kind: "video" };
    }
    if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS") {
        return { mimeType: "audio/ogg", ext: "ogg", kind: "audio" };
    }
    if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "fLaC") {
        return { mimeType: "audio/flac", ext: "flac", kind: "audio" };
    }
    if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "#!AMR") {
        return { mimeType: "audio/amr", ext: "amr", kind: "audio" };
    }
    if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
        return { mimeType: "video/webm", ext: "webm", kind: "video" };
    }
    if (buffer.length >= 10 && buffer.subarray(0, 3).toString("ascii") === "ID3") {
        return { mimeType: "audio/mpeg", ext: "mp3", kind: "audio" };
    }
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
        if ((buffer[1] & 0xf6) === 0xf0) {
            return { mimeType: "audio/aac", ext: "aac", kind: "audio" };
        }
        if (((buffer[1] >> 1) & 3) !== 0) {
            return { mimeType: "audio/mpeg", ext: "mp3", kind: "audio" };
        }
    }
    if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
        return { mimeType: "application/pdf", ext: "pdf", kind: "file" };
    }
    if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
        return { mimeType: "application/zip", ext: "zip", kind: "file" };
    }
    return null;
}

/**
 * Detect whether a payload is an HTML/XML/JSON error page disguised as a media response.
 * @param {Buffer} buffer
 * @param {string} [contentType]
 * @returns {string|null} Description of the disguised error payload, or null
 */
function detectDisguisedErrorBody(buffer, contentType) {
    const ct = String(contentType || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
    const head = buffer.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
    if (
        ct === "text/html" ||
        ct === "application/xhtml+xml" ||
        head.startsWith("<!doctype html") ||
        head.startsWith("<html") ||
        head.startsWith("<head") ||
        head.startsWith("<body") ||
        head.startsWith("<?xml") ||
        head.startsWith("<error")
    ) {
        return "HTML/XML error body";
    }
    if (
        (ct === "application/json" || ct === "application/problem+json") &&
        (head.startsWith("{") || head.startsWith("["))
    ) {
        return "JSON error body";
    }
    return null;
}

/**
 * Guess file extension from URL, content-type, fileName, or message type.
 * @param {string} url
 * @param {string} [contentType]
 * @param {string} [msgType] - Normalized or raw zca-js message type
 * @param {string} [fileName] - Attachment fileName hint
 * @returns {string}
 */
export function guessExtension(url, contentType, msgType, fileName = "") {
    if (contentType) {
        const ct = contentType.split(";")[0].trim().toLowerCase();
        if (CONTENT_TYPE_MAP[ct]) return CONTENT_TYPE_MAP[ct];
    }
    const nameExt = extname(String(fileName || ""))
        .replace(/^\./, "")
        .toLowerCase();
    if (nameExt && /^[a-z0-9]{1,8}$/.test(nameExt)) {
        return nameExt === "jpeg" ? "jpg" : nameExt;
    }
    let urlPath = String(url || "");
    try {
        urlPath = new URL(urlPath).pathname;
    } catch {
        urlPath = urlPath.split("?")[0];
    }
    const urlMatch = urlPath.match(
        /\.(jpeg|jpg|png|gif|webp|bmp|mp3|m4a|aac|ogg|wav|flac|amr|mp4|webm|mov|pdf|zip|docx|xlsx|pptx|txt|md|csv|tsv|json|yaml|yml|log)$/i,
    );
    if (urlMatch) return urlMatch[1].toLowerCase() === "jpeg" ? "jpg" : urlMatch[1].toLowerCase();
    const kind = normalizeMediaKind(msgType) || msgType;
    return TYPE_DEFAULT_EXT[kind] || "bin";
}

/**
 * Validate a downloaded or on-disk media buffer against the expected message type,
 * rejecting 0-byte bodies, HTML/JSON error responses, static-image-as-video, and unsupported formats.
 * @param {Buffer} buffer
 * @param {string} [contentType]
 * @param {string} [msgType]
 * @param {string} [url]
 * @param {string} [fileName]
 * @returns {{ ext: string, mimeType: string, kind: string }}
 */
export function validateMediaPayload(buffer, contentType = "", msgType = "file", url = "", fileName = "") {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error("Media payload is empty (0 bytes)");
    }
    const kind = normalizeMediaKind(msgType);
    if (!kind) {
        throw new Error(`Unsupported media type: ${msgType || "unknown"}`);
    }

    const sniffed = sniffMediaBuffer(buffer);
    const disguised = !sniffed ? detectDisguisedErrorBody(buffer, contentType) : null;
    if (disguised) {
        throw new Error(`Invalid media content: received ${disguised} instead of ${kind}`);
    }

    const ct = String(contentType || "")
        .split(";")[0]
        .trim()
        .toLowerCase();

    if (kind === "image" || kind === "gif") {
        if (!sniffed || (sniffed.kind !== "image" && sniffed.kind !== "gif")) {
            throw new Error(`Invalid image payload: unrecognized image header (Content-Type: ${ct || "none"})`);
        }
        return { ext: sniffed.ext, mimeType: sniffed.mimeType, kind };
    }

    if (kind === "audio" || kind === "voice") {
        if (!sniffed || (sniffed.kind !== "audio" && sniffed.kind !== "video")) {
            throw new Error(`Invalid audio payload: unrecognized audio header (Content-Type: ${ct || "none"})`);
        }
        if (sniffed.ext === "mp4") {
            return { ext: "m4a", mimeType: "audio/mp4", kind };
        }
        return { ext: sniffed.ext, mimeType: sniffed.mimeType, kind };
    }

    if (kind === "video") {
        if (sniffed && (sniffed.kind === "image" || sniffed.kind === "gif")) {
            throw new Error("Invalid video payload: received a static image/thumbnail instead of video");
        }
        if (!sniffed || sniffed.kind !== "video") {
            throw new Error(`Invalid video payload: unrecognized video header (Content-Type: ${ct || "none"})`);
        }
        return { ext: sniffed.ext, mimeType: sniffed.mimeType, kind };
    }

    // kind === "file"
    const hintedExt = guessExtension(url, contentType, kind, fileName);
    if (sniffed) {
        if (sniffed.ext === "zip" && ZIP_CONTAINER_EXTS.has(hintedExt)) {
            return { ext: hintedExt, mimeType: EXT_TO_MIME[hintedExt] || sniffed.mimeType, kind };
        }
        return { ext: sniffed.ext, mimeType: sniffed.mimeType, kind };
    }
    if (SAFE_TEXT_FILE_EXTS.has(hintedExt) && !buffer.includes(0x00)) {
        return { ext: hintedExt, mimeType: EXT_TO_MIME[hintedExt] || "text/plain", kind };
    }
    throw new Error(`Unsupported or unrecognized file format (${hintedExt || ct || "unknown"})`);
}

/**
 * Verify an already-downloaded local media file on disk before returning it to a tool consumer.
 * @param {string} filePath
 * @param {string} [msgType]
 * @param {number} [maxBytes]
 * @returns {{ bytes: number, mimeType: string, ext: string }}
 */
export function verifyLocalMediaFile(filePath, msgType = "file", maxBytes = MAX_MEDIA_BYTES) {
    if (!filePath || !existsSync(filePath)) {
        throw new Error("Local media file does not exist");
    }
    const lst = lstatSync(filePath);
    if (lst.isSymbolicLink() || !lst.isFile()) {
        throw new Error("Local media path is not a regular file");
    }
    if (lst.size === 0) {
        throw new Error("Local media file is empty (0 bytes)");
    }
    if (lst.size > maxBytes) {
        throw new Error(`Local media file exceeds size limit (${maxBytes} bytes)`);
    }
    const buffer = readFileSync(filePath);
    const { ext, mimeType } = validateMediaPayload(buffer, "", msgType, filePath, filePath);
    return { bytes: buffer.length, mimeType, ext };
}

/**
 * Check if a message type is downloadable media.
 * Supports both normalized labels (`image`, `voice`, `video`, `file`) and raw `zca-js` `msgType` values.
 * @param {string} type
 * @returns {boolean}
 */
export function isDownloadableMedia(type) {
    return Boolean(normalizeMediaKind(type));
}

/**
 * Check whether the current environment can launch a GUI viewer.
 * Headless Linux containers without DISPLAY or WAYLAND_DISPLAY cannot open a desktop viewer.
 * @param {string} [platform]
 * @param {object} [env]
 * @returns {boolean}
 */
export function canOpenGui(platform = process.platform, env = process.env) {
    if (platform === "linux") {
        return Boolean(env?.DISPLAY || env?.WAYLAND_DISPLAY);
    }
    return true;
}

/**
 * Build the folder name for a thread.
 * Groups: thread display name. DMs: "DM_{senderName}".
 * @param {object} message - Normalized message
 * @param {string} [threadName] - Resolved thread name from cache
 * @returns {string}
 */
function buildFolderName(message, threadName) {
    if (message.threadType === "group") {
        return sanitize(threadName || message.threadId);
    }
    return sanitize(`DM_${threadName || message.senderName || message.senderId}`);
}

/**
 * Build a descriptive filename from message metadata.
 * Format: {YYYY-MM-DD}_{HH-mm}_{sender}_{msgId}.{ext}
 * @param {object} message
 * @param {string} ext - File extension
 * @returns {string}
 */
function buildFileName(message, ext) {
    const ts = Number.isFinite(Number(message.timestamp)) ? Number(message.timestamp) : Date.now();
    const d = new Date(ts);
    const date = d.toISOString().slice(0, 10); // YYYY-MM-DD
    const time = `${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}`;
    const sender = sanitize(message.senderName || message.senderId);
    const rawId = String(message.id ?? message.msgId ?? "noId");
    const msgId = sanitize(rawId).slice(-8) || "noId";
    const safeExt =
        sanitize(ext)
            .replace(/[^a-z0-9]/gi, "")
            .toLowerCase() || "bin";
    return `${date}_${time}_${sender}_${msgId}.${safeExt}`;
}

/**
 * Ensure `targetPath` resolves strictly inside `baseDir` and that neither `baseDir` nor `targetPath` is a symlink.
 * @param {string} baseDir
 * @param {string} targetPath
 * @returns {string} Resolved targetPath
 */
function assertSafeDestination(baseDir, targetPath) {
    const resolvedBase = resolve(baseDir);
    const resolvedTarget = resolve(targetPath);
    if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + sep)) {
        throw new Error("Target path escapes download directory");
    }
    if (existsSync(resolvedBase) && lstatSync(resolvedBase).isSymbolicLink()) {
        throw new Error("Download base directory cannot be a symlink");
    }
    if (existsSync(resolvedTarget) && lstatSync(resolvedTarget).isSymbolicLink()) {
        throw new Error("Target media path cannot be a symlink");
    }
    return resolvedTarget;
}

/**
 * Open a file with the system's default viewer (cross-platform).
 * Exported for use by MCP tools.
 * @param {string} filePath
 */
export function openFile(filePath) {
    openExternal(filePath);
}

/**
 * Auto-download media in background when a message arrives.
 * Non-blocking — fires and forgets. Mutates message.attachment.localPath on success.
 * @param {object} message - Normalized message (will be mutated with localPath)
 * @param {object} [options]
 * @param {string} [options.downloadDir] - Base download directory
 * @param {string} [options.threadName] - Thread display name from cache
 */
export function autoDownloadMedia(message, options = {}) {
    if (!message.attachment?.url) return;
    downloadMedia(message, { ...options, autoOpen: false }).then(
        (result) => {
            message.attachment.localPath = result.path;
            console.error(`[media-dl] Saved (${result.bytes} bytes, ${result.mimeType})`);
        },
        (err) => {
            console.error(`[media-dl] Auto-download failed: ${err.message}`);
        },
    );
}

/**
 * Read a fetch Response body into a Buffer while enforcing `maxBytes` during streaming.
 * Cancels the stream immediately if accumulated bytes exceed `maxBytes`.
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readResponseBuffer(response, maxBytes) {
    if (typeof response?.body?.getReader === "function") {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = Buffer.from(value);
                total += chunk.length;
                if (total > maxBytes) {
                    await reader.cancel().catch(() => {});
                    throw new Error(`Media exceeds size limit (${maxBytes} bytes)`);
                }
                chunks.push(chunk);
            }
        } catch (err) {
            await reader.cancel().catch(() => {});
            if (err instanceof Error && err.message.startsWith("Media exceeds size limit")) {
                throw err;
            }
            const code = err?.cause?.code || err?.code || err?.name || "read error";
            throw new Error(`Download failed: stream error (${code})`);
        }
        return Buffer.concat(chunks, total);
    }

    let rawBuffer;
    try {
        rawBuffer = Buffer.from(await response.arrayBuffer());
    } catch (err) {
        const code = err?.cause?.code || err?.code || err?.name || "read error";
        throw new Error(`Download failed: body read error (${code})`);
    }
    if (rawBuffer.length > maxBytes) {
        throw new Error(`Media exceeds size limit (${maxBytes} bytes)`);
    }
    return rawBuffer;
}

/**
 * Download media from URL and save atomically to organized local folder.
 * @param {object} message - Normalized or history message with attachment.url
 * @param {object} [options]
 * @param {string} [options.downloadDir] - Base download directory
 * @param {boolean} [options.autoOpen] - Open media with system viewer after download
 * @param {string} [options.threadName] - Thread display name from cache
 * @param {number} [options.maxBytes] - Override max allowed bytes (default 60 MB)
 * @param {typeof fetch} [options.fetch] - Custom fetch implementation (for testing)
 * @returns {Promise<{ success: boolean, path: string, folder: string, fileName: string, bytes: number, mimeType: string, mediaType: string }>}
 */
export async function downloadMedia(message, options = {}) {
    const rawUrl = message?.attachment?.url;
    if (!rawUrl) throw new Error("Message has no attachment URL");

    const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_MEDIA_BYTES;
    const declaredSize = Number(message?.attachment?.fileSize);
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        throw new Error(`Media exceeds size limit (${maxBytes} bytes)`);
    }

    const baseDir = resolve(options.downloadDir || DEFAULT_DIR);
    const folder = buildFolderName(message, options.threadName);
    const folderPath = assertSafeDestination(baseDir, join(baseDir, folder));
    mkdirSync(folderPath, { recursive: true });
    assertSafeDestination(baseDir, folderPath);

    const fetchFn = options.fetch || fetch;
    let currentUrl = validateMediaUrl(rawUrl);
    let response = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        try {
            response = await fetchFn(currentUrl, { redirect: "manual" });
        } catch (err) {
            const code = err?.cause?.code || err?.code || err?.name || "fetch error";
            throw new Error(`Download failed: network error (${code})`);
        }
        const status = Number(response?.status || 0);
        if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
            if (hop === MAX_REDIRECTS) {
                throw new Error("Download failed: too many redirects");
            }
            const location = response.headers?.get?.("location");
            if (!location) {
                throw new Error("Download failed: redirect missing Location header");
            }
            let resolvedNext;
            try {
                resolvedNext = new URL(location, currentUrl).toString();
            } catch {
                throw new Error("Download failed: invalid redirect Location header");
            }
            currentUrl = validateMediaUrl(resolvedNext);
            continue;
        }
        break;
    }

    if (!response || !response.ok) {
        throw new Error(`Download failed: HTTP ${response?.status ?? "unknown"}`);
    }

    const contentLengthHeader = response.headers?.get?.("content-length");
    if (contentLengthHeader !== null && contentLengthHeader !== undefined && contentLengthHeader !== "") {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            throw new Error(`Media exceeds size limit (${maxBytes} bytes)`);
        }
    }

    const contentType = response.headers?.get?.("content-type") || "";
    const msgType = message.type || message.attachment?.type || "file";
    const rawFileName = message.attachment?.fileName || message.attachment?.description || "";

    const buffer = await readResponseBuffer(response, maxBytes);

    const { ext, mimeType } = validateMediaPayload(buffer, contentType, msgType, currentUrl, rawFileName);
    const fileName = buildFileName(message, ext);
    const filePath = assertSafeDestination(folderPath, join(folderPath, fileName));
    const partPath = assertSafeDestination(
        folderPath,
        join(folderPath, `${fileName}.${process.pid}.${Date.now()}.part`),
    );

    try {
        writeFileSync(partPath, buffer);
        renameSync(partPath, filePath);
    } finally {
        try {
            if (existsSync(partPath)) unlinkSync(partPath);
        } catch {
            // ignore cleanup errors
        }
    }

    const writtenSize = statSync(filePath).size;
    if (writtenSize <= 0 || writtenSize !== buffer.length) {
        try {
            unlinkSync(filePath);
        } catch {
            // ignore
        }
        throw new Error("Atomic media write verification failed");
    }

    if (message.attachment && typeof message.attachment === "object") {
        message.attachment.localPath = filePath;
    }

    if (options.autoOpen && canOpenGui()) {
        openFile(filePath);
    }

    return {
        success: true,
        path: filePath,
        folder,
        fileName,
        bytes: buffer.length,
        mimeType,
        mediaType: msgType,
    };
}
