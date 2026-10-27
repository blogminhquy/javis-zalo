/**
 * Group board: list the notes, pinned messages and polls of a Zalo group, and edit a note without touching its pin.
 *
 * Why this module exists (Javis report, 27/10/2026, a wedding studio that keeps one group per customer with a
 * pinned "service info" note):
 *   - nothing listed what a group has on its board, so Javis could not read a note a staff member wrote or edited
 *     by hand on the phone;
 *   - `group note-edit` went through zca-js `editNote`, which sends `pinAct: options.pinAct ? 1 : 2`. With no `--pin`
 *     the request carried 2, and 2 is the UNPIN action (`createNote` uses 0 for "no pin"), so fixing a typo in a
 *     pinned note also took it off the pin bar.
 *
 * Zalo's `pinAct` is an action, not a state: 1 = pin, 2 = unpin, 0 = no pin action (what `createNote` sends for a
 * note that is not pinned). zca-js cannot send 0 to the edit endpoint, so `editNote` here registers its own call to
 * the same endpoint (zca-js `api.custom`) and sends the action asked for, "keep" by default.
 *
 * The board list does not say whether a NOTE is pinned (zca-js `NoteDetail` has no such field), so a note's
 * `pinned` is null ("unknown"); a pinned message is pinned by definition. The raw item is kept under `raw` for the
 * JSON output, so a field Zalo adds later is not lost on the way.
 *
 * zca-js `getListBoard` always sends `last_id: 0` and pages by `page`; `listBoard` walks the pages and drops what
 * it has already seen, so it stops on its own if Zalo ignores `page` and hands back page 1 again.
 */

export const BOARD_TYPES = Object.freeze({ note: 1, pin: 2, poll: 3 });
const TYPE_NAMES = Object.freeze({ 1: "note", 2: "pin", 3: "poll" });

/** Zalo's pin action on the edit endpoint. */
export const PIN_ACT = Object.freeze({ keep: 0, pin: 1, unpin: 2 });

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGES = 10;

/**
 * The pin action for `--pin` / `--unpin` / `--keep-pin` (none: keep the note as it is).
 *
 * `--keep-pin` says the default out loud. A caller that must never unpin by accident (the Javis Store plugin) always
 * passes one of the three: javis-zalo 1.7.0 and older reject `--keep-pin` as an unknown option instead of falling
 * back to their old "no flag = unpin" behaviour.
 * @param {{pin?: boolean, unpin?: boolean, keepPin?: boolean}} opts
 */
export function pinActFrom(opts = {}) {
    if ([opts.pin, opts.unpin, opts.keepPin].filter(Boolean).length > 1) {
        throw new Error("choose one of --pin, --unpin or --keep-pin");
    }
    if (opts.pin) return PIN_ACT.pin;
    if (opts.unpin) return PIN_ACT.unpin;
    return PIN_ACT.keep;
}

