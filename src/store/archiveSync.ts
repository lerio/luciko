import { getAuthHeaders } from './auth';
import { importMessages, importPosts, getMessagesCount, getTotalMessagesCount, countMessagesWithChatId, countUniqueExternalIds, deduplicateLocalMessages, getMessagesPaginated, getPosts, getPostsCount, getAllBookmarks, importBookmarks, getAttachmentLocal } from './db';
import { TARGET_CHAT_ID } from '../constants/chat';

const LAST_PULL_KEY = 'luciko_last_pull_at';
const LAST_PUSH_KEY = 'luciko_last_push_at';
const LOCAL_CHANGE_KEY = 'luciko_local_change_at';

function getLastPullAt(): number {
    try {
        const raw = localStorage.getItem(LAST_PULL_KEY);
        return raw ? parseInt(raw, 10) || 0 : 0;
    } catch {
        return 0;
    }
}

function setLastPullAt(ts: number): void {
    try {
        localStorage.setItem(LAST_PULL_KEY, String(ts));
    } catch { /* ignore */ }
}

function getLastPushAt(): number {
    try {
        const raw = localStorage.getItem(LAST_PUSH_KEY);
        return raw ? parseInt(raw, 10) || 0 : 0;
    } catch {
        return 0;
    }
}

function setLastPushAt(ts: number): void {
    try {
        localStorage.setItem(LAST_PUSH_KEY, String(ts));
    } catch { /* ignore */ }
}

/** Call whenever local data is modified (import, manual edit, etc.). */
export function markLocalChanged(): void {
    try {
        localStorage.setItem(LOCAL_CHANGE_KEY, String(Date.now()));
    } catch { /* ignore */ }
}

function getLocalChangedAt(): number {
    try {
        const raw = localStorage.getItem(LOCAL_CHANGE_KEY);
        return raw ? parseInt(raw, 10) || 0 : 0;
    } catch {
        return 0;
    }
}

export type SyncEntity = 'messages' | 'posts';

export interface SyncProgress {
    phase: 'idle' | 'checking' | 'uploading' | 'done' | 'error' | 'skipped_offline';
    totalItems: number;
    checkedItems: number;
    uploadedChunks: number;
    totalChunks: number;
    insertedRemote: number;
    error?: string;
}

export interface SyncResult {
    success: boolean;
    inserted: number;
    dedupedRemotely: number;
    chunksUploaded: number;
    error?: string;
}

const CHUNK_SIZE = 500;
const DEDUP_BATCH_SIZE = 99; // D1 limit is 100 bound parameters per query; stay under it
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Module-level state so sync survives page navigation
let currentSyncState: SyncProgress = {
    phase: 'idle',
    totalItems: 0,
    checkedItems: 0,
    uploadedChunks: 0,
    totalChunks: 0,
    insertedRemote: 0,
};
let syncGeneration = 0;
let syncListeners: Array<(state: SyncProgress) => void> = [];

export function getSyncProgress(): SyncProgress {
    return { ...currentSyncState };
}

export function onSyncProgress(cb: (state: SyncProgress) => void): () => void {
    syncListeners.push(cb);
    return () => {
        syncListeners = syncListeners.filter(l => l !== cb);
    };
}

function notifySyncListeners(): void {
    const state = { ...currentSyncState };
    console.log('[archiveSync] notifying', syncListeners.length, 'listeners with phase:', state.phase);
    syncListeners.forEach(cb => cb(state));
}

/**
 * Check which externalIds already exist on the remote server (Pass 2 dedup).
 * Batches requests in groups of CHUNK_SIZE to stay within D1 bind parameter limits.
 */
async function checkRemoteExternalIds(
    entity: SyncEntity,
    externalIds: string[],
    generation: number,
): Promise<Set<string>> {
    const validIds = externalIds.filter(Boolean) as string[];
    if (validIds.length === 0) return new Set();

    const existing = new Set<string>();

    for (let i = 0; i < validIds.length; i += DEDUP_BATCH_SIZE) {
        // Abort if a newer sync has started
        if (generation !== syncGeneration) throw new Error('Sync superseded');

        const batch = validIds.slice(i, i + DEDUP_BATCH_SIZE);
        const headers: Record<string, string> = {
            ...getAuthHeaders(),
            'Content-Type': 'application/json',
        };

        let lastError: Error | undefined;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const response = await fetch('/api/sync/external-ids/exist', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ entity, ids: batch }),
                });

                if (!response.ok) {
                    if (response.status === 401) throw new Error('Authentication failed');
                    let serverError = '';
                    try {
                        const errBody = await response.json() as { error?: string };
                        serverError = errBody.error ? `: ${errBody.error}` : '';
                    } catch { /* ignore */ }
                    throw new Error(`Server returned ${response.status}${serverError}`);
                }

                // Detect HTML response (Worker API not available — likely npm run dev without wrangler)
                const contentType = response.headers.get('Content-Type') || '';
                if (contentType.includes('text/html')) {
                    throw new Error('API endpoint not available. Run the app with `npx wrangler dev` to enable cloud sync.');
                }

                const data = await response.json() as { existingIds: string[] };
                data.existingIds.forEach(id => existing.add(id));
                lastError = undefined;
                break;
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempt < MAX_RETRIES - 1) {
                    await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
                }
            }
        }

        if (lastError) throw lastError;
    }

    return existing;
}

