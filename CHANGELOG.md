# Changelog

All notable changes to javis-zalo. Newest first.

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

 - 2026-10-13

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
