/**
 * MCP tool registrations for Zalo message access and sending.
 * Registers 15 tools: zalo_get_messages, zalo_get_history, zalo_search_history, zalo_send_message,
 * zalo_send_typing, zalo_send_file, zalo_add_reaction, zalo_list_threads, zalo_search_threads, zalo_mark_read, zalo_view_media,
 * zalo_get_group_joins, zalo_list_join_requests, zalo_review_join_requests, zalo_get_labels.
 */

import { z } from "zod";
import { downloadMedia, openFile } from "./media-downloader.js";
import { parseTimeBoundary } from "./history-store.js";
import { ADMIN_HINT, pendingFromApi, reviewOutcomes } from "./join-requests.js";
import { createLabelReader, labelsOfThread } from "./labels.js";
import { REACTIONS, reactToMessage } from "./reactions.js";
import { MAX_FILES_PER_SEND, sendFileFromOutbox } from "./send-file.js";
import { OUTBOX_DIR } from "../core/send-files.js";
import { getApi, isLoggedIn } from "../core/zalo-client.js";

/** Thread type constants matching zca-js ThreadType enum */
const THREAD_USER = 0;

/**
 * Text style codes zca-js accepts in `sendMessage({ msg, styles })` (TextStyle): bold, italic, underline,
 * strikethrough, red, orange, yellow, green, small, big, bullet list, numbered list.
 */
export const STYLE_CODES = [
    "b",
    "i",
    "u",
    "s",
    "c_db342e",
    "c_f27806",
    "c_f7b503",
    "c_15a85f",
    "f_13",
    "f_18",
    "lst_1",
    "lst_2",
];
const MAX_STYLES = 100;

/**
 * Wrap a result object into MCP tool content format.
 * @param {object} result
 * @returns {{ content: Array }}
 */