/**
 * Upload a single chunk of items to the remote server.
 */
async function uploadChunk(
    entity: SyncEntity,
    chunkIndex: number,
    totalChunks: number,
    items: unknown[],
    generation: number,
): Promise<{ inserted: number; chunkHash: string }> {
    const headers: Record<string, string> = {
        ...getAuthHeaders(),
        'Content-Type': 'application/json',
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        // Abort if a newer sync has started
        if (generation !== syncGeneration) throw new Error('Sync superseded');

        try {
            const response = await fetch('/api/sync/upload', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    entity,
                    chunkIndex,
                    totalChunks,
                    items,
                }),
            });

            if (!response.ok) {
                if (response.status === 401) throw new Error('Authentication failed');
                // Try to extract a server error message from the response body
                let serverError = '';
                try {
                    const errBody = await response.json() as { error?: string };
                    serverError = errBody.error ? `: ${errBody.error}` : '';
                } catch { /* ignore */ }
                throw new Error(`Server returned ${response.status}${serverError}`);
            }

            return await response.json() as { inserted: number; chunkHash: string };
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt < MAX_RETRIES - 1) {
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
            }
        }
    }

    throw lastError ?? new Error('Upload failed after retries');
}

/**
 * Prepare an item for upload by stripping blob data (attachments/media files).
 * D1 stores JSON-serializable metadata only; blobs stay in IndexedDB.
 */
function stripBlobs(item: Record<string, unknown>): Record<string, unknown> {
    const clone = { ...item };

    if (clone.attachments && Array.isArray(clone.attachments)) {
        clone.attachments = clone.attachments.map((att: Record<string, unknown>) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { file, ...rest } = att;
            return rest;
        });
    }

    if (clone.media && Array.isArray(clone.media)) {
        clone.media = clone.media.map((m: Record<string, unknown>) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { file, ...rest } = m;
            return rest;
        });
    }

    // Convert Date objects to ISO strings for JSON serialization
    if (clone.timestamp instanceof Date) {
        clone.timestamp = clone.timestamp.getTime();
    }

    return clone;
}

/**
 * Upload attachment blobs to R2 before they're stripped from the sync payload.
 * Iterates through items, finds attachments with blob data in local IndexedDB,
 * and uploads them to the server so other devices can fetch them.
 */
async function uploadAttachmentsToR2(items: Array<{ [key: string]: unknown }>): Promise<void> {
    const authHeaders = getAuthHeaders();
    if (!authHeaders.Authorization) return;

    // Collect all unique attachment IDs that need uploading
    const seen = new Set<string>();
    const uploads: Array<{ id: string; blob: Blob }> = [];

    for (const item of items) {
        // Handle both message attachments and post media
        const attList = (item.attachments || item.media) as Array<Record<string, unknown>> | undefined;
        if (!attList?.length) continue;

        for (const att of attList) {
            const attId = att.id as string;
            if (!attId || seen.has(attId)) continue;
            seen.add(attId);

            // The blob is in the separate 'attachments' IndexedDB store,
            // not on the item object itself. Use local-only lookup to
            // avoid a server round-trip when the blob isn't cached yet.
            try {
                const blob = await getAttachmentLocal(attId);
                if (blob) {
                    uploads.push({ id: attId, blob });
                }
            } catch { /* skip if not found */ }
        }
    }

    // Upload blobs to R2 in parallel
    if (uploads.length > 0) {
        console.log('[uploadAttachmentsToR2] Uploading', uploads.length, 'attachments');
        await Promise.all(uploads.map(async ({ id, blob }) => {
            try {
                const resp = await fetch(`/api/attachments/${encodeURIComponent(id)}`, {
                    method: 'PUT',
                    headers: {
                        ...authHeaders,
                        'Content-Type': blob.type || 'application/octet-stream',
                    },
                    body: blob,
                });
                if (!resp.ok) {
                    console.warn('[uploadAttachmentsToR2] Failed to upload', id, resp.status);
                }
            } catch (err) {
                console.warn('[uploadAttachmentsToR2] Error uploading', id, err);
            }
        }));
    }
}

/**
 * Main sync orchestrator: given items that were just inserted locally,
 * run Pass 2 remote dedup and upload remaining items in chunks.
 *
 * Fire-and-forget — the caller doesn't need to await the result.
 * Progress is communicated via the listener pattern (onSyncProgress).
 */
