/**
 * Zalo conversation labels ("thẻ phân loại", the tags an owner puts on chats in the Zalo app).
 *
 * zca-js `getLabels()` returns `{ labelData: [{ id, text, conversations, color, emoji, ... }], version }`.
 * `conversations` holds Zalo's conversation ids: a user id for a 1-1 chat, "g" + group id for a group.
 * This module turns that into thread ids the other tools use, and caches the list briefly so a caller
 * that asks on every incoming message (Javis' bot) does not hit Zalo each time.
 */

/** Seconds the label list is reused before asking Zalo again. Labels change by hand in the app, rarely. */
export const LABEL_CACHE_SECONDS = 60;

const GROUP_PREFIX = /^g(\d+)$/;

/**
 * One Zalo conversation id as `{ threadId, threadType }` (0 = user, 1 = group), or null when blank.
 * @param {unknown} conv
 */
export function threadOfConversation(conv) {
    const s = String(conv ?? "").trim();
    if (!s) return null;
    const m = GROUP_PREFIX.exec(s);
    return m ? { threadId: m[1], threadType: 1 } : { threadId: s, threadType: 0 };
}

/**
 * Labels in a stable shape: `[{ id, name, emoji, color, threads: [{ threadId, threadType }] }]`, in the
 * order the owner arranged them in Zalo (`offset`). Garbage entries are dropped, never thrown on.
 * @param {object} raw - zca-js getLabels() result
 */
export function normalizeLabels(raw) {
    const list = Array.isArray(raw?.labelData) ? raw.labelData : [];
    return list
        .filter((l) => l && typeof l === "object" && String(l.text ?? "").trim())
        .map((l) => {
            const seen = new Set();
            const threads = [];
            for (const c of Array.isArray(l.conversations) ? l.conversations : []) {
                const t = threadOfConversation(c);
                if (t && !seen.has(t.threadId)) {
                    seen.add(t.threadId);
                    threads.push(t);
                }
            }
            return {
                id: l.id ?? null,
                name: String(l.text).trim(),
                emoji: String(l.emoji ?? ""),
                color: String(l.color ?? ""),
                offset: Number(l.offset ?? 0),
                threads,
            };
        })
        .sort((a, b) => a.offset - b.offset)
        .map(({ offset: _offset, ...rest }) => rest);
}

/**
 * The labels one thread carries, without the member lists: `[{ id, name, emoji, color }]`.
 * @param {ReturnType<typeof normalizeLabels>} labels
 * @param {string} threadId
 */
export function labelsOfThread(labels, threadId) {
    const id = String(threadId ?? "").trim();
    if (!id) return [];
    return labels.filter((l) => l.threads.some((t) => t.threadId === id)).map(({ threads: _threads, ...rest }) => rest);
}

/**
 * Cached reader around `api.getLabels()`.
 * @param {{ getLabels: () => Promise<object> }} api
 * @param {{ ttlSeconds?: number, now?: () => number }} [opts]
 */
export function createLabelReader(api, { ttlSeconds = LABEL_CACHE_SECONDS, now = () => Date.now() } = {}) {
    let cache = null; // { at, labels, version, lastUpdateTime }
    let inflight = null;
    return async function read({ refresh = false } = {}) {
        if (!refresh && cache && now() - cache.at < ttlSeconds * 1000) return { ...cache, cached: true };
        if (!inflight) {
            inflight = (async () => {
                const raw = await api.getLabels();
                cache = {
                    at: now(),
                    labels: normalizeLabels(raw),
                    version: raw?.version ?? null,
                    lastUpdateTime: raw?.lastUpdateTime ?? null,
                };
                return cache;
            })().finally(() => {
                inflight = null;
            });
        }
        return { ...(await inflight), cached: false };
    };
}
