/**
 * Live push (1.10.0): tell the local consumer (Javis) the moment something lands in the live buffer, so it reads
 * `zalo_get_messages` right then instead of on a timer.
 *
 * Why: Zalo delivers a message to this process in real time, but the consumer could only learn about it by asking.
 * Javis asked every 20 seconds, all day, on accounts where no message arrived for hours, and a group message still
 * waited up to 20 seconds (owner request, 10/11/2026: "when a message arrives, send it over; do not scan on a timer").
 *
 * What goes over the wire is a wake-up, never content: which kinds of event happened, the buffer cursor, whether the
 * Zalo connection is up. The consumer then reads the messages through the MCP tool as before, so the tool stays the
 * single place that hands out messages.
 *
 * Rules:
 *  - Off unless JAVIS_ZALO_PUSH_URL is set (by the consumer that spawns this process).
 *  - Loopback only (127.0.0.1, localhost, ::1): this is a signal to a program on the same machine, and nothing about
 *    the account may leave it through this path.
 *  - Events are coalesced: a burst of 50 messages is one request. While a request is in flight, later events wait
 *    and go out as one more.
 *  - A failed request is retried with a growing pause for as long as something is pending (the consumer is
 *    restarting); it never throws into a Zalo handler and never blocks one.
 */

/** Pause before sending, so a burst becomes one request (ms). */
export const PUSH_DEBOUNCE_MS = 150;
/** Pauses between retries of a failed request (ms); the last one repeats. */
export const PUSH_RETRY_MS = [1000, 2000, 5000, 15000, 30000];
/** A request that takes longer than this is treated as failed (ms). */
export const PUSH_TIMEOUT_MS = 5000;
/** Event kinds a consumer can receive. */
export const PUSH_EVENTS = ["ready", "messages", "connected", "disconnected"];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The push target from the environment, or null when live push is off or the URL is not allowed.
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{ url: string, token: string }|null}
 */
export function pushTargetFromEnv(env = process.env) {
    const raw = String(env.JAVIS_ZALO_PUSH_URL || "").trim();
    if (!raw) return null;
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        console.error("[live-push] JAVIS_ZALO_PUSH_URL is not a URL; live push stays off");
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        console.error("[live-push] JAVIS_ZALO_PUSH_URL must be http(s); live push stays off");
        return null;
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
        console.error("[live-push] JAVIS_ZALO_PUSH_URL must point at this machine (127.0.0.1); live push stays off");
        return null;
    }
    if (parsed.username || parsed.password) {
        console.error("[live-push] JAVIS_ZALO_PUSH_URL must not carry credentials; live push stays off");
        return null;
    }
    return { url: parsed.toString(), token: String(env.JAVIS_ZALO_PUSH_TOKEN || "").trim() };
}

/**
 * @param {object} opts
 * @param {{ url: string, token: string }|null} opts.target - From pushTargetFromEnv; null makes every call a no-op
 * @param {() => object} [opts.state] - Extra fields for each request (cursor, connected), read at send time
 * @param {string} [opts.version] - javis-zalo version, sent so the consumer knows what it talks to
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.debounceMs]
 * @param {number[]} [opts.retryMs]
 * @param {(fn: Function, ms: number) => any} [opts.setTimer] - Injectable for tests
 * @returns {{ enabled: boolean, notify: (event: string) => void, pending: () => string[], stop: () => void }}
 */
export function createLivePush({
    target,
    state = () => ({}),
    version = "",
    fetchImpl = globalThis.fetch,
    debounceMs = PUSH_DEBOUNCE_MS,
    retryMs = PUSH_RETRY_MS,
    setTimer = (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
    },
}) {
    if (!target || typeof fetchImpl !== "function") {
        return { enabled: false, notify() {}, pending: () => [], stop() {} };
    }

    const queued = new Set(); // event kinds waiting to go out
    let timer = null; // a send is scheduled
    let sending = false;
    let failures = 0;
    let stopped = false;
    let lastErrorLogAt = 0;

    function schedule(ms) {
        if (stopped || timer || sending || queued.size === 0) return;
        timer = setTimer(() => {
            timer = null;
            void send();
        }, ms);
    }

    async function send() {
        if (stopped || sending || queued.size === 0) return;
        sending = true;
        const events = PUSH_EVENTS.filter((e) => queued.has(e));
        queued.clear();
        let ok = false;
        let reason = "";
        try {
            let extra = {};
            try {
                extra = state() || {};
            } catch {
                extra = {};
            }
            const headers = { "Content-Type": "application/json" };
            if (target.token) headers.Authorization = `Bearer ${target.token}`;
            const res = await fetchImpl(target.url, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    source: "javis-zalo",
                    version,
                    pid: process.pid,
                    events,
                    ts: Date.now(),
                    ...extra,
                }),
                signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
            });
            ok = !!res && res.ok;
            if (!ok) reason = `HTTP ${res?.status}`;
        } catch (e) {
            reason = e?.name === "TimeoutError" ? "timeout" : String(e?.message || e);
        }
        sending = false;
        if (ok) {
            failures = 0;
            schedule(debounceMs); // events that arrived while this request was in flight
            return;
        }
        // Not delivered: the same events stay owed, merged with whatever arrived meanwhile.
        for (const e of events) queued.add(e);
        const wait = retryMs[Math.min(failures, retryMs.length - 1)];
        failures++;
        const now = Date.now();
        if (now - lastErrorLogAt > 60000) {
            lastErrorLogAt = now;
            console.error(`[live-push] not delivered (${reason}); retrying in ${Math.round(wait / 1000)}s`);
        }
        schedule(wait);
    }

    return {
        enabled: true,
        /** Queue one event kind. Unknown kinds are ignored. Never throws. */
        notify(event) {
            if (stopped || !PUSH_EVENTS.includes(event)) return;
            queued.add(event);
            // During a retry pause the timer is already set: the new event rides that attempt.
            schedule(debounceMs);
        },
        pending: () => PUSH_EVENTS.filter((e) => queued.has(e)),
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
            queued.clear();
        },
    };
}