export async function syncNewItems(
    entity: SyncEntity,
    items: Array<{ id: string; externalId?: string; [key: string]: unknown }>,
): Promise<SyncResult> {
    const generation = ++syncGeneration;
    console.log('[archiveSync] syncNewItems called:', { entity, itemsLen: items.length, generation });

    // Reset state
    currentSyncState = {
        phase: items.length > 0 ? 'checking' : 'done',
        totalItems: items.length,
        checkedItems: 0,
        uploadedChunks: 0,
        totalChunks: 0,
        insertedRemote: 0,
    };
    console.log('[archiveSync] Phase set to:', currentSyncState.phase);
    notifySyncListeners();

    if (items.length === 0) {
        console.log('[archiveSync] No items, returning early');
        return { success: true, inserted: 0, dedupedRemotely: 0, chunksUploaded: 0 };
    }

    try {
        // Pass 2: remote dedup by externalId
        const externalIds = items
            .map(item => item.externalId)
            .filter(Boolean) as string[];

        console.log('[archiveSync] ExternalIds to check:', externalIds.length);

        let existingRemoteIds: Set<string> = new Set();

        if (externalIds.length > 0) {
            console.log('[archiveSync] Starting remote dedup check...');
            existingRemoteIds = await checkRemoteExternalIds(entity, externalIds, generation);
            console.log('[archiveSync] Remote dedup found:', existingRemoteIds.size, 'existing IDs');
        }

        // Filter out items whose externalId already exists remotely
        const itemsToUpload = items.filter(item => {
            if (!item.externalId) return true; // no externalId — always upload
            return !existingRemoteIds.has(item.externalId);
        });

        currentSyncState.checkedItems = items.length;
        currentSyncState.totalItems = itemsToUpload.length;
        currentSyncState.totalChunks = Math.ceil(itemsToUpload.length / CHUNK_SIZE);
        currentSyncState.phase = itemsToUpload.length > 0 ? 'uploading' : 'done';
        notifySyncListeners();

        if (itemsToUpload.length === 0) {
            return { success: true, inserted: 0, dedupedRemotely: existingRemoteIds.size, chunksUploaded: 0 };
        }

        // Upload in chunks
        let totalInsertedRemote = 0;

        for (let i = 0; i < itemsToUpload.length; i += CHUNK_SIZE) {
            // Abort if a newer sync has started
            if (generation !== syncGeneration) {
                return { success: false, inserted: totalInsertedRemote, dedupedRemotely: 0, chunksUploaded: currentSyncState.uploadedChunks, error: 'Sync superseded' };
            }

            const chunk = itemsToUpload.slice(i, i + CHUNK_SIZE);
            const chunkIndex = Math.floor(i / CHUNK_SIZE);

            // Upload attachment blobs to R2 before stripping them from the payload
            await uploadAttachmentsToR2(chunk);

            const cleanItems = chunk.map(item => stripBlobs(item as Record<string, unknown>));

            const result = await uploadChunk(entity, chunkIndex, currentSyncState.totalChunks, cleanItems, generation);
            totalInsertedRemote += result.inserted;

            currentSyncState.uploadedChunks = chunkIndex + 1;
            currentSyncState.insertedRemote = totalInsertedRemote;
            notifySyncListeners();
        }

        currentSyncState.phase = 'done';
        notifySyncListeners();

        return {
            success: true,
            inserted: totalInsertedRemote,
            dedupedRemotely: existingRemoteIds.size,
            chunksUploaded: currentSyncState.totalChunks,
        };
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown sync error';
        console.error('[archiveSync] Sync failed:', errorMsg, err);

        // Detect offline / network-unreachable errors
        const isOffline =
            errorMsg.includes('Failed to fetch') ||
            errorMsg.includes('NetworkError') ||
            errorMsg === 'Sync superseded';

        if (errorMsg === 'Sync superseded') {
            // Don't overwrite state set by a newer sync
            return { success: false, inserted: currentSyncState.insertedRemote, dedupedRemotely: 0, chunksUploaded: currentSyncState.uploadedChunks, error: errorMsg };
        }

        currentSyncState.phase = isOffline ? 'skipped_offline' : 'error';
        currentSyncState.error = errorMsg;
        notifySyncListeners();

        return {
            success: false,
            inserted: currentSyncState.insertedRemote,
            dedupedRemotely: 0,
            chunksUploaded: currentSyncState.uploadedChunks,
            error: errorMsg,
        };
    }
}

// ─── Pull sync (download new items from remote D1) ───

export type PullPhase = 'idle' | 'checking' | 'downloading' | 'done' | 'error' | 'skipped_offline';

export interface PullProgress {
    phase: PullPhase;
    totalItems: number;
    pulledItems: number;
    insertedLocal: number;
    error?: string;
}

const PULL_BATCH_SIZE = 500;
const PULL_MAX_RETRIES = 3;
const PULL_RETRY_DELAY_MS = 1000;

