# Luciko

A personal, offline-first web app for browsing, searching, and archiving chat messages and social media posts — imported from WhatsApp, Facebook, Instagram, Gmail, Google Chat, and iMessage exports.

All data lives in your browser's IndexedDB. An optional Cloudflare Worker backend provides encrypted cloud backup and cross-device sync via D1 and R2.

## Features

- **Import** — Drag-and-drop ZIP exports from 6 platforms. Format auto-detection. Deduplication across repeated imports.
- **Chat view** — Infinite-scroll message timeline with sticky date headers, source platform badges, reaction chips, quoted replies, and attachment previews (images, video, audio, documents).
- **Posts view** — Social media feed with media grid, bookmarks, and hide/unhide.
- **Full-text search** — Client-side search across all messages and posts. Diacritic-insensitive, scored, with excerpts.
- **Bookmarks** — Bookmark any message or post. Synced across devices.
- **Cloud sync** — Optional bidirectional sync to Cloudflare D1 + R2. Chunked uploads with SHA-256 dedup. Works offline — syncs when reconnected.
- **Privacy** — HTTP Basic Auth + HMAC-signed Bearer tokens. Device registration and revocation. All sync traffic is authenticated.

## Supported Import Formats

| Platform | Export Format | What's Imported |
|----------|--------------|-----------------|
| WhatsApp | ZIP (CSV + media) | Messages, reactions, attachments |
| Facebook Messenger | ZIP (HTML + media) | Messages, attachments |
| Instagram | ZIP (HTML + media) | Messages, attachments |
| Facebook Posts | ZIP (JSON + media) | Posts, photos, videos |
| Google Chat | ZIP (JSON + media) | Messages, attachments |
| Google Chat (legacy) | CSV | Messages |
| Gmail | ZIP (CSV + attachments) | Emails as messages, attachments |
| iMessage | JSON | Messages |

Text in older exports is automatically repaired for mojibake (Latin-1/UTF-8 double-encoding corruption). Gmail's proprietary goomoji image references are resolved to Unicode emoji.

## Architecture

```
Browser (IndexedDB)  ←→  Cloudflare Worker  ←→  Cloudflare D1 + R2
     (source of truth)       (sync server)         (backup/replication)
```

- **Frontend**: React 19 + TypeScript + Vite + CSS Modules
- **Client DB**: IndexedDB (via `idb`), stores messages, posts, attachments (blobs), bookmarks, hidden items
- **Backend**: Single Cloudflare Worker (`src/worker.ts`) handling auth, sync, and attachment APIs
- **Server DB**: Cloudflare D1 (SQLite) for archive data, device registry, bookmarks
- **File Storage**: Cloudflare R2 for attachment blobs
- **Auth**: Password → HMAC-SHA-256 Bearer tokens. Device-based: each login creates a device record; logout revokes it.

## Getting Started

### Prerequisites

- Node.js 18+
- A Cloudflare account (for sync/backup features)

### Local Development

```bash
npm install
npm run dev          # Frontend only (Vite dev server, no backend)
```

For full-stack development with the Worker API:

```bash
npx wrangler dev     # Worker + static assets (requires Cloudflare account)
```

### Cloudflare Setup

1. Create a D1 database and R2 bucket in the Cloudflare dashboard.

2. Update `wrangler.jsonc` with your resource IDs.

3. Set the auth secret:
   ```bash
   npx wrangler secret put LUCIKO_BASIC_AUTH_PASSWORD
   ```
   Use a long, unique password. The username is fixed to `luciko`.

4. Apply D1 migrations:
   ```bash
   npx wrangler d1 migrations apply luciko-db
   ```

5. Deploy:
   ```bash
   npm run build
   npx wrangler deploy
   ```

### Running Without Cloudflare

The app works fully offline without any backend. Skip the Cloudflare setup — the import, browsing, and search features all function with just `npm run build` served from any static host.

## Project Structure

```
src/
├── main.tsx                  # Entry point
├── App.tsx                   # Root component (auth gate)
├── worker.ts                 # Cloudflare Worker (API server)
├── types/                    # Message, Post, Attachment type definitions
├── constants/                # Hardcoded chat target
├── contexts/                 # React auth context
├── store/
│   ├── db.ts                 # IndexedDB operations (CRUD, import, dedup)
│   ├── archiveSync.ts        # Bidirectional push/pull sync engine
│   ├── search.ts             # Client-side full-text search
│   └── auth.ts               # Token storage and API helpers
├── utils/
│   ├── text.ts               # Mojibake text repair
│   └── gmailGoomoji.ts       # Gmail emoji resolution
├── importers/
│   ├── whatsapp/parser.ts
│   ├── facebook/parser.ts    # Facebook Messenger + Instagram
│   ├── facebook/posts.ts     # Facebook Posts/Photos/Videos
│   ├── googlechat/parser.ts  # Google Chat (JSON)
│   ├── googlechat/oldCsv.ts  # Google Chat (legacy CSV)
│   ├── gmail/parser.ts
│   └── imessage/parser.ts
├── components/
│   ├── layout/               # AppLayout, ChatArea
│   ├── chat/                 # MessageList, MessageBubble
│   ├── posts/                # PostsPage
│   ├── search/               # SearchPage
│   ├── import/               # ImportPage, StorageInfo
│   └── auth/                 # LoginScreen
├── styles/                   # Global CSS and variables
└── assets/                   # Platform logo images
migrations/                   # D1 SQL migrations (7 files)
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server (frontend only) |
| `npm run build` | TypeScript check + production build |
| `npm run lint` | ESLint across all TS/TSX files |
| `npm run preview` | Preview production build locally |
| `npx wrangler dev` | Local Worker + static assets |
| `npx wrangler deploy` | Deploy Worker to Cloudflare |
| `npx wrangler d1 migrations apply luciko-db` | Apply D1 migrations |

## Sync Design

The sync engine operates in two directions:

**Push** (local → remote): Newly imported items are checked against the server by `externalId` (Pass 2 dedup), then uploaded in 500-item chunks. Attachment blobs are uploaded to R2 before the metadata payload is sent to D1. Chunk hashes prevent re-uploading identical data.

**Pull** (remote → local): The server is polled using composite keyset pagination (`updated_at, id`) to avoid skipping items. A self-healing cursor detects drift (e.g., if IndexedDB was wiped) and resets automatically. Pulled items are deduplicated against local data by `externalId`.

Bookmarks use a simple union-merge: pull the server's set, merge with local, push the combined set back.

Sync is triggered on app load and after each import. Cloud health is polled every 5 minutes.

## Design Notes

- **No tests** — this is a personal tool; correctness is verified manually.
- **Hardcoded identities** — sender names and phone numbers/emails are embedded in the parser files. Adding a new person requires updating these constants.
- **Single chat** — the app targets one hardcoded conversation. The posts view is the only multi-source feed.
- **`imports/`** — gitignored directory for staging raw export files before processing.
- **Offline-first** — the app works without a backend. Auth is treated as valid on network errors so the UI remains usable.
