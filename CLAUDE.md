# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Behavioral Guidelines

These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

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

**Important:** Running `npm run dev` (Vite only) does NOT include the Worker API — sync features, auth endpoints, and R2 attachment storage won't work. Use `npx wrangler dev` for full-stack local development.

---

## Architecture

Luciko is an offline-first, single-user SPA for browsing imported chat messages and social media posts. The app targets a single hardcoded conversation (`TARGET_CHAT` in `src/constants/chat.ts`).

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + TypeScript + Vite |
| Client DB | IndexedDB (via `idb` wrapper) |
| Backend | Cloudflare Worker (single `fetch` handler) |
| Server DB | Cloudflare D1 (SQLite) |
| File Storage | Cloudflare R2 (attachments/blobs) |
| Auth | HTTP Basic Auth → HMAC-signed Bearer tokens |
| Styling | CSS Modules (`*.module.css`) |
| Icons | Lucide React |

### Key Dependencies

- **`idb`** — Promise-based IndexedDB wrapper
- **`jszip`** — ZIP file parsing in the browser (for import archives)
- **`uuid`** — UUID v4 generation (message/attachment/post IDs)
- **`date-fns`** — Date formatting and comparison (no Moment.js bloat)
- **`lucide-react`** — Icon components

### Data Flow (Two Layers)

1. **Client-side IndexedDB** (`src/store/db.ts`) — The primary data store. Schema includes `messages`, `posts`, `attachments` (blobs), `hiddenItems`, and `bookmarks`. IndexedDB is the source of truth during normal use; the server is a backup/replication target.

2. **Cloudflare Worker** (`src/worker.ts`) — Serves the SPA from static assets and exposes a sync API backed by D1. All endpoints require HTTP Basic Auth for login, then Bearer token for subsequent requests. D1 tables: `archive_messages`, `archive_posts`, `archive_chunks`, `archive_bookmarks`, `sync_state`, `devices`, `sync_events`.

### File Map (Complete)

```
src/
├── main.tsx                          # Entry point, renders App, exposes window.__luciko debug helpers
├── App.tsx                           # Root component: AuthProvider → LoginScreen | AppLayout
├── worker.ts                         # Cloudflare Worker (all API routes in one fetch handler)
├── types/
│   ├── chat.ts                       # Message, Attachment, Chat types + validateMessage()
│   └── posts.ts                      # PostRecord, PostMedia types + validatePostRecord()
├── constants/
│   └── chat.ts                       # TARGET_CHAT_ID='c1', TARGET_CHAT (hardcoded person)
├── contexts/
│   └── AuthContext.tsx               # React context for auth state (loading|authenticated|unauthenticated)
├── store/
│   ├── db.ts                         # IndexedDB operations (CRUD, import with dedup, pagination, bookmarks)
│   ├── archiveSync.ts                # Push/pull sync between client IndexedDB and Worker
│   ├── search.ts                     # Client-side full-text search over IndexedDB
│   └── auth.ts                       # Auth token storage (localStorage), login/logout API calls
├── utils/
│   ├── text.ts                       # normalizeMojibakeText() — repairs Latin-1/UTF-8 double-encoding
│   └── gmailGoomoji.ts               # Maps Gmail's goomoji image URLs to Unicode emoji
├── importers/
│   ├── types.ts                      # ParseResult interface
│   ├── utils.ts                      # Shared CSV parser, attachment type detection
│   ├── whatsapp/parser.ts            # WhatsApp CSV-in-ZIP parser
│   ├── facebook/parser.ts            # Facebook + Instagram HTML-in-ZIP parser
│   ├── facebook/posts.ts             # Facebook posts/photos/videos JSON parser
│   ├── googlechat/parser.ts          # Google Chat JSON-in-ZIP parser
│   ├── googlechat/oldCsv.ts          # Legacy Google Chat CSV parser
│   ├── gmail/parser.ts               # Gmail CSV-in-ZIP parser
│   └── imessage/parser.ts            # iMessage JSON parser
├── components/
│   ├── layout/
│   │   ├── AppLayout.tsx             # Main layout: header nav, view routing, cloud health check, initial sync
│   │   ├── AppLayout.module.css
│   │   ├── ChatArea.tsx              # Chat view: infinite scroll, sticky date headers, bookmark scroll
│   │   └── ChatArea.module.css
│   ├── chat/
│   │   ├── MessageList.tsx           # Message list with automatic date separators
│   │   ├── MessageList.module.css
│   │   ├── MessageBubble.tsx         # Single message: content, attachments, reactions, quote reply, source badge
│   │   └── MessageBubble.module.css
│   ├── posts/
│   │   ├── PostsPage.tsx             # Posts feed: infinite scroll, bookmark, hide/show, media grid
│   │   └── PostsPage.module.css
│   ├── search/
│   │   ├── SearchPage.tsx            # Full-text search UI with scope tabs (All/Chat/Posts)
│   │   └── SearchPage.module.css
│   ├── import/
│   │   ├── ImportPage.tsx            # Drag-and-drop import UI, auto-detects format, triggers sync
│   │   ├── ImportPage.module.css
│   │   ├── StorageInfo.tsx           # Local vs remote item count display
│   │   └── StorageInfo.module.css
│   └── auth/
│       ├── LoginScreen.tsx           # Login form (username fixed to "luciko")
│       └── LoginScreen.module.css
├── styles/
│   ├── variables.css                 # CSS custom properties (colors, spacing)
│   └── global.css                    # Global styles, resets
└── assets/                           # Platform logos (whatsapp.png, facebook-messenger.svg, etc.)
```