let currentPullState: PullProgress = {
    phase: 'idle',
    totalItems: 0,
    pulledItems: 0,
    insertedLocal: 0,
};
let pullGeneration = 0;
let pullListeners: Array<(state: PullProgress) => void> = [];

function notifyPullListeners(): void {
    const state = { ...currentPullState };
    pullListeners.forEach(cb => cb(state));
}

export function getPullProgress(): PullProgress {
    return { ...currentPullState };
}

export function onPullProgress(cb: (state: PullProgress) => void): () => void {
    pullListeners.push(cb);
    return () => {
        pullListeners = pullListeners.filter(l => l !== cb);
    };
}

/**
 * Fetch a single batch of items from the pull endpoint, with retries.
 */
async function pullBatch(
    url: string,
    generation: number,
): Promise<{ items: unknown[]; hasMore: boolean; nextSince: number; nextSinceId: string }> {
    const headers: Record<string, string> = { ...getAuthHeaders() };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < PULL_MAX_RETRIES; attempt++) {
        if (generation !== pullGeneration) throw new Error('Pull superseded');

        try {
            const response = await fetch(url, { headers });

            if (!response.ok) {
                if (response.status === 401) throw new Error('Authentication failed');
                let serverError = '';
                try {
                    const errBody = await response.json() as { error?: string };
                    serverError = errBody.error ? `: ${errBody.error}` : '';
                } catch { /* ignore */ }
                throw new Error(`Server returned ${response.status}${serverError}`);
            }

            const contentType = response.headers.get('Content-Type') || '';
            if (contentType.includes('text/html')) {
                throw new Error('API endpoint not available. Run the app with `npx wrangler dev` to enable cloud sync.');
            }

            const data = await response.json() as { ok: boolean; items: unknown[]; hasMore: boolean; nextSince: number; nextSinceId: string };
            if (!data.ok) throw new Error('Pull endpoint returned ok: false');
            return { items: data.items, hasMore: data.hasMore, nextSince: data.nextSince, nextSinceId: data.nextSinceId };
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt < PULL_MAX_RETRIES - 1) {
                await new Promise(r => setTimeout(r, PULL_RETRY_DELAY_MS * (attempt + 1)));
            }
        }
    }

    throw lastError ?? new Error('Pull failed after retries');
}

/**
 * Main pull orchestrator: checks remote D1 for new messages and posts
 * that aren't in the local IndexedDB, and downloads them.
 *
 * Fire-and-forget — progress is communicated via onPullProgress.
 */
