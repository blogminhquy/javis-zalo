# Changelog

All notable changes to javis-zalo. Newest first.

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