---

## Key Modules (Detailed)

### `src/store/db.ts` — IndexedDB Operations

- **Schema version:** 8 (adds `hiddenItems` store in v8)
- **Stores:** `messages` (indexed by `chatId`, `externalId`, `chatId_timestamp`), `posts` (indexed by `externalId`, `timestamp`), `attachments` (blobs keyed by UUID), `hiddenItems` (keyed by `scope:itemId`), `bookmarks` (keyed by `chatId`)
- **`importMessages()`** — Batch-import with externalId-based deduplication. Three-phase: (1) normalize mojibake text, (2) precompute attachment SHA-256 hashes outside any transaction (crypto.subtle is non-IDB async), (3) batch-lookup all externalIds in parallel, then merge/insert in a single readwrite transaction. Handles chatId drift fixes and merges new attachments into existing messages.
- **`importPosts()`** — Same pattern as importMessages but for PostRecord. Merges media attachments, handles text/activity/linkUrl fill-in.
- **`getMessagesPaginated()` / `getPostsPaginated()`** — Cursor-based pagination using IndexedDB indexes.
- **`deduplicateLocalMessages()`** — Removes local messages with duplicate externalIds, keeping the earliest timestamp.
- **`countUniqueExternalIds()`** — Counts unique externalId values across the messages store.
- **`getAttachment()`** — Tries local IndexedDB first, falls back to remote R2 with local caching.
- **Bookmark operations:** `getBookmark()`, `setBookmark()`, `getAllBookmarks()`, `importBookmarks()` (full replacement — handles deletions from other devices).
- **Hidden item operations:** `getHiddenItems()`, `setHiddenItem()`.

### `src/store/archiveSync.ts` — Bidirectional Sync

A sophisticated push/pull system with chunked uploads, deduplication, retry logic, and progress tracking.

**Push flow (uploading local → remote):**
1. `syncNewItems()` — Takes newly inserted items, runs Pass 2 remote dedup (checks which externalIds already exist on the server), uploads remaining items in 500-item chunks.
2. `uploadAttachmentsToR2()` — Before stripping blob data from items, uploads attachment blobs from IndexedDB to R2 so other devices can fetch them.
3. `stripBlobs()` — Removes `file` properties from attachments/media before JSON serialization for D1.
4. Chunks are tracked in the `archive_chunks` table with SHA-256 payload hashes for dedup.
5. Progress communicated via listener pattern (`onSyncProgress`).