export async function pullNewItems(): Promise<{ success: boolean; inserted: number; error?: string; pulledMsgExternalIds: Set<string>; pulledPostExternalIds: Set<string>; remoteMsgCount: number; remotePostCount: number }> {
    const generation = ++pullGeneration;

    const pulledMsgExternalIds = new Set<string>();
    const pulledPostExternalIds = new Set<string>();

    // Check auth
    const authHeaders = getAuthHeaders();
    if (!authHeaders.Authorization) {
        currentPullState = { phase: 'skipped_offline', totalItems: 0, pulledItems: 0, insertedLocal: 0 };
        notifyPullListeners();
        return { success: false, inserted: 0, error: 'Not authenticated', pulledMsgExternalIds, pulledPostExternalIds, remoteMsgCount: 0, remotePostCount: 0 };
    }

    currentPullState = { phase: 'checking', totalItems: 0, pulledItems: 0, insertedLocal: 0 };
    notifyPullListeners();

    try {
        // Use last pull timestamp (not max message timestamp — those are send times, not upload times).
        // On first run this is 0, pulling everything. Subsequent runs only pull items uploaded since last check.
        let lastPullAt = getLastPullAt();

        // Snapshot local counts for drift detection below
        const [localMsgCount, localPostCount] = await Promise.all([
            getMessagesCount(TARGET_CHAT_ID),
            getPostsCount(),
        ]);

        // If local store is empty but we have a non-zero pull cursor, reset it.
        // This handles the case where IndexedDB was wiped but localStorage still
        // holds a stale lastPullAt timestamp — without this, the pull would skip
        // all previously-uploaded items and return empty.
        if (lastPullAt > 0 && localMsgCount === 0 && localPostCount === 0) {
            console.log('[pullNewItems] Local store is empty, resetting pull cursor from', lastPullAt, 'to 0');
            setLastPullAt(0);
            lastPullAt = 0;
        }

        // Self-healing drift check: if a previous pull was incomplete (e.g. due to
        // the old pagination bug), the cursor may be past items that never made it
        // to the local store. Compare remote counts and reset if remote has more.
        // Only run when the cursor is at least 30 seconds old — on a fresh page
        // refresh right after a successful sync, the cursor is trustworthy.
        let remoteMsgCount = 0;
        let remotePostCount = 0;
        const CURSOR_STALE_MS = 30_000;
        if (lastPullAt > 0 && (Date.now() - lastPullAt) > CURSOR_STALE_MS) {
            try {
                const authHeaders = getAuthHeaders();
                if (authHeaders.Authorization) {
                    const countsUrl = `/api/sync/counts?chatId=${encodeURIComponent(TARGET_CHAT_ID)}`;
                    const resp = await fetch(countsUrl, { headers: authHeaders });
                    if (resp.ok) {
                        const contentType = resp.headers.get('Content-Type') || '';
                        if (!contentType.includes('text/html')) {
                            const counts = await resp.json() as { ok: boolean; messages: number; posts: number };
                            remoteMsgCount = counts.messages;
                            remotePostCount = counts.posts;
                            if (counts.ok && (counts.messages > localMsgCount || counts.posts > localPostCount)) {
                                console.log('[pullNewItems] Drift detected — remote:', counts.messages, 'local:', localMsgCount, '(msg) remote:', counts.posts, 'local:', localPostCount, '(posts) — resetting pull cursor');
                                setLastPullAt(0);
                                lastPullAt = 0;
                            }
                        }
                    }
                }
            } catch {
                // Best-effort; proceed with existing cursor if count check fails
            }
        } else if (lastPullAt > 0) {
            // Cursor is fresh (recent sync). Skip the drift check entirely
            // to save one HTTP request. The push guard in syncAll() will use
            // localChangedAt to decide whether a push is needed.
        }

        const pullCutoff = Date.now();

        currentPullState.phase = 'downloading';
        notifyPullListeners();

        let totalInserted = 0;
        let totalPulledMsgs = 0;
        let totalPulledPosts = 0;

        // ── Pull messages ──
        let since = lastPullAt;
        let sinceId = '';
        let hasMore = true;
        while (hasMore) {
            if (generation !== pullGeneration) {
                return { success: false, inserted: totalInserted, error: 'Pull superseded', pulledMsgExternalIds, pulledPostExternalIds, remoteMsgCount, remotePostCount };
            }

            const url = `/api/sync/pull?entity=messages&since=${since}&sinceId=${encodeURIComponent(sinceId)}&chatId=${encodeURIComponent(TARGET_CHAT_ID)}&limit=${PULL_BATCH_SIZE}`;
            const batch = await pullBatch(url, generation);

            if (batch.items.length > 0) {
                // D1 stores timestamps as epoch ms numbers; convert to Date for importMessages
                const normalizedItems = batch.items.map(item => {
                    const record = item as Record<string, unknown>;
                    if (typeof record.timestamp === 'number') {
                        record.timestamp = new Date(record.timestamp);
                    }
                    return record;
                });
                // Collect externalIds of pulled items so the caller can skip
                // redundant push checks for items that just came from remote.
                for (const item of normalizedItems) {
                    const extId = (item as Record<string, unknown>).externalId;
                    if (typeof extId === 'string' && extId) pulledMsgExternalIds.add(extId);
                }
                const stats = await importMessages(normalizedItems as unknown as Parameters<typeof importMessages>[0]);
                if (stats.inserted !== batch.items.length) {
                    const dedupedInBatch = batch.items.length - stats.inserted;
                    console.warn('[pullNewItems] Batch dedup:', dedupedInBatch, 'of', batch.items.length,
                        'items already existed locally (inserted', stats.inserted, 'updated', stats.updated + ')',
                        '— duplicate externalIds on server?');
                    if (stats.insertedIds && stats.insertedIds.length > 0) {
                        console.log('[pullNewItems] Inserted IDs:', stats.insertedIds.slice(0, 10), '... count:', stats.insertedIds.length);
                        console.log('[pullNewItems] Inserted externalIds:', stats.insertedExternalIds?.slice(0, 10));
                    }
                }
                totalInserted += stats.inserted;
                totalPulledMsgs += batch.items.length;
                currentPullState.pulledItems = totalPulledMsgs + totalPulledPosts;
                currentPullState.insertedLocal = totalInserted;
                notifyPullListeners();
            }

            since = batch.nextSince;
            sinceId = batch.nextSinceId;
            hasMore = batch.hasMore;
        }

        // ── Pull posts ──
        since = lastPullAt;
        sinceId = '';
        hasMore = true;
        while (hasMore) {
            if (generation !== pullGeneration) {
                return { success: false, inserted: totalInserted, error: 'Pull superseded', pulledMsgExternalIds, pulledPostExternalIds, remoteMsgCount, remotePostCount };
            }

            const url = `/api/sync/pull?entity=posts&since=${since}&sinceId=${encodeURIComponent(sinceId)}&limit=${PULL_BATCH_SIZE}`;
            const batch = await pullBatch(url, generation);

            if (batch.items.length > 0) {
                // D1 stores timestamps as epoch ms numbers; ensure they stay as numbers for importPosts
                const normalizedItems = batch.items.map(item => {
                    const record = item as Record<string, unknown>;
                    if (typeof record.timestamp !== 'number' && record.timestamp != null) {
                        record.timestamp = new Date(record.timestamp as string).getTime();
                    }
                    return record;
                });
                for (const item of normalizedItems) {
                    const extId = (item as Record<string, unknown>).externalId;
                    if (typeof extId === 'string' && extId) pulledPostExternalIds.add(extId);
                }
                const stats = await importPosts(normalizedItems as unknown as Parameters<typeof importPosts>[0]);
                totalInserted += stats.inserted;
                totalPulledPosts += batch.items.length;
                currentPullState.pulledItems = totalPulledMsgs + totalPulledPosts;
                currentPullState.insertedLocal = totalInserted;
                notifyPullListeners();
            }

            since = batch.nextSince;
            sinceId = batch.nextSinceId;
            hasMore = batch.hasMore;
        }

        // Record this pull's cutoff so next pull only gets newer items
        setLastPullAt(pullCutoff);

        // Diagnostic: always report the basic counts (fast index-based queries).
        const [postPullMsgCount, postPullPostCount] = await Promise.all([
            getMessagesCount(TARGET_CHAT_ID),
            getPostsCount(),
        ]);
        const dedupedCount = (totalPulledMsgs + totalPulledPosts) - totalInserted;
        console.log('[pullNewItems] Pull complete. Pulled msgs:', totalPulledMsgs, 'posts:', totalPulledPosts,
            '| Local msgs before:', localMsgCount, 'after:', postPullMsgCount,
            '| Local posts before:', localPostCount, 'after:', postPullPostCount,
            '| Remote msgs:', remoteMsgCount, 'posts:', remotePostCount,
            '| Inserted:', totalInserted, 'deduped (already local):', dedupedCount);

        // Full diagnostics (expensive IndexedDB cursor scans + dedup) only when
        // items were actually inserted. On a no-op page refresh this is skipped.
        if (totalInserted > 0) {
            const [totalMsgCount, manualC1Count, localUniqueExtIds] = await Promise.all([
                getTotalMessagesCount(),
                countMessagesWithChatId(TARGET_CHAT_ID),
                countUniqueExternalIds(),
            ]);
            const localDupCount = postPullMsgCount - localUniqueExtIds;
            console.log('[pullNewItems] Local unique extIds:', localUniqueExtIds, 'local duplicates:', localDupCount,
                '| Msg drift after pull:', remoteMsgCount - postPullMsgCount,
                '| Total msgs in store:', totalMsgCount, 'manual c1 count:', manualC1Count);

            if (dedupedCount > 0) {
                console.warn('[pullNewItems] WARNING:', dedupedCount, 'items were pulled from remote but NOT inserted (already local by externalId).',
                    'This indicates duplicate externalId values on the server.',
                    'Run migration 0007 to extract external_id column with UNIQUE constraint.');
            }

            if (localDupCount > 0) {
                console.warn('[pullNewItems] Auto-cleaning', localDupCount, 'local duplicate messages...');
                const removed = await deduplicateLocalMessages(TARGET_CHAT_ID);
                const afterDedupCount = await getMessagesCount(TARGET_CHAT_ID);
                console.log('[pullNewItems] Removed', removed, 'local duplicates. Local count:', afterDedupCount,
                    '(was', postPullMsgCount, 'remote:', remoteMsgCount, 'drift:', remoteMsgCount - afterDedupCount, ')');
            }
        }

        currentPullState.phase = 'done';
        notifyPullListeners();

        return { success: true, inserted: totalInserted, pulledMsgExternalIds, pulledPostExternalIds, remoteMsgCount, remotePostCount };
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown pull error';

        // Don't overwrite state if superseded
        if (errorMsg === 'Pull superseded') {
            return { success: false, inserted: currentPullState.insertedLocal, error: errorMsg, pulledMsgExternalIds, pulledPostExternalIds, remoteMsgCount: 0, remotePostCount: 0 };
        }

        const isOffline =
            errorMsg.includes('Failed to fetch') ||
            errorMsg.includes('NetworkError');

        currentPullState.phase = isOffline ? 'skipped_offline' : 'error';
        currentPullState.error = errorMsg;
        notifyPullListeners();

        return { success: false, inserted: currentPullState.insertedLocal, error: errorMsg, pulledMsgExternalIds, pulledPostExternalIds, remoteMsgCount: 0, remotePostCount: 0 };
    }
}

