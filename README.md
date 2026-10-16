# javis-zalo

Zalo command-line tool and MCP server maintained for [Javis OS](https://github.com/blogminhquy/javis-os).
It signs into a personal Zalo account by QR code, then reads and sends messages, manages groups,
notes, reminders and polls, either from the terminal or through the Model Context Protocol.

> **Unofficial API.** Personal-account features talk to Zalo through
> [zca-js](https://github.com/RFS-ADRENO/zca-js), a reverse-engineered client. Zalo does not
> support this and the account may be restricted or locked. Read [DISCLAIMER.md](DISCLAIMER.md).

## Install

Needs Node.js 20 or newer. Each release is a git tag, installed straight from GitHub (no npm
account, no Git on the machine):

```bash
npm install -g https://codeload.github.com/blogminhquy/javis-zalo/tar.gz/refs/tags/v1.2.0
```

Or run once without installing:

```bash
npx -y https://codeload.github.com/blogminhquy/javis-zalo/tar.gz/refs/tags/v1.2.0 --help
```

The command is `javis-zalo`. The older name `zalo-agent` is kept as an alias.

## Quick start

```bash
javis-zalo login                                  # prints a QR code; scan it in the Zalo app
javis-zalo conv recent                            # recent conversations
javis-zalo msg send <threadId> "Hello"            # 1:1 chat
javis-zalo msg send <threadId> "Hello" -t 1       # group
javis-zalo --json msg history <threadId> -t 1     # machine-readable output
```

Every command accepts `--json`. Run `javis-zalo <group> --help` for the full list (`msg`,
`friend`, `group`, `conv`, `account`, `profile`, `poll`, `reminder`, `label`, `catalog`,
`listen`, `oa`, `mcp`).

## MCP server

```bash
javis-zalo mcp start                              # stdio, for an MCP client
javis-zalo mcp start --http 3847 --auth <token>   # HTTP, bound to 127.0.0.1
```

Tools: `zalo_get_messages`, `zalo_get_history`, `zalo_search_history`, `zalo_list_threads`,
`zalo_search_threads`, `zalo_view_media`, `zalo_get_group_joins`, `zalo_list_join_requests` (read),
`zalo_mark_read` (write), `zalo_send_message` (sends a message), `zalo_send_file` (sends files) and
`zalo_review_join_requests` (approves or rejects people waiting to join a group; needs owner or deputy
rights).

`zalo_send_file` sends only files placed in `~/.zalo-agent-cli/outbox/`, so a prompt cannot make it
send any other file on the machine. Zalo confirms a file upload (anything but jpg, png, webp, gif)
only over the live connection, which the MCP server holds; without that confirmation the tool fails
after 60 seconds and nothing is sent.

The one-shot `msg send-file` command has no live connection of its own, so a file fails at once with
that explanation. `--listen` opens one for the send, but Zalo keeps one Web connection per account:
it disconnects any other session, and a running `mcp start` exits. With an MCP server running, send
files through `zalo_send_file`.

Group joins are recorded with their exact time while the server is connected and kept in
`~/.zalo-agent-cli/group-joins.jsonl`. Zalo's member list has no join date, so members who joined
earlier, or while the server was offline, are not in it.

The three read tools serve messages this server captured itself: live over the connection, plus
Zalo's replay of recent messages each time it connects. There is no API to ask Zalo for a DM's
history later, so a message that arrives while the server is down (a restart, an update, another
Zalo Web session holding the connection) is only seen if that replay brings it back. Each read
result therefore carries `sync`: `complete: false` lists the outages the replay did not cover, and
a caller must not conclude from it that a contact did not reply. Messages recovered by the replay
also go to the live feed, flagged `recovered: true`. History is kept in
`~/.zalo-agent-cli/history.jsonl` (30 days) and the outages in `~/.zalo-agent-cli/sync-state.json`,
so a restart neither wipes history nor goes unnoticed.

## Where data lives

Sessions and settings stay on your machine under `~/.zalo-agent-cli/` (accounts, credentials,
MCP config, downloaded media, captured message history). Zalo Official Account credentials live in `~/.zalo-agent/`. The
folder names are kept from earlier builds so accounts that are already signed in stay signed in.

Nothing is sent anywhere except Zalo itself, a webhook or proxy you configure, and `qr.sepay.vn`
when you ask for a bank-transfer QR image.

## Development

```bash
npm ci
npm test
npm run lint
npm run format:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE).