**Pull flow (downloading remote → local):**
1. `pullNewItems()` — Iterates messages then posts using keyset pagination (composite cursor: `updated_at, id`), imports into IndexedDB.
2. Self-healing: Detects cursor drift (local store empty but cursor non-zero, or remote counts > local counts) and resets the pull cursor.
3. Pull cutoff timestamp is recorded in localStorage (`luciko_last_pull_at`).
4. Auto-deduplicates local messages after pull if duplicates are detected.

**`syncAll()` — Full bidirectional sync:**
1. Pull remote → local first (download new items).
2. Sync bookmarks (pull then push — union merge on both sides).
3. Push local → remote only if local items exist that aren't confirmed on the server. Uses set-subtraction logic with `pulledMsgExternalIds`/`pulledPostExternalIds` to skip redundant uploads.

**Module-level state** survives page navigation (not tied to React lifecycle). Sync generations prevent stale operations from overwriting newer state.

### `src/worker.ts` — Cloudflare Worker (API Server)

All routes in a single `fetch` handler. Manual `Env` type definition (not compiled as part of the Vite build).

**Auth endpoints:**
- `POST /api/auth/login` — Basic Auth → returns HMAC-signed Bearer token + device_id. Registers device in D1.
- `GET /api/auth/status` — Validates Bearer token (checks D1 device revocation).
- `POST /api/auth/logout` — Revokes device in D1.
- `GET /api/health` — Lightweight token validation (crypto only, skips D1 device check to avoid query-per-poll).

**Sync endpoints:**
- `POST /api/sync/external-ids/exist` — Pass 2 dedup: checks which externalIds already exist in D1 (max 100 per request).
- `POST /api/sync/upload` — Receives a chunk of items, inserts into D1 with `INSERT OR REPLACE`, records chunk metadata, updates sync_state.
- `GET /api/sync/pull` — Returns items since a given cursor using composite keyset pagination (`updated_at, id` ordering). Column values (id, chat_id, timestamp) are authoritative over payload fields.
- `GET /api/sync/counts` — Returns total message/post counts from D1.

**Bookmark sync:**
- `POST /api/sync/bookmarks/upload` — Full replacement: deletes all existing bookmarks, inserts new set.
- `GET /api/sync/bookmarks/pull` — Returns bookmarks since a given timestamp.

**Attachment storage:**
- `PUT /api/attachments/<id>` — Upload blob to R2 with Content-Type metadata.
- `GET /api/attachments/<id>` — Download blob from R2 with immutable cache headers (1 year).

**Static assets:** All other routes are served via `env.ASSETS.fetch(request)` with SPA fallback — no auth gate (client handles auth).

**Auth internals:**
- Tokens are HMAC-SHA-256 signed payloads: `base64(payload).hex(signature)`.
- Payload: `{ u: 'luciko', ts: Date.now(), did: deviceId }`.
- `timingSafeEqual()` prevents timing attacks on auth comparisons.
- Device touch (last_seen_at update) is debounced to once per 5 minutes.

### `src/store/search.ts` — Full-Text Search

Client-side search over IndexedDB (no server round-trip):
- Tokenizes queries by stripping diacritics, lowercasing, splitting on non-alphanumeric chars.
- Scores matches: 10pts per matched token, +25 bonus for matching all tokens, +35 for exact phrase match.
- Generates excerpts (180 chars around first match).
- Searches both messages and posts. Message haystack includes senderId, content, quotedText, attachment names, source. Post haystack includes authorName, text, activity, linkUrl, media names.

### `src/utils/text.ts` — Mojibake Repair

`normalizeMojibakeText()` repairs text corrupted by Latin-1/UTF-8 double-encoding (common in older chat exports):
- Scores text for mojibake patterns (control characters in 0x80-0xBF range, Ã/Â sequences, replacement characters).
- Iteratively decodes as Latin-1 → UTF-8, keeping the version with the lowest mojibake score.
- Results are cached in a `Map` for performance.
- Also applies hardcoded replacement fixes for known corruption patterns.

### `src/utils/gmailGoomoji.ts` — Gmail Emoji Resolution