function asText(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

function parseParams(params) {
    if (typeof params !== "string") return params && typeof params === "object" ? params : {};
    try {
        const p = JSON.parse(params);
        return p && typeof p === "object" ? p : {};
    } catch {
        return { title: params };
    }
}

/**
 * One board item (zca-js `BoardItem`) as a flat record.
 * @returns {{id: string, type: string, text: string, pinned: boolean|null, creatorId: string, editorId: string,
 *            createTime: number, editTime: number, raw: object}}
 */
export function normalizeBoardItem(item) {
    const boardType = Number(item?.boardType);
    const d = item?.data || {};
    const type = TYPE_NAMES[boardType] || "other";
    if (type === "poll") {
        return {
            id: String(d.poll_id ?? d.id ?? ""),
            type,
            text: asText(d.question),
            pinned: null,
            creatorId: String(d.creator ?? ""),
            editorId: "",
            createTime: Number(d.created_time) || 0,
            editTime: Number(d.updated_time) || 0,
            raw: item,
        };
    }
    const p = parseParams(d.params);
    return {
        id: String(d.id ?? ""),
        type,
        // A note's text is params.title; a pinned message carries its own fields (title for text, others for media).
        text: asText(p.title ?? p.msg ?? p.content ?? p.description ?? ""),
        pinned: type === "pin" ? true : null,
        creatorId: String(d.creatorId ?? ""),
        editorId: String(d.editorId ?? ""),
        createTime: Number(d.createTime) || 0,
        editTime: Number(d.editTime) || 0,
        raw: item,
    };
}

/**
 * Every board item of a group, all pages.
 * @param {object} api - zca-js API (needs `getListBoard`)
 * @param {string} groupId
 * @param {{type?: "note"|"pin"|"poll"|"all", count?: number, maxPages?: number}} opts
 * @returns {Promise<{items: object[], pages: number, truncated: boolean}>}
 */
export async function listBoard(api, groupId, opts = {}) {
    const type = opts.type || "all";
    if (type !== "all" && !BOARD_TYPES[type]) throw new Error(`unknown type "${type}" (note, pin, poll or all)`);
    const count = Math.max(1, Math.min(50, Number(opts.count) || DEFAULT_PAGE_SIZE));
    const maxPages = Math.max(1, Number(opts.maxPages) || MAX_PAGES);
    const seen = new Set();
    const items = [];
    let pages = 0;
    let truncated = false;
    for (let page = 1; page <= maxPages; page++) {
        const res = await api.getListBoard({ page, count }, groupId);
        pages = page;
        const batch = Array.isArray(res?.items) ? res.items : [];
        let fresh = 0;
        for (const raw of batch) {
            const rec = normalizeBoardItem(raw);
            const key = `${rec.type}:${rec.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            fresh++;
            if (type === "all" || rec.type === type) items.push(rec);
        }
        if (batch.length < count || fresh === 0) break;
        if (page === maxPages) truncated = true;
    }
    return { items, pages, truncated };
}

const EDIT_CALL = "javisEditNote";

/**
 * Register the edit call on this API instance (once). Same endpoint and body as zca-js `editNote`, except that the
 * pin action is passed through as given, so 0 ("leave the pin alone") reaches Zalo.
 */
export function ensureEditCall(api) {
    if (typeof api[EDIT_CALL] === "function") return;
    api.custom(EDIT_CALL, async ({ ctx, utils, props }) => {
        const serviceURL = utils.makeURL(`${api.zpwServiceMap.group_board[0]}/api/board/topic/updatev2`);
        const params = {
            grid: props.groupId,
            type: 0,
            color: -16777216,
            emoji: "",
            startTime: -1,
            duration: -1,
            params: JSON.stringify({ title: props.title }),
            topicId: props.noteId,
            repeat: 0,
            imei: ctx.imei,
            pinAct: props.pinAct,
        };
        const encrypted = utils.encodeAES(JSON.stringify(params));
        if (!encrypted) throw new Error("Failed to encrypt params");
        const response = await utils.request(serviceURL, {
            method: "POST",
            body: new URLSearchParams({ params: encrypted }),
        });
        return utils.resolve(response, (result) => {
            const data = result.data;
            if (data && typeof data.params === "string") {
                try {
                    data.params = JSON.parse(data.params);
                } catch {
                    /* keep the string */
                }
            }
            return data;
        });
    });
}

/**
 * Edit a note's text. `pinAct` defaults to keep: the note stays pinned if it was, unpinned if it was not.
 * @returns {Promise<object>} Zalo's answer (the edited topic, with its new `editTime`)
 */
export async function editNote(api, groupId, noteId, title, pinAct = PIN_ACT.keep) {
    if (![PIN_ACT.keep, PIN_ACT.pin, PIN_ACT.unpin].includes(pinAct)) throw new Error(`bad pin action ${pinAct}`);
    if (!String(title || "").trim()) throw new Error("the note text is empty");
    ensureEditCall(api);
    return api[EDIT_CALL]({ groupId: String(groupId), noteId: String(noteId), title: String(title), pinAct });
}

/** One line for the human output of `group note-list`. */
export function describeItem(rec) {
    const when = rec.editTime || rec.createTime;
    const stamp = when ? new Date(when).toISOString().replace("T", " ").slice(0, 16) : "?";
    const pin = rec.pinned === true ? " [pinned]" : "";
    const text = rec.text.replace(/\s+/g, " ").slice(0, 120);
    return `${rec.type.padEnd(4)} ${rec.id}${pin}  ${stamp}  by ${rec.editorId || rec.creatorId || "?"}  ${text}`;
}
