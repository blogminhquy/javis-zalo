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
npm install -g https://codeload.github.com/blogminhquy/javis-zalo/tar.gz/refs/tags/v1.0.0
```

Or run once without installing:

```bash
npx -y https://codeload.github.com/blogminhquy/javis-zalo/tar.gz/refs/tags/v1.0.0 --help
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
`zalo_search_threads`, `zalo_view_media` (read), `zalo_mark_read` (write) and
`zalo_send_message` (sends a message).

## Where data lives

Sessions and settings stay on your machine under `~/.zalo-agent-cli/` (accounts, credentials,
MCP config, downloaded media). Zalo Official Account credentials live in `~/.zalo-agent/`. The
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