Maps Gmail's proprietary `goomoji` image references (`https://mail.google.com/mail/e/<CODE>`) to Unicode emoji characters. Contains a massive lookup table (~700 entries) extracted from Gmail's internal mapping.

---

## Import System

The import page (`ImportPage.tsx`) auto-detects the export format by probing ZIP contents or file extensions. Each parser produces `ParseResult` with `Message[]` or `ParsePostsResult` with `PostRecord[]`.

### Supported Formats

| Format | Parser | Detection | Type |
|--------|--------|-----------|------|
| WhatsApp | `whatsapp/parser.ts` | CSV with `@` in filename inside ZIP | Messages |
| Facebook Messenger | `facebook/parser.ts` | `message_*.html` files in ZIP | Messages |
| Instagram | `facebook/parser.ts` | `message_*.html` with Instagram branding | Messages |
| Facebook Posts | `facebook/posts.ts` | `posts/your_posts_*.json` in ZIP | Posts |
| Google Chat | `googlechat/parser.ts` | `messages.json` in ZIP | Messages |
| Google Chat (old) | `googlechat/oldCsv.ts` | CSV with sender/message/datetime columns | Messages |
| Gmail | `gmail/parser.ts` | `emails.csv` in ZIP | Messages |
| iMessage | `imessage/parser.ts` | JSON with `messages[].is_from_me` field | Messages |

### Parser Patterns

- **External IDs** are generated by each parser to enable deduplication across imports. WhatsApp uses `stanza_id` when available; Gmail uses timestamp+sender+recipient+subject; Facebook/Instagram use timestamp+sender+content+attachmentNames; Google Chat uses `message_id`.
- **Sender resolution** uses hardcoded mappings: WhatsApp matches export phone numbers to names, Gmail matches email addresses, iMessage uses `is_from_me` boolean.
- **Attachments** are extracted from ZIP entries and stored as Blobs with SHA-256 content hashes for deduplication.
- **Timestamps** use varied formats: WhatsApp ISO 8601, Facebook "Month Day, Year HH:MM:SS am/pm", Google Chat "Weekday, Month Day, Year at HH:MM:SS AM/PM UTC", iMessage date strings.
- All parsers sort messages by timestamp ascending before returning.

### Hardcoded Identities

This is a personal tool — sender identities are hardcoded in the parsers:
- **`src/importers/whatsapp/parser.ts`**: Lucy (phone numbers ending in 492571, 047078, 54006), Valerio (573770, 453398)
- **`src/importers/gmail/parser.ts`**: Email → Name map (luci.milella@gmail.com, valerio.donati@gmail.com)
- **`src/importers/googlechat/oldCsv.ts`**: Same email → name mapping
- **`src/importers/imessage/parser.ts`**: fromMe → "Luciana Milella", other → "Valerio Donati"
- **`src/components/layout/ChatArea.tsx`**: `CURRENT_USER_ID = "Valerio Donati"`

---

## D1 Migrations

Migrations in `migrations/`:
- `0001_initial.sql` — `sync_state`, `devices`, `sync_events`, `archive_messages`, `archive_posts`
- `0002_archive_tables.sql` — Standalone `archive_messages` + `archive_posts` (for environments without sync scaffolding)
- `0003_archive_chunks.sql` — `archive_chunks` table for chunked sync optimization
- `0004_payload_hash.sql` — Adds `payload_hash` column to `archive_chunks`
- `0005_device_auth.sql` — Activates the `devices` table for token-based auth (no schema change)
- `0006_bookmarks.sql` — `archive_bookmarks` table for cross-device bookmark sync
- `0007_external_id_column.sql` — Extracts `external_id` into a dedicated column with UNIQUE partial index, removes duplicate rows

Apply with `npx wrangler d1 migrations apply luciko-db`.

---

## Frontend Views

The app has four views (tabs) managed in `AppLayout`:

