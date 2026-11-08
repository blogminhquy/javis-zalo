/**
 * Which replayed messages go into the live feed after a connect, and a guard for listener handlers.
 *
 * Field report (Javis, 08/11/2026): a private chat stopped in the Javis inbox at 09:28 while the phone went on
 * until 09:53, messages both ways, yet `zalo_get_history` had every one of them. The inbox only reads the live
 * buffer (`zalo_get_messages`), so those messages reached the history and never the buffer. Two paths do exactly
 * that, and this module closes both:
 *
 * 1. A SHORT drop. Zalo replays recent messages after every connect (cmd 510/511), and the replay always fills the
 *    history. Before 1.9.1 it reached the live feed only when the sync log had recorded a gap, and the sync log skips
 *    drops shorter than MIN_GAP_MS (5 s) as "not worth a gap entry". zca-js reconnects a dropped socket on its own
 *    within seconds, so most drops were that short: whatever Zalo pushed while the socket was dead (or half dead
 *    before the close was noticed) came back only to the history. `replayFeedFrom` now feeds every reconnect,
 *    from a little before the drop.
 *
 * 2. A THROWING handler. zca-js emits the messages of one frame in a loop inside a try/catch, so an exception thrown
 *    by our "message" handler ends the loop: every later message of that frame is dropped, and zca-js turns the
 *    exception into an "error" event, which the MCP server used to ignore. `guardHandler` keeps one bad message from
 *    taking the rest of its frame with it, and logs it.
 */

/**
 * How far before a drop the replay is fed back. A socket can stop delivering a while before its close is noticed
 * (a half-open connection is only caught by the next ping), so the messages just before the close event are as
 * uncertain as the ones after it. The live buffer de-duplicates by message id, so a wider window costs nothing.
 */
export const REPLAY_SLACK_MS = 5 * 60 * 1000;

/**
 * Start (ms) of the replayed messages to put into the live feed after a connect, or null for none.
 *
 * @param {object} p
 * @param {number|null} [p.gapFrom] - start of the gap the sync log recorded for this connect (outage >= MIN_GAP_MS,
 *   including the time the process itself was down), or null
 * @param {number|null} [p.lastDropAt] - when this process last saw the socket drop, or null when it never did
 *   (the first connect of the process)
 * @param {number} [p.slackMs]
 * @returns {number|null}
 */
export function replayFeedFrom({ gapFrom = null, lastDropAt = null, slackMs = REPLAY_SLACK_MS } = {}) {
    const starts = [];
    if (Number.isFinite(gapFrom)) starts.push(gapFrom);
    // A reconnect within this process, however short the drop was.
    if (Number.isFinite(lastDropAt)) starts.push(lastDropAt - slackMs);
    return starts.length ? Math.min(...starts) : null;
}

/**
 * Wrap a listener handler so an exception stays with the event that caused it.
 * @param {string} label - what the handler handles, for the log line
 * @param {Function} fn - the handler
 * @param {(line: string) => void} [log]
 * @returns {Function}
 */
export function guardHandler(label, fn, log = (line) => console.error(line)) {
    return (...args) => {
        try {
            return fn(...args);
        } catch (e) {
            const first = args[0];
            const id = first?.data?.msgId ?? first?.msgId ?? "";
            log(`[mcp] ${label} handling failed${id ? ` (msgId ${id})` : ""}: ${e?.message || e}`);
            return undefined;
        }
    };
}

/**
 * A rate-limited logger for the listener's "error" events: the first one at once, then at most one line per
 * `intervalMs` with how many were folded into it. They used to be swallowed whole, which hid the frames zca-js
 * failed to decode.
 * @param {number} [intervalMs]
 * @param {(line: string) => void} [log]
 * @param {() => number} [now]
 * @returns {(err: unknown) => void}
 */
export function listenerErrorLogger(
    intervalMs = 60 * 1000,
    log = (line) => console.error(line),
    now = () => Date.now(),
) {
    let lastAt = -Infinity;
    let folded = 0;
    return (err) => {
        const t = now();
        if (t - lastAt < intervalMs) {
            folded++;
            return;
        }
        const more = folded ? ` (+${folded} more since the last line)` : "";
        folded = 0;
        lastAt = t;
        const msg = err?.message || (typeof err === "string" ? err : err?.type || "unknown");
        log(`[mcp] Listener error: ${msg}${more}`);
    };
}
