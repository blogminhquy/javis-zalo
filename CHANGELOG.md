# Changelog

All notable changes to javis-zalo. Newest first.

## [1.8.0] - 2026-10-27

### Added
- `group note-list <groupId>`: list a group's board (notes, pinned messages and polls) with each
  item's id, text, who created and last edited it, and when. `--type note|pin|poll|all`, `--json`.
  It walks every page and stops on its own if Zalo hands the same page back. Zalo's board list does
  not say whether a note is pinned, so a note's `pinned` is `null`; a pinned message is pinned.
- `group note-edit --unpin` takes a note off the pin bar, and `--keep-pin` states the default
  (leave the pin alone). A caller that must never unpin by accident can always pass one of the
  three: older versions reject `--keep-pin` instead of unpinning.

### Fixed
- `group note-edit` no longer unpins the note it edits. It went through zca-js `editNote`, which
  sends pin action 2 (unpin) whenever `--pin` is not given, so fixing a typo in a pinned note took
  it off the pin bar (Javis report, 27/10/2026). It now sends no pin action unless `--pin` or
  `--unpin` is given, so the note stays as it was.

## [1.7.0] - 2026-10-26

### Added
- Emoji reactions, both ways. A reaction a contact puts on a message now reaches `zalo_get_messages`
  as an entry with `type: "reaction"` pointing at the message it was put on (`reaction.targetMsgId`),
  with its name, emoji and whether it was taken back (`reaction.removed`). Before, the server did not
  listen to Zalo's reaction event at all, so a consumer never knew a customer had hearted a quote.
  Reactions do not trigger the owner notification.
