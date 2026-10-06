# Changelog

All notable changes to javis-zalo. Newest first.

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