/**
 * Sync bookmarks bidirectionally: pull from server, merge with local, then push.
 * Bookmarks are a small dataset (one row per chat) — full-set replacement on both sides.
 */
async function syncBookmarks(): Promise<void> {
  try {
    const authHeaders = getAuthHeaders();
    if (!authHeaders.Authorization) {
      console.log('[syncBookmarks] Not authenticated, skipping');
      return;
    }

    // ── 1. Pull bookmarks from server ──
    // Always use since=0 — bookmarks are a tiny dataset (one row per chat),
    // and using the shared lastPullAt would race with pullNewItems() which
    // updates it before we run, causing us to miss bookmarks uploaded earlier.
    let pulledBookmarks: Array<{ chatId: string; messageId: string }> = [];
    try {
      const url = '/api/sync/bookmarks/pull?since=0';
      const resp = await fetch(url, { headers: authHeaders });

      if (resp.ok) {
        const contentType = resp.headers.get('Content-Type') || '';
        if (!contentType.includes('text/html')) {
          const data = await resp.json() as { ok: boolean; bookmarks: Array<{ chatId: string; messageId: string }> };
          if (data.ok && data.bookmarks.length > 0) {
            pulledBookmarks = data.bookmarks;
            console.log('[syncBookmarks] Pulled', pulledBookmarks.length, 'bookmarks from server');

            // Merge server bookmarks with local: union of both sets.
            // Server bookmarks take precedence if both have the same chatId.
            const localBookmarks = await getAllBookmarks();
            const merged = new Map<string, string>();
            for (const bm of localBookmarks) {
              merged.set(bm.chatId, bm.messageId);
            }
            for (const bm of pulledBookmarks) {
              merged.set(bm.chatId, bm.messageId);
            }
            const mergedList = Array.from(merged.entries()).map(([chatId, messageId]) => ({ chatId, messageId }));
            await importBookmarks(mergedList);
            console.log('[syncBookmarks] Merged', mergedList.length, 'bookmarks locally');
          }
        }
      } else {
        console.warn('[syncBookmarks] Pull failed:', resp.status);
      }
    } catch (err) {
      console.warn('[syncBookmarks] Pull error:', err);
    }

    // ── 2. Push local bookmarks to server ──
    // Always push — bookmarks are tiny (one record per chat). No gating needed;
    // re-uploading the same set is a harmless no-op on the server.
    try {
      const localBookmarks = await getAllBookmarks();
      const headers: Record<string, string> = {
        ...authHeaders,
        'Content-Type': 'application/json',
      };

      const resp = await fetch('/api/sync/bookmarks/upload', {
        method: 'POST',
        headers,
        body: JSON.stringify({ bookmarks: localBookmarks }),
      });

      if (!resp.ok) {
        console.warn('[syncBookmarks] Upload failed:', resp.status);
      } else {
        const data = await resp.json() as { ok: boolean; count: number };
        if (data.ok) {
          console.log('[syncBookmarks] Uploaded', data.count, 'bookmarks to server');
        }
      }
    } catch (err) {
      console.warn('[syncBookmarks] Upload error:', err);
    }
  } catch (err) {
    console.error('[syncBookmarks] Unexpected error:', err);
  }
}

