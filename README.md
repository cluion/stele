# Stele

> Local-first knowledge base. Carved to last.

[![CI](https://github.com/cluion/stele/actions/workflows/ci.yml/badge.svg)](https://github.com/cluion/stele/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)

**English** · [繁體中文](README.zh-TW.md)

Stele is a local-first, end-to-end-encrypted, self-hostable knowledge base. Your notes are always a byte-exact, human-readable, git-friendly plain-Markdown mirror on disk — backed by a CRDT that gives you flawless offline merging and multi-device sync.

## Principles

- **Local-first**: A complete plain-Markdown copy always lives on disk. Delete the sync state, shut down the server — your data stays intact.
- **CRDT is the source of truth, Markdown is the mirror**: A Y.Text holds the raw Markdown as the source of truth; the `.md` file is a byte-exact mirror. External edits (other editors, git, scripts) are absorbed back into the CRDT.
- **End-to-end encrypted sync**: The self-hosted sync server is a blind relay that only stores encrypted blobs — it never sees your note contents or filenames.
- **Open source, MIT**: Every runtime dependency is MIT (or a compatible permissive license, tracked individually).

## Features

- True WYSIWYG editing (ProseMirror) plus a source mode (CodeMirror 6), toggle with Cmd/Ctrl+E
- Wikilinks `[[ ]]`: autocomplete, click-to-navigate, create-on-the-fly, vault-wide link rewriting on rename
- Backlinks panel and graph view
- Daily notes with templates, CJK full-text search, quick switcher (Cmd/Ctrl+P)
- Quartz Day / Ember Night dual themes — dark is a native design, not an inversion
- Multi-device end-to-end encrypted sync, self-hosted server in one `docker run`
- Built-in i18n (zh-TW / en)

## Develop & run

Requires Node ≥ 24 and pnpm.

```bash
pnpm install
pnpm --filter @stele/desktop start   # launch the desktop app
pnpm check                            # lint + typecheck + test + license check
```

## Self-hosted sync server

```bash
docker build -f apps/server/Dockerfile -t stele-server .
docker run -d -p 4800:4800 -v stele-data:/data -e STELE_TOKEN=replace-with-a-16+-char-secret stele-server
```

Enable encrypted sync by filling in `url`, `token`, and `passphrase` in your vault's `.stele/sync.json`. See [apps/server/README.md](apps/server/README.md) for details.

## Architecture

A single TypeScript monorepo (pnpm workspace):

| Package | Responsibility |
|---|---|
| `packages/editor-core` | Block-mapping engine, SteleBinding, wikilinks |
| `packages/sync` | Sync protocol, SyncClient, E2EE crypto layer |
| `packages/ui` | Design system and tokens |
| `apps/desktop` | Electron desktop app |
| `apps/server` | Self-hosted sync server (blind relay) |

## License

MIT — see [LICENSE](LICENSE).
