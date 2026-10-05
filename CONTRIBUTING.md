# Contributing

Thanks for helping. javis-zalo is the Zalo layer of Javis OS, so changes are judged by whether
they keep Javis's Zalo connection working.

## Setup

```bash
npm ci
npm test            # node:test, no Zalo session needed
npm run lint
npm run format:check
```

## Rules

- **Keep `--json` output stable.** Javis parses it. Data goes to stdout as one JSON value; status
  lines go to stderr through `src/utils/output.js`. Renaming a field is a breaking change.
- **Keep the MCP tool names and parameters stable** for the same reason. Adding a tool or an
  optional parameter is fine.
- **No shell.** Run external programs with `spawn`/`execFile` and an argument array
  (`src/utils/open-external.js`), never by building a command string.
- **No calls to third-party services** beyond Zalo, a webhook or proxy the user configured, and
  `qr.sepay.vn` for transfer QR images.
- **Keep the data folders** `~/.zalo-agent-cli` and `~/.zalo-agent`. Renaming them signs every
  user out.
- Put a test next to the module it covers (`foo.js` next to `foo.test.js`).

## zca-js

The Zalo protocol lives in [zca-js](https://github.com/RFS-ADRENO/zca-js), used from its
official npm releases. When Zalo changes something, the fix usually belongs there: wait for a new
zca-js release. Try a new major version (3.x) on a test account before raising the range in
`package.json`.

## Releasing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Merge to `main` with CI green.
3. Tag `vX.Y.Z` and push the tag. The release workflow runs the tests, installs from the tag
   tarball and publishes a GitHub Release. Javis pins that tag's tarball URL.