1. **Chat** (`ChatArea.tsx` + `MessageList.tsx` + `MessageBubble.tsx`)
   - Infinite-scroll message list using IntersectionObserver sentinels.
   - Sticky date headers that track the visible message's date.
   - Source platform badge (WhatsApp, Facebook, Gmail, etc.) on each message.
   - Bookmarking with scroll-to-bookmark and auto-scroll-to-bookmark on load.
   - Quote/reply rendering, reactions (emoji chips with counts), attachment previews (image lightbox, video player, audio player, document download).
   - Truncated long messages with "more" button (>350 chars).
   - Gmail content gets special rendering: subject line bold, quoted reply stripping, goomoji emoji resolution.

2. **Posts** (`PostsPage.tsx`)
   - Paginated social media posts feed with IntersectionObserver infinite scroll.
   - Media grid (images, videos), link previews, activity descriptions.
   - Bookmark with scroll-to-bookmark. Hide/unhide posts with toggle to show hidden.
   - Avatar mapping: author "Valerio" → valerio.jpg, others → luciko.jpg.

3. **Search** (`SearchPage.tsx`)
   - Full-text search with 200ms debounce.
   - Three scope tabs: All, Chat, Posts.
   - Clickable results that navigate to the message/post in its respective view.

4. **Import** (`ImportPage.tsx`)
   - Drag-and-drop or click-to-upload ZIP file.
   - Auto-detects import format from ZIP contents.
   - Shows import stats (total, inserted, updated, duplicates skipped).
   - Triggers background cloud sync for newly imported items.
   - Displays live sync progress (checking → uploading → done/error).
   - Storage info panel showing local vs remote item counts.

### App Lifecycle

1. On mount, `AuthContext` checks localStorage for a stored Bearer token and validates it against `/api/auth/status`.
2. On successful auth, `AppLayout` checks `/api/health` and triggers an initial `syncAll()` (pull then push).
3. Cloud status is polled every 5 minutes and on browser online/offline events.
4. `window.__luciko` debug helpers are exposed in `main.tsx`: `dedup()` and `countDups()` for manual IndexedDB deduplication from the browser console.

---

## Cloudflare Bindings

Configured in `wrangler.jsonc`:
- `LUCIKO_DB` — D1 database (`luciko-db`, ID `e47fdf8c-7817-4b03-b10f-9ee78b852030`)
- `LUCIKO_BUCKET` — R2 bucket (`luciko-bucket`)
- `LUCIKO_BASIC_AUTH_PASSWORD` — Secret for HTTP Basic Auth (user: `luciko`)

### Deployment

```bash
npx wrangler secret put LUCIKO_BASIC_AUTH_PASSWORD  # Set once
npx wrangler deploy                                   # Deploy Worker
```

---

## TypeScript Conventions

- `tsconfig.json` uses project references: `tsconfig.app.json` (browser code, `"moduleResolution": "bundler"`) and `tsconfig.node.json` (build tooling).
- The Worker (`src/worker.ts`) manually defines its `Env` type since it runs outside the Vite compilation context.
- ESLint flat config (`eslint.config.js`) with TypeScript ESLint, React Hooks, and React Refresh plugins.
- No strict null checks or strict mode enabled.

---

## Notes

- This is a personal tool with hardcoded sender identities (names and phone numbers embedded in parser files). Adding a new import source requires updating the parser constants.
- The `imports/` directory is gitignored and used as a staging area for raw export files before processing.
- There are no tests. The codebase relies on manual verification.
- Messages use `externalId` (generated by parsers or from platform-native IDs like WhatsApp's `stanza_id`) for deduplication across imports and sync.
- The attachment system stores blobs in a separate IndexedDB `attachments` store (keyed by UUID) to keep main records lightweight. SHA-256 hashes enable content-based dedup.
- Sync is chunk-based (500 items per chunk) with SHA-256 payload hashes stored in `archive_chunks` for tracking.
- The `CURRENT_USER_ID` hardcoded in `ChatArea.tsx` determines message alignment (sent vs received) and must match the parser name mappings.
- Date timestamps for messages use JavaScript `Date` objects in IndexedDB; post timestamps are Unix epoch seconds (numbers). This inconsistency is historical.
- Offline resilience: Auth is considered valid on network error (allowing offline use), sync failures are silently skipped with `skipped_offline` status, and a stale cursor is auto-reset when IndexedDB is empty.
