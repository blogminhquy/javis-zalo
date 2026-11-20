/**
 * Send a message with a link card (1.13.0, Javis owner request 19/11/2026: a link Javis sent showed as bare text,
 * while the same link typed in the Zalo app shows the page's title and thumbnail).
 *
 * The card is not drawn by the receiving app: the SENDER asks Zalo to read the page (`parseLink`) and sends a link
 * message carrying what came back (`sendLink`). A plain `sendMessage` with a URL in it therefore stays bare text.
 */

/**
 * The text that goes out: the caller's text, or the link alone, with the link appended when the text lacks it
 * (zca-js `sendLink` does the same, so the plain fallback reads exactly like the card would).
 * @param {string} url
 * @param {string} [text]
 * @returns {string}
 */
export function linkMessageText(url, text) {
    const t = String(text || "").trim();
    if (!t) return url;
    return t.includes(url) ? t : `${t} ${url}`;
}

/** The client message id of a send result, as a string, or null when Zalo did not return one. */
function cliMsgIdOf(result) {
    const id = result?.message?.cliMsgId ?? result?.cliMsgId ?? null;
    return id === null ? null : String(id);
}

/**
 * Send `text` with a card for `url`. When Zalo cannot read the page (parseLink fails: private page, timeout, a
 * site that blocks Zalo's reader), nothing has been sent yet, so the text goes out as a plain message and the
 * result says `preview: false`. A failure of the send itself is thrown: it is not retried as plain text, since
 * the card may have been delivered and the contact would get the message twice.
 * @param {object} api - zca-js API instance (parseLink, sendLink, sendMessage)
 * @param {{ threadId: string, url: string, text?: string, threadType?: number }} args
 * @returns {Promise<{ success: true, messageId: string|null, cliMsgId: string|null, preview: boolean, reason?: string }>}
 */
export async function sendLinkCard(api, { threadId, url, text, threadType = 0 }) {
    const msg = linkMessageText(url, text);
    const type = Number(threadType);
    try {
        await api.parseLink(url);
    } catch (e) {
        const result = await api.sendMessage(msg, threadId, type);
        const messageId = result?.message?.msgId ?? result?.msgId ?? null;
        return {
            success: true,
            messageId,
            cliMsgId: cliMsgIdOf(result),
            preview: false,
            reason: String(e?.message || e).slice(0, 200),
        };
    }
    const result = await api.sendLink({ link: url, msg }, threadId, type);
    const messageId = result?.msgId ?? result?.message?.msgId ?? null;
    return {
        success: true,
        messageId: messageId === null ? null : String(messageId),
        cliMsgId: cliMsgIdOf(result),
        preview: true,
    };
}