- `zalo_add_reaction`: put a reaction on a message (heart, like, haha, wow, cry, angry and the rest of
  Zalo's picker, by name or by the emoji itself), or take this account's reaction off with `none`.
- `cliMsgId` on every message in `zalo_get_messages` and the history tools. Zalo needs it next to
  `msgId` to react; `zalo_add_reaction` looks it up from the buffer or history when it is not passed.

## [1.6.1] - 2026-10-22

### Fixed
- Sending after a reconnect goes through the live session. When the connection drops, the MCP
  server logs in again and moves the listener to a new API instance, but `zalo_send_message`,
  `zalo_list_join_requests`, `zalo_review_join_requests` and `zalo_get_labels` kept calling the
  instance captured at startup, which belongs to the dropped session (Javis report, 22/10/2026:
  bot replies in the history that never reached the customer, on an account that kept
  reconnecting). They now call the current instance, as `zalo_send_file` already did.

## [1.6.0] - 2026-10-22

### Added
- `zalo_get_labels`: the labels (tags) the owner put on chats in the Zalo app, such as Family,
  Friends or Customer. With `threadId` it returns only that chat's labels; without, every label with
  the chats it holds (`threadId`, `threadType`). Zalo stores a group as "g" + group id, which the tool
  turns back into the plain group id the other tools use. The list is cached for a minute (`refresh:
  true` asks again), so Javis can check a chat's labels on every incoming message without calling
  Zalo each time. Javis uses it so a bot can stay out of chats tagged as family or friends.

## [1.5.0] - 2026-10-16

### Fixed
- History survives a restart. `zalo_get_history` and `zalo_search_history` were served from memory
  only, so every restart of the MCP server (a Javis update, a crash) wiped them and only Zalo's short
  replay came back: a reply that arrived before the restart and fell outside the replay was gone from
  every read tool (Javis report, 16/10/2026: a customer's "OK" none of the three tools could find).
  History is now kept in `~/.zalo-agent-cli/history.jsonl`, 30 days (`historyKeepDays`).
- Messages that arrived while the connection was down reach the live feed. The replay after a
  reconnect or a restart only filled history before, so a poller of `zalo_get_messages` (Javis'
  inbox) never saw them. They are now added to the feed flagged `recovered: true`, unless already
  there.

### Added
- `sync` in every result of `zalo_get_messages`, `zalo_get_history` and `zalo_search_history`:
  whether the connection was up for the whole period read (`complete`), and the outages Zalo's replay
  did not cover (`gaps`, epoch ms). Outages are recorded across restarts (heartbeat in
  `~/.zalo-agent-cli/sync-state.json`). `complete: false` means a message may be missing here, not
  that there was none.

## [1.4.0] - 2026-10-14

### Fixed
- Sending a file that is not an image (xlsx, pdf, docx, zip, mp4...) no longer hangs. Zalo confirms
  such an upload only over the live WebSocket (`file_done`), and zca-js waits for it with no
  deadline, so `msg send-file`, which never opens a listener, waited forever (Javis killed it after
  120 s, file not delivered). Images were unaffected: their URL comes back in the HTTP reply.
- `msg send-file` / `msg send-image` now fail at once with a clear message when a file needs the
  live connection and none is open, and give up after `--timeout` seconds (default 60) when Zalo
  does not confirm. A confirmation arriving after that is ignored, so a send reported as failed is
  never delivered later.

### Added
- MCP tool `zalo_send_file`: sends files with a caption from the MCP server, which holds the live
  connection. Only files inside `~/.zalo-agent-cli/outbox/` are accepted.
- `msg send-file --listen` opens a live connection for one send, for machines with no MCP server
  running (it disconnects any other Zalo Web session of the account).

## [1.3.0] - 2026-10-13

### Changed
- The live feed (`zalo_get_messages`) now keeps messages sent from this account, flagged
  `isSelf: true`, instead of dropping them. A reply the owner or a staff member types on the
  phone used to be invisible to the agent (only `zalo_get_history` had it), so Javis' inbox
  missed every hand-typed reply. Every message now carries `isSelf` (false for contacts), in
  history too. Agents must not answer `isSelf` messages and should drop echoes of their own
  sends; `mcp start --no-self` restores the old behaviour.
- Own messages trigger no new-message notification and no media auto-download.

## [1.2.0] - 2026-10-06

### Added
- Join requests for groups that require approval. Read tool `zalo_list_join_requests` lists who
  is waiting; `zalo_review_join_requests` approves or rejects them and reports one outcome per
  person (done, not_pending, already_member, no_permission). Both need this account to be the
  group's owner or a deputy.
- A new request also lands in the live feed (`zalo_get_messages`) as a `group.join_request`
  message sent by the applicant, with their name when the pending list can be read.

## [1.1.0] - 2026-10-06

### Added
- Group joins with their exact time. Zalo reports a join only live, so the MCP server now
  listens for it and keeps a log on disk (`~/.zalo-agent-cli/group-joins.jsonl`, latest 5000).
  New read tool `zalo_get_group_joins` filters it by group, member and date.
- Each join also lands in the live feed (`zalo_get_messages`) as a `group.join` message sent by
  the newcomer, so an agent can react to it in order with the chat.
- Joins this account caused (it added someone) are no longer dropped: the MCP server listens
  to its own events and keeps its own chat messages out of the live feed as before.

## [1.0.0] - 2026-10-05

First release of javis-zalo, the Zalo CLI and MCP server maintained for Javis OS.

### Added
- MCP history tools: `zalo_get_history` serves group and 1:1 history captured since the server
  connected (seeded from Zalo's recent replay window), with `replyTo` and `mentions`;
  `zalo_search_history` searches it across chats by sender or date.
- `msg history <threadId>` command.
- The MCP server reconnects with backoff and warns when another session keeps taking over.

### Fixed
- Ctrl+C stops `listen` and `mcp start` cleanly instead of signing in again in a loop.
- Sending images and files to a Zalo Official Account.
- Status lines (`✓`, `✗`, `●`, `⚠`) go to stderr, so `--json` output on stdout stays clean.

### Security
- Opening a browser or file no longer goes through a shell. URLs and file names are passed as one
  argument, so they cannot inject commands (`oa init`, `oa login`, media viewer, tunnels).
- The QR login page no longer asks a third-party service for the machine's public IP.

### Removed
- Background update checks against the npm registry and the `update` command. Updates come from
  the app that installs this tool.