function ok(result) {
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

/**
 * Wrap an error message into MCP tool error content format.
 * @param {string} message
 * @returns {{ content: Array, isError: true }}
 */
function err(message) {
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * Annotate each message with its thread's display name (per-message, so it works for
 * both single-thread and cross-thread result sets).
 * @param {Array} messages
 * @param {import("./thread-name-cache.js").ThreadNameCache} [nameCache]
 * @returns {Array} the same messages, enriched
 */
function enrichThreadNames(messages, nameCache) {
    if (!nameCache) return messages;
    for (const msg of messages) {
        const info = nameCache.get(msg.threadId);
        if (info) msg.threadName = info.name;
    }
    return messages;
}

/**
 * Register all Zalo MCP tools on the server.
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {object} api - zca-js API instance
 * @param {import("./message-buffer.js").MessageBuffer} buffer
 * @param {import("./thread-filter.js").ThreadFilter} filter
 * @param {object} config - MCP config
 * @param {import("./thread-name-cache.js").ThreadNameCache} [nameCache] - Thread name cache
 * @param {import("./history-store.js").HistoryStore} [historyStore] - Message history store
 * @param {import("./group-joins.js").GroupJoinLog} [joinLog] - Group join log
 * @param {import("./sync-log.js").SyncLog} [syncLog] - Live-connection coverage, reported as `sync` by the read tools
 */
export function registerTools(server, api, buffer, filter, config, nameCache, historyStore, joinLog, syncLog) {
    const maxPerPoll = config.limits?.maxMessagesPerPoll ?? 20;

    /**
     * The API instance to call now. After a reconnect the server logs in again and the listener moves
     * to a NEW instance (src/commands/mcp.js); the one passed in here belongs to the dropped session,
     * so a tool that kept calling it could report success for a message Zalo never delivered (Javis
     * report, 22/10/2026: replies in the bot's history that never reached the customer).
     */
    const live = () => (isLoggedIn() ? getApi() : api);

    /**
     * Coverage of a read (1.5.0): whether every message of the period could be here. Omitted when the
     * server runs without a sync log (tests, old wiring).
     * @param {number|null} from - window start (ms)
     * @param {number|null} to - window end (ms)
     */
    const syncOf = (from, to) => (syncLog ? syncLog.status(from, to) : undefined);
    const oldestTs = (messages) => (messages.length ? (messages[0].timestamp ?? null) : null);

    // --- zalo_get_messages ---
    server.registerTool(
        "zalo_get_messages",
        {
            title: "Get Zalo Messages",
            description:
                "Get messages from Zalo threads (DMs and groups). Returns buffered messages since last read. Use 'since' cursor from previous response for incremental polling. Messages sent from this account (by hand on a phone, or by you) carry isSelf: true; do not answer them as if a contact wrote them. Messages that arrived while the connection was down and came back with Zalo's replay carry recovered: true." +
                " Every result carries `sync`: if `sync.complete` is false, the connection was down during part of the period and a message from then may be missing here, so do not conclude the contact did not reply (or approved): keep any step that waits on a reply on hold and tell the owner.",
            inputSchema: z.object({
                threadId: z.string().optional().describe("Thread ID to read from. Omit for all watched threads."),
                since: z.number().int().min(0).default(0).describe("Cursor from previous read for incremental polling"),
                limit: z.number().int().min(1).max(100).default(maxPerPoll).describe("Max messages to return"),
            }),
        },
        async ({ threadId, since, limit }) => {
            try {
                const result = buffer.read(threadId, since, limit);
                result.sync = syncOf(null, null);
                // Enrich messages with thread name from cache
                if (nameCache) {
                    for (const msg of result.messages) {
                        const info = nameCache.get(msg.threadId);
                        if (info) msg.threadName = info.name;
                    }
                }
                return ok(result);
            } catch (e) {
                console.error("[mcp-tools] zalo_get_messages error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_send_message ---
    server.registerTool(
        "zalo_send_message",
        {
            title: "Send Zalo Message",
            description:
                "Send a text message to a Zalo thread (DM or group). threadType: 0=DM(User), 1=Group. " +
                "Optional `styles` format parts of the text: each is { start, len, st } with positions in UTF-16 units " +
                "(as JavaScript counts) and st one of b (bold), i (italic), u (underline), s (strikethrough), " +
                "c_db342e (red), c_f27806 (orange), c_f7b503 (yellow), c_15a85f (green), f_13 (small), f_18 (big), " +
                "lst_1 (bullet list), lst_2 (numbered list).",
            inputSchema: z.object({
                threadId: z.string().describe("Thread ID to send message to"),
                text: z.string().min(1).describe("Message text to send"),
                threadType: z
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .default(THREAD_USER)
                    .describe("Thread type: 0=DM(User), 1=Group"),
                styles: z
                    .array(
                        z.object({
                            start: z.number().int().min(0),
                            len: z.number().int().min(1),
                            st: z.enum(STYLE_CODES),
                        }),
                    )
                    .max(MAX_STYLES)
                    .optional()
                    .describe("Text styles: [{ start, len, st }], positions in UTF-16 units"),
            }),
        },
        async ({ threadId, text, threadType, styles }) => {
            try {
                // A style past the end of the text is dropped rather than sent: Zalo rejects the whole message.
                const kept = (styles || []).filter((x) => x.start + x.len <= text.length);
                const content = kept.length ? { msg: text, styles: kept } : text;
                const result = await live().sendMessage(content, threadId, Number(threadType));
                const messageId = result?.message?.msgId ?? result?.msgId ?? null;
                return ok({ success: true, messageId });
            } catch (e) {
                console.error("[mcp-tools] zalo_send_message error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_send_typing ---
    server.registerTool(
        "zalo_send_typing",
        {
            title: "Show Typing in a Zalo Chat",
            description:
                "Show the 'typing...' indicator to the other side of a Zalo thread, as a person writing a reply does. " +
                "It fades after a few seconds on its own; call again every few seconds while still writing. " +
                "threadType: 0=DM(User), 1=Group.",
            inputSchema: z.object({
                threadId: z.string().describe("Thread ID to show the indicator in"),
                threadType: z
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .default(THREAD_USER)
                    .describe("Thread type: 0=DM(User), 1=Group"),
            }),
        },
        async ({ threadId, threadType }) => {
            try {
                await live().sendTypingEvent(threadId, Number(threadType));
                return ok({ success: true });
            } catch (e) {
                console.error("[mcp-tools] zalo_send_typing error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_send_file ---
    server.registerTool(
        "zalo_send_file",
        {
            title: "Send Zalo File",
            description:
                "Send files (xlsx, pdf, docx, zip, mp4, images...) to a Zalo thread, with an optional caption. " +
                `Only files inside ${OUTBOX_DIR} can be sent: copy a file there first. ` +
                "Fails within about a minute with a clear error if Zalo does not confirm the upload; nothing is sent then. " +
                "threadType: 0=DM(User), 1=Group.",
            inputSchema: z.object({
                threadId: z.string().describe("Thread ID to send to"),
                paths: z
                    .array(z.string())
                    .min(1)
                    .max(MAX_FILES_PER_SEND)
                    .describe("Absolute paths of files inside the outbox folder"),
                caption: z.string().default("").describe("Text sent with the files"),
                threadType: z
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .default(THREAD_USER)
                    .describe("Thread type: 0=DM(User), 1=Group"),
            }),
        },
        async (args) => {
            try {
                // After a re-login the listener lives on a new API instance; its context gets the
                // upload confirmations, so send from that one rather than the one captured here.
                return ok(await sendFileFromOutbox(live(), args));
            } catch (e) {
                console.error("[mcp-tools] zalo_send_file error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_add_reaction ---
    server.registerTool(
        "zalo_add_reaction",
        {
            title: "React to a Zalo Message",
            description:
                'Put an emoji reaction on a message in a Zalo thread, or take this account\'s reaction off (reaction: "none"). ' +
                'The contact sees it. Contacts\' own reactions arrive in zalo_get_messages as entries with type "reaction" ' +
                "(reaction.targetMsgId names the message they reacted to; reaction.removed means they took it back). " +
                "threadType: 0=DM(User), 1=Group.",
            inputSchema: z.object({
                threadId: z.string().describe("Thread ID the message is in"),
                msgId: z
                    .string()
                    .describe("Id of the message to react to (`id` in zalo_get_messages, `msgId` in history)"),
                reaction: z
                    .string()
                    .describe(
                        `One of: ${Object.keys(REACTIONS).join(", ")}; or the emoji itself (❤️ 👍 😆 ...); or "none" to remove`,
                    ),
                cliMsgId: z
                    .string()
                    .optional()
                    .describe("The message's cliMsgId. Optional: looked up from the buffer or history when omitted"),
                threadType: z
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .default(THREAD_USER)
                    .describe("Thread type: 0=DM(User), 1=Group"),
            }),
        },
        async (args) => {
            try {
                return ok(await reactToMessage(live(), args, { buffer, historyStore }));
            } catch (e) {
                console.error("[mcp-tools] zalo_add_reaction error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_list_threads ---
    server.registerTool(
        "zalo_list_threads",
        {
            title: "List Zalo Threads",
            description:
                "List all Zalo threads currently buffered with unread message counts. Useful for discovering active conversations.",
            inputSchema: z.object({
                type: z
                    .enum(["group", "dm", "all"])
                    .default("all")
                    .describe("Filter by thread type: 'dm', 'group', or 'all'"),
            }),
        },
        async ({ type }) => {
            try {
                const stats = buffer.getStats(0);
                // Enrich each stat entry with threadType and thread name
                const enriched = stats.map((t) => {
                    const threadType = buffer.getThreadType(t.threadId) ?? "unknown";
                    const cached = nameCache?.get(t.threadId);
                    return {
                        ...t,
                        threadType,
                        name: cached?.name ?? null,
                        ...(cached?.memberCount !== undefined && { memberCount: cached.memberCount }),
                    };
                });
                const filtered = type === "all" ? enriched : enriched.filter((t) => t.threadType === type);
                return ok({ threads: filtered, total: filtered.length });
            } catch (e) {
                console.error("[mcp-tools] zalo_list_threads error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_search_threads ---
    server.registerTool(
        "zalo_search_threads",
        {
            title: "Search Zalo Threads",
            description:
                "Search threads (groups/DMs) by name. Uses fuzzy Vietnamese-aware matching. Useful for finding a thread ID by name.",
            inputSchema: z.object({
                query: z.string().min(1).describe("Search keyword (fuzzy match, case-insensitive, accent-insensitive)"),
                type: z
                    .enum(["group", "dm", "all"])
                    .default("all")
                    .describe("Filter by thread type: 'dm', 'group', or 'all'"),
                limit: z.number().int().min(1).max(50).default(10).describe("Max results to return"),
            }),
        },
        async ({ query, type, limit }) => {
            try {
                if (!nameCache?.ready) {
                    return err("Thread name cache not initialized yet. Try again shortly.");
                }
                const results = nameCache.search(query, type, limit);
                return ok({ results, total: results.length });
            } catch (e) {
                console.error("[mcp-tools] zalo_search_threads error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_mark_read ---
    server.registerTool(
        "zalo_mark_read",
        {
            title: "Mark Zalo Messages Read",
            description:
                "Discard buffered messages up to and including the given cursor. Use the cursor returned by zalo_get_messages.",
            inputSchema: z.object({
                cursor: z
                    .number()
                    .int()
                    .min(0)
                    .describe("Cursor value returned from a previous zalo_get_messages call"),
            }),
        },
        async ({ cursor }) => {
            try {
                const discarded = buffer.markRead(cursor);
                return ok({ success: true, discarded });
            } catch (e) {
                console.error("[mcp-tools] zalo_mark_read error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_get_history ---
    server.registerTool(
        "zalo_get_history",
        {
            title: "Get Zalo Message History",
            description:
                "Fetch message history for a Zalo DM or group conversation. Served from history this MCP " +
                "server has captured: seeded from the Zalo server's backfill each time the server (re)connects " +
                "(recent window, ~2 weeks) and growing as new messages arrive. Returns messages oldest→newest, " +
                "each with 'replyTo' (who/what it replies to) and 'mentions' when present. " +
                "Optional filters: 'senderId' (one person), 'since'/'until' (date range). " +
                "To page further back in time, pass the previous response's 'cursor' value as 'lastMsgId'. " +
                "Note: deep/old archives beyond Zalo's replay window are not retrievable via any API." +
                " Every result carries `sync`: if `sync.complete` is false, the connection was down during part of the period and a message from then may be missing here, so do not conclude the contact did not reply (or approved): keep any step that waits on a reply on hold and tell the owner.",
            inputSchema: z.object({
                threadId: z.string().describe("Thread ID to fetch history from"),
                threadType: z
                    .number()
                    .int()
                    .min(0)
                    .max(1)
                    .default(THREAD_USER)
                    .describe("Thread type: 0=DM(User), 1=Group (used for the response label)"),
                senderId: z.string().optional().nullable().describe("Only messages sent by this user id"),
                since: z
                    .union([z.string(), z.number()])
                    .optional()
                    .nullable()
                    .describe("Only messages at/after this time — 'YYYY-MM-DD', ISO datetime, or epoch ms"),
                until: z
                    .union([z.string(), z.number()])
                    .optional()
                    .nullable()
                    .describe(
                        "Only messages at/before this time — 'YYYY-MM-DD' (inclusive), ISO datetime, or epoch ms",
                    ),
                limit: z.number().int().min(1).max(200).default(50).describe("Max messages to fetch"),
                lastMsgId: z
                    .string()
                    .optional()
                    .nullable()
                    .describe("Cursor: pass the previous response's 'cursor' to page further back in time"),
            }),
        },
        async ({ threadId, threadType, senderId, since, until, limit, lastMsgId }) => {
            try {
                if (!historyStore) {
                    return err("History store unavailable — restart the MCP server.");
                }

                const { messages, cursor, hasMore } = historyStore.query({
                    threadId,
                    senderId: senderId || null,
                    since: parseTimeBoundary(since),
                    until: parseTimeBoundary(until, true),
                    limit,
                    before: lastMsgId || null,
                });

                enrichThreadNames(messages, nameCache);

                const sinceMs = parseTimeBoundary(since);
                return ok({
                    threadId,
                    threadType: threadType === 0 ? "dm" : "group",
                    count: messages.length,
                    messages,
                    cursor,
                    hasMore,
                    // Window = the asked range. Without `since`: a partial page covers from its oldest message;
                    // the whole thread covers since recording began (so an outage before the one message
                    // we have, when the contact's reply may have come, is still reported).
                    sync: syncOf(
                        sinceMs ?? (lastMsgId || hasMore ? oldestTs(messages) : null),
                        parseTimeBoundary(until, true),
                    ),
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_get_history error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_search_history ---
    server.registerTool(
        "zalo_search_history",
        {
            title: "Search Zalo Message History",
            description:
                "Search captured message history ACROSS all threads (or one), filtered by sender and/or date " +
                "range. Use this for 'all messages from person X' (their DM + their messages in every group) or " +
                "'everything between two dates'. Returns messages oldest→newest with 'replyTo' and 'mentions'. " +
                "Provide at least one of senderId / since / until (or a threadId) to narrow the search. " +
                "Same coverage limit as zalo_get_history (~2-week replay window + live since server start)." +
                " Every result carries `sync`: if `sync.complete` is false, the connection was down during part of the period and a message from then may be missing here, so do not conclude the contact did not reply (or approved): keep any step that waits on a reply on hold and tell the owner.",
            inputSchema: z.object({
                senderId: z.string().optional().nullable().describe("Only messages sent by this user id"),
                threadId: z
                    .string()
                    .optional()
                    .nullable()
                    .describe("Restrict to one thread; omit to search across all threads"),
                since: z
                    .union([z.string(), z.number()])
                    .optional()
                    .nullable()
                    .describe("Only messages at/after this time — 'YYYY-MM-DD', ISO datetime, or epoch ms"),
                until: z
                    .union([z.string(), z.number()])
                    .optional()
                    .nullable()
                    .describe(
                        "Only messages at/before this time — 'YYYY-MM-DD' (inclusive), ISO datetime, or epoch ms",
                    ),
                limit: z.number().int().min(1).max(200).default(50).describe("Max messages to return"),
                before: z
                    .string()
                    .optional()
                    .nullable()
                    .describe("Cursor: pass the previous response's 'cursor' to page further back in time"),
            }),
        },
        async ({ senderId, threadId, since, until, limit, before }) => {
            try {
                if (!historyStore) {
                    return err("History store unavailable — restart the MCP server.");
                }
                // Parse boundaries first so presence is judged on the parsed value (a valid
                // epoch-0 boundary must not be rejected as "no filter").
                const sinceMs = parseTimeBoundary(since);
                const untilMs = parseTimeBoundary(until, true);
                if (!senderId && !threadId && sinceMs === null && untilMs === null) {
                    return err("Provide at least one filter: senderId, threadId, since, or until.");
                }

                const { messages, cursor, hasMore } = historyStore.query({
                    threadId: threadId || null,
                    senderId: senderId || null,
                    since: sinceMs,
                    until: untilMs,
                    limit,
                    before: before || null,
                });

                enrichThreadNames(messages, nameCache);

                return ok({ count: messages.length, messages, cursor, hasMore, sync: syncOf(sinceMs, untilMs) });
            } catch (e) {
                console.error("[mcp-tools] zalo_search_history error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_get_group_joins ---
    server.registerTool(
        "zalo_get_group_joins",
        {
            title: "Get Zalo Group Joins",
            description:
                "Who joined a Zalo group and WHEN (exact join time), newest last. Recorded from Zalo's live " +
                "join events while this MCP server is connected (by link, by approval, or added by someone), " +
                "and kept on disk across restarts. Zalo's member list has no join date, so members who " +
                "joined before recording started, or while the server was offline, are not listed. " +
                "In the live feed (zalo_get_messages) each join also appears as a message of type " +
                "'group.join' sent by the newcomer.",
            inputSchema: z.object({
                threadId: z.string().optional().nullable().describe("Group ID; omit for all groups"),
                userId: z.string().optional().nullable().describe("Only this member"),
                since: z
                    .union([z.string(), z.number()])
                    .optional()
                    .nullable()
                    .describe("Only joins at/after this time - 'YYYY-MM-DD', ISO datetime, or epoch ms"),
                until: z
                    .union([z.string(), z.number()])
                    .optional()
                    .nullable()
                    .describe("Only joins at/before this time - 'YYYY-MM-DD' (inclusive), ISO datetime, or epoch ms"),
                limit: z.number().int().min(1).max(500).default(50).describe("Max joins to return (most recent)"),
            }),
        },
        async ({ threadId, userId, since, until, limit }) => {
            try {
                if (!joinLog) return err("Join log unavailable - restart the MCP server.");
                const { joins, total } = joinLog.query({
                    threadId: threadId || null,
                    userId: userId || null,
                    since: parseTimeBoundary(since),
                    until: parseTimeBoundary(until, true),
                    limit,
                });
                const rows = joins.map((r) => ({
                    threadId: r.groupId,
                    groupName: r.groupName || nameCache?.get(r.groupId)?.name || null,
                    userId: r.userId,
                    userName: r.userName,
                    addedBy: r.addedBy,
                    addedByMe: r.addedByMe,
                    time: r.time,
                    timeISO: new Date(r.time).toISOString(),
                }));
                return ok({ count: rows.length, total, joins: rows });
            } catch (e) {
                console.error("[mcp-tools] zalo_get_group_joins error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_list_join_requests ---
    server.registerTool(
        "zalo_list_join_requests",
        {
            title: "List Zalo Group Join Requests",
            description:
                "People waiting for approval to join a Zalo group (only for groups that require approval). " +
                "Returns each applicant's userId and display name. " +
                ADMIN_HINT +
                " New requests also appear in zalo_get_messages as 'group.join_request' messages.",
            inputSchema: z.object({
                threadId: z.string().describe("Group ID"),
            }),
        },
        async ({ threadId }) => {
            try {
                const { time, requests } = pendingFromApi(await live().getPendingGroupMembers(threadId));
                return ok({
                    threadId,
                    groupName: nameCache?.get(threadId)?.name || null,
                    count: requests.length,
                    requests,
                    time,
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_list_join_requests error:", e.message);
                return err(`${e.message}. ${ADMIN_HINT}`);
            }
        },
    );

    // --- zalo_review_join_requests ---
    server.registerTool(
        "zalo_review_join_requests",
        {
            title: "Approve or Reject Zalo Group Join Requests",
            description:
                "Approve or reject people waiting to join a Zalo group. Use the userIds from " +
                "zalo_list_join_requests. Returns one outcome per person: done, not_pending (no longer " +
                "waiting), already_member, no_permission, or error_<code>. " +
                ADMIN_HINT,
            inputSchema: z.object({
                threadId: z.string().describe("Group ID"),
                userIds: z.array(z.string()).min(1).max(100).describe("Applicants to review"),
                action: z.enum(["approve", "reject"]).describe("approve lets them in, reject turns them away"),
            }),
        },
        async ({ threadId, userIds, action }) => {
            try {
                const ids = [...new Set(userIds.map((u) => String(u).trim()).filter(Boolean))];
                if (!ids.length) return err("No userIds given.");
                const res = await live().reviewPendingMemberRequest(
                    { members: ids, isApprove: action === "approve" },
                    threadId,
                );
                const results = reviewOutcomes(res, ids);
                return ok({
                    threadId,
                    action,
                    done: results.filter((r) => r.outcome === "done").length,
                    results,
                });
            } catch (e) {
                console.error("[mcp-tools] zalo_review_join_requests error:", e.message);
                return err(`${e.message}. ${ADMIN_HINT}`);
            }
        },
    );

    // --- zalo_get_labels ---
    const readLabels = createLabelReader({ getLabels: () => live().getLabels() });
    server.registerTool(
        "zalo_get_labels",
        {
            title: "Get Zalo Chat Labels",
            description:
                "The labels (tags) the owner put on chats in the Zalo app, e.g. Family, Friends, Customer. " +
                "With threadId: only the labels that chat carries (empty when none). Without: every label with " +
                "the chats it holds (threadId plus threadType, 0=DM(User), 1=Group). The list is cached for a " +
                "minute; pass refresh: true right after the owner changed labels.",
            inputSchema: z.object({
                threadId: z.string().optional().describe("Thread ID to get the labels of. Omit for every label."),
                refresh: z.boolean().default(false).describe("Ask Zalo again instead of the one-minute cache"),
            }),
        },
        async ({ threadId, refresh }) => {
            try {
                const { labels, version, cached } = await readLabels({ refresh });
                if (threadId) {
                    return ok({ threadId, labels: labelsOfThread(labels, threadId), version, cached });
                }
                return ok({ count: labels.length, labels, version, cached });
            } catch (e) {
                console.error("[mcp-tools] zalo_get_labels error:", e.message);
                return err(e.message);
            }
        },
    );

    // --- zalo_view_media ---
    const mediaConfig = config.media || {};
    server.registerTool(
        "zalo_view_media",
        {
            title: "View Zalo Media",
            description:
                "Open a Zalo media file (image, audio, video) with the system viewer. " +
                "Media is auto-downloaded when received, organized by thread folder with date/sender metadata filenames. " +
                "If not yet downloaded, downloads first then opens.",
            inputSchema: z.object({
                messageId: z.string().describe("Message ID from zalo_get_messages that has a media attachment"),
                threadId: z.string().optional().describe("Thread ID to search in. Omit to search all threads."),
                open: z
                    .boolean()
                    .default(mediaConfig.autoOpen ?? true)
                    .describe("Open media with system viewer"),
            }),
        },
        async ({ messageId, threadId, open }) => {
            try {
                const allMessages = buffer.read(threadId, 0, 9999).messages;
                const message = allMessages.find((m) => m.id === messageId);
                if (!message) return err(`Message ${messageId} not found in buffer`);
                if (!message.attachment?.url) return err(`Message ${messageId} has no media attachment`);

                // Use local file if already auto-downloaded, otherwise download now
                let localPath = message.attachment.localPath;
                if (!localPath) {
                    const threadName = nameCache?.get(message.threadId)?.name || null;
                    const result = await downloadMedia(message, {
                        downloadDir: mediaConfig.downloadDir || undefined,
                        autoOpen: false,
                        threadName,
                    });
                    localPath = result.path;
                }

                if (open) openFile(localPath);

                return ok({ success: true, path: localPath, mediaType: message.type });
            } catch (e) {
                console.error("[mcp-tools] zalo_view_media error:", e.message);
                return err(e.message);
            }
        },
    );
}
