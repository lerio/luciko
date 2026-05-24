# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server (frontend only, no Worker API)
npm run build        # TypeScript check + Vite production build
npm run lint         # ESLint across all TS/TSX files
npm run preview      # Preview production build locally

npx wrangler dev     # Local Cloudflare Worker (serves API + static assets)
npx wrangler deploy  # Deploy Worker to Cloudflare
```

Run `tsc -b` for type-checking only (no emit). Wrangler uses `src/worker.ts` as its entrypoint and expects `./dist` for static assets.

## Architecture

Luciko is an offline-first, single-user SPA for browsing imported chat messages and social media posts. The app targets a single hardcoded conversation (`TARGET_CHAT` in `src/constants/chat.ts`).

### Data flow (two layers)

1. **Client-side IndexedDB** (`src/store/db.ts`) — The primary data store. Schema includes `messages`, `posts`, `attachments` (blobs), `hiddenItems`, and `bookmarks`. IndexedDB is the source of truth during normal use; the server is a backup/replication target.

2. **Cloudflare Worker** (`src/worker.ts`) — Serves the SPA from static assets and exposes a sync API backed by D1. All endpoints require HTTP Basic Auth. D1 tables: `archive_messages`, `archive_posts`, `archive_chunks`, plus scaffolding for `sync_state`, `devices`, `sync_events`.

### Key modules

- **`src/store/archiveSync.ts`** — Push/pull sync between client IndexedDB and the Worker. Uses diff-based checks (SHA-256 hashing) to avoid re-uploading unchanged items. Messages and posts are synced in chunks (500 items per page).

- **`src/store/db.ts`** — IndexedDB operations: paginated reads, imports with deduplication (via `externalId`), attachment storage, bookmarks, hidden items. Import operations (`importMessages`, `importPosts`) merge blobs into the `attachments` store and strip them from the main records.

- **`src/store/search.ts`** — Client-side full-text search over IndexedDB. Tokenizes queries, strips diacritics, scores matches, and generates excerpts. Searches messages and posts separately.

- **`src/importers/`** — Parsers for export formats from WhatsApp (CSV in ZIP), Facebook/Instagram (HTML in ZIP), Gmail (CSV in ZIP), Google Chat (JSON), and iMessage. Each parser produces `ParseResult` with `Message[]`. WhatsApp and Facebook parsers resolve sender identities from hardcoded phone number/name mappings.

- **`src/utils/text.ts`** — `normalizeMojibakeText()` repairs text corrupted by Latin-1/UTF-8 double-encoding (common in older chat exports). Used by the importer and search pipeline.

- **`src/utils/gmailGoomoji.ts`** — Maps Gmail's proprietary `goomoji` image references to Unicode emoji characters.

### Frontend views

The app has four views (tabs) managed in `AppLayout`:

- **Chat** — Infinite-scroll message list with sentinel-based loading, sticky date headers, bookmarking, and message hiding.
- **Posts** — Paginated social media posts.
- **Search** — Full-text search across messages and posts, with click-to-navigate results.
- **Import** — File upload UI for parsing and importing export archives from each platform.

### Cloudflare bindings

Configured in `wrangler.jsonc`:
- `LUCIKO_DB` — D1 database (`luciko-db`, ID `e47fdf8c-...`)
- `LUCIKO_BUCKET` — R2 bucket (`luciko-bucket`)
- `LUCIKO_BASIC_AUTH_PASSWORD` — Secret for HTTP Basic Auth (user: `luciko`)

### Migrations

D1 migrations in `migrations/`:
- `0001_initial.sql` — `sync_state`, `devices`, `sync_events`, `archive_messages`, `archive_posts`
- `0002_archive_tables.sql` — Standalone `archive_messages` + `archive_posts` (for environments without sync scaffolding)
- `0003_archive_chunks.sql` — `archive_chunks` table for chunked sync optimization

Apply with `npx wrangler d1 migrations apply luciko-db`.

### TypeScript conventions

The `tsconfig.json` uses project references: `tsconfig.app.json` (browser code) and `tsconfig.node.json` (build tooling). The Worker (`src/worker.ts`) manually defines its `Env` type since it runs outside the Vite compilation context but is part of the same source tree.

## Notes

- This is a personal tool with hardcoded sender identities (names and phone numbers embedded in parser files). Adding a new import source requires updating the parser constants.
- The `imports/` directory is gitignored and used as a staging area for raw export files before processing.
- There are no tests. The codebase relies on manual verification.