/**
 * Bidirectional sync: push local items to remote, then pull new remote items.
 * Called at app load to reconcile local IndexedDB with remote D1.
 *
 * Push: gathers all local messages/posts and uploads those not already on the server.
 * Pull: downloads items uploaded from other devices since the last pull.
 *
 * Best-effort — push failures don't block pull, and vice versa.
 */
export async function syncAll(): Promise<void> {
    // ── 1. Pull remote → local (download new items first) ──
    let pulledMsgIds = new Set<string>();
    let pulledPostIds = new Set<string>();
    let remoteMsgCount = 0;
    let remotePostCount = 0;

    try {
        console.log('[syncAll] Pulling new items from remote');
        const result = await pullNewItems();
        pulledMsgIds = result.pulledMsgExternalIds;
        pulledPostIds = result.pulledPostExternalIds;
        remoteMsgCount = result.remoteMsgCount;
        remotePostCount = result.remotePostCount;
    } catch (err) {
        console.error('[syncAll] Pull failed:', err);
    }

    // ── 1b. Sync bookmarks ──
    try {
      console.log('[syncAll] Syncing bookmarks');
      await syncBookmarks();
    } catch (err) {
      console.error('[syncAll] Bookmark sync failed:', err);
    }

    // ── 2. Push local → remote (only if local data changed since last push) ──
    const lastPushAt = getLastPushAt();
    const localChangedAt = getLocalChangedAt();

    // Determine if there are local items not yet on the server.
    // When pullNewItems() returned items, use exact set subtraction (pulledMsgIds).
    // When it returned 0 items (common case on page refresh), pulledMsgIds is
    // empty — fall back to comparing local vs remote counts.
    // When remote count is also unknown (first sync or fresh cursor), use
    // localChangedAt as a heuristic: if nothing changed locally, assume parity.
    const [localMsgTotal, localPostTotal] = await Promise.all([
        getMessagesCount(TARGET_CHAT_ID),
        getPostsCount(),
    ]);

    let unpulledMsgCount: number;
    let unpulledPostCount: number;
    if (pulledMsgIds.size > 0 || pulledPostIds.size > 0) {
        // Pull returned items — use exact set subtraction
        unpulledMsgCount = Math.max(0, localMsgTotal - pulledMsgIds.size);
        unpulledPostCount = Math.max(0, localPostTotal - pulledPostIds.size);
    } else if (remoteMsgCount > 0 || remotePostCount > 0) {
        // Pull returned nothing but we have remote counts (drift check ran)
        unpulledMsgCount = Math.max(0, localMsgTotal - remoteMsgCount);
        unpulledPostCount = Math.max(0, localPostTotal - remotePostCount);
    } else {
        // Remote count unknown (first sync with lastPullAt=0, or fresh cursor).
        // If nothing changed locally since last push, assume we're in sync.
        // If local data changed (e.g., import where syncNewItems was called
        // directly), run the push to be safe.
        unpulledMsgCount = (localChangedAt > lastPushAt) ? localMsgTotal : 0;
        unpulledPostCount = (localChangedAt > lastPushAt) ? localPostTotal : 0;
    }
    const hasUnpushedItems = unpulledMsgCount > 0 || unpulledPostCount > 0;

    if (!hasUnpushedItems) {
        // All local items are confirmed on remote (or assumed in sync).
        console.log('[syncAll] All local items confirmed on remote, skipping push phase');
        if (localChangedAt > lastPushAt) {
            // Local changes were already uploaded by a direct syncNewItems()
            // call (e.g., from ImportPage). Record the timestamp so future
            // refreshes skip the count checks.
            setLastPushAt(Date.now());
        }
        return;
    }

    console.log('[syncAll] Unpushed items detected — msgs:', unpulledMsgCount, 'posts:', unpulledPostCount,
        '(local msgs:', localMsgTotal, 'remote msgs:', remoteMsgCount, 'pulled:', pulledMsgIds.size, ')');

    // Check if the "unpushed" items are actually local duplicates
    // (same externalId, different id) rather than genuinely new items.
    // This can happen when the server was deduplicated (migration 0007)
    // but the local IndexedDB still has legacy duplicate rows.
    if (unpulledMsgCount > 0) {
        const uniqueExtIds = await countUniqueExternalIds();
        const localDupCount = localMsgTotal - uniqueExtIds;
        if (localDupCount > 0 && localDupCount >= unpulledMsgCount) {
            console.log('[syncAll] Local duplicates detected:', localDupCount,
                '— cleaning up local IndexedDB instead of uploading');
            const removed = await deduplicateLocalMessages(TARGET_CHAT_ID);
            console.log('[syncAll] Removed', removed, 'local duplicate messages');

            // Recompute local count after dedup
            const newLocalTotal = await getMessagesCount(TARGET_CHAT_ID);
            if (newLocalTotal <= remoteMsgCount) {
                console.log('[syncAll] Local duplicates cleaned up, skipping push');
                setLastPushAt(Date.now());
                return;
            }
        }
    }

    // Items pulled from remote definitely exist there — skip redundant /exist checks.
    let pushSucceeded = true;
    try {
        const msgCount = await getMessagesCount(TARGET_CHAT_ID);
        if (msgCount > 0) {
            const allMessages: Array<{ id: string; externalId?: string; [key: string]: unknown }> = [];
            const PAGE = 500;
            for (let offset = 0; offset < msgCount; offset += PAGE) {
                const batch = await getMessagesPaginated(TARGET_CHAT_ID, PAGE, offset);
                allMessages.push(...(batch as unknown as Array<{ id: string; externalId?: string; [key: string]: unknown }>));
            }
            // Filter: keep items without externalId (always push), or whose
            // externalId was NOT just pulled from remote (might need upload).
            const toPush = allMessages.filter(m => !m.externalId || !pulledMsgIds.has(m.externalId));
            if (toPush.length > 0) {
                console.log('[syncAll] Pushing', toPush.length, 'local messages (skipped', allMessages.length - toPush.length, 'already on remote)');
                const result = await syncNewItems('messages', toPush);
                if (!result.success && result.error !== 'Sync superseded') {
                    pushSucceeded = false;
                }
            } else {
                console.log('[syncAll] All', allMessages.length, 'local messages already on remote, skipping push');
            }
        }
    } catch (err) {
        console.error('[syncAll] Push messages failed:', err);
        pushSucceeded = false;
    }

    try {
        const allPosts = await getPosts();
        if (allPosts.length > 0) {
            const toPush = allPosts.filter(p => !p.externalId || !pulledPostIds.has(p.externalId));
            if (toPush.length > 0) {
                console.log('[syncAll] Pushing', toPush.length, 'local posts (skipped', allPosts.length - toPush.length, 'already on remote)');
                const result = await syncNewItems('posts', toPush as unknown as Array<{ id: string; externalId?: string; [key: string]: unknown }>);
                if (!result.success && result.error !== 'Sync superseded') {
                    pushSucceeded = false;
                }
            } else {
                console.log('[syncAll] All', allPosts.length, 'local posts already on remote, skipping push');
            }
        }
    } catch (err) {
        console.error('[syncAll] Push posts failed:', err);
        pushSucceeded = false;
    }

    // Record successful push so future reloads can skip redundant checks
    if (pushSucceeded) {
        setLastPushAt(Date.now());
    }
}
