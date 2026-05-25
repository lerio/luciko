import { getMessagesCount, getMessagesPaginated, getPostsCount, getPostsPaginated, importMessages, importPosts, getAllBookmarks, importBookmarks } from './db';
import { TARGET_CHAT_ID } from '../constants/chat';
import type { Message } from '../types/chat';
import type { PostRecord } from '../types/posts';

type SerializedAttachment = Omit<NonNullable<Message['attachments']>[number], 'file'>;
type SerializedMedia = Omit<NonNullable<PostRecord['media']>[number], 'file'>;

type SerializedMessage = Omit<Message, 'timestamp' | 'attachments'> & {
    timestamp: string;
    attachments?: SerializedAttachment[];
};

type SerializedPost = Omit<PostRecord, 'media'> & {
    media?: SerializedMedia[];
};

interface SyncResponse {
    ok: boolean;
    schemaReady?: boolean;
    entity?: 'messages' | 'posts' | 'bookmarks';
    offset?: number;
    limit?: number;
    total?: number;
    items?: unknown[];
}

type SyncEntity = 'messages' | 'posts' | 'bookmarks';

interface SyncDiffResponse extends SyncResponse {
    chunks?: number[];
}

const SYNC_ENDPOINT = '/api/sync';
const PAGE_SIZE = 500;

export type PushProgress = {
    entity: 'messages' | 'posts' | 'bookmarks';
    uploaded: number;
    total: number;
    resumedFrom: number;
};

const serializeMessage = (message: Message): SerializedMessage => ({
    ...message,
    timestamp: message.timestamp.toISOString(),
    attachments: message.attachments?.map((attachment) => {
        const next = { ...attachment };
        delete next.file;
        return next;
    }),
});

const deserializeMessage = (message: unknown): Message => {
    const next = message as SerializedMessage;
    return {
        ...next,
        timestamp: new Date(next.timestamp),
        attachments: next.attachments?.map((attachment) => ({ ...attachment })),
    };
};

const serializePost = (post: PostRecord): SerializedPost => ({
    ...post,
    media: post.media?.map((media) => {
        const next = { ...media };
        delete next.file;
        return next;
    }),
});

const deserializePost = (post: unknown): PostRecord => {
    const next = post as SerializedPost;
    return {
        ...next,
        media: next.media?.map((media) => ({ ...media })),
    };
};

async function hashText(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function postChunk(entity: SyncEntity, chunkIndex: number, items: unknown[]): Promise<void> {
    const response = await fetch(`${SYNC_ENDPOINT}/chunk`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            entity,
            chunkIndex,
            items,
        }),
    });

    if (!response.ok) {
        const details = await response.text().catch(() => '');
        throw new Error(`Failed to push archive to server (${response.status})${details ? `: ${details}` : ''}`);
    }
}

async function getServerEntityTotal(entity: SyncEntity): Promise<number> {
    const response = await fetch(`${SYNC_ENDPOINT}?entity=${entity}&limit=1&offset=0`, {
        method: 'GET',
        cache: 'no-store',
    });

    if (!response.ok) {
        const details = await response.text().catch(() => '');
        throw new Error(`Failed to inspect server sync state (${response.status})${details ? `: ${details}` : ''}`);
    }

    const payload = (await response.json()) as SyncResponse;
    return payload.total ?? 0;
}

async function getChangedChunks(
    entity: SyncEntity,
    chunks: Array<{ chunkIndex: number; payload: string }>
): Promise<Set<number>> {
    if (chunks.length === 0) {
        return new Set();
    }

    const response = await fetch(`${SYNC_ENDPOINT}/diff`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            entity,
            chunks: await Promise.all(chunks.map(async (chunk) => ({
                chunkIndex: chunk.chunkIndex,
                hash: await hashText(chunk.payload),
            }))),
        }),
    });

    if (!response.ok) {
        const details = await response.text().catch(() => '');
        throw new Error(`Failed to inspect server sync state (${response.status})${details ? `: ${details}` : ''}`);
    }

    const payload = (await response.json()) as SyncDiffResponse;
    return new Set(payload.chunks ?? []);
}

type BookmarkRecord = { chatId: string; messageId: string };

export async function pushBookmarksToServer(): Promise<void> {
    const bookmarks = await getAllBookmarks();
    const payload = JSON.stringify(bookmarks);
    const changed = await getChangedChunks('bookmarks', [{ chunkIndex: 0, payload }]);

    if (changed.has(0)) {
        await postChunk('bookmarks', 0, bookmarks);
    }
}

export async function pullBookmarksFromServer(): Promise<boolean> {
    const response = await fetch(`${SYNC_ENDPOINT}?entity=bookmarks&limit=1000&offset=0`, {
        method: 'GET',
        cache: 'no-store',
    });

    if (!response.ok) {
        const details = await response.text().catch(() => '');
        throw new Error(`Failed to fetch bookmarks from server (${response.status})${details ? `: ${details}` : ''}`);
    }

    const payload = (await response.json()) as SyncResponse;
    const items = (payload.items ?? []) as BookmarkRecord[];

    if (items.length > 0) {
        await importBookmarks(items);
        return true;
    }
    return false;
}

export async function pushLocalArchiveToServer(onProgress?: (progress: PushProgress) => void): Promise<void> {
    const messageTotal = await getMessagesCount(TARGET_CHAT_ID);
    let uploadedMessages = Math.min(await getServerEntityTotal('messages'), messageTotal);

    if (uploadedMessages > 0) {
        onProgress?.({
            entity: 'messages',
            uploaded: uploadedMessages,
            total: messageTotal,
            resumedFrom: uploadedMessages,
        });
    }

    const messageChunks: Array<{ chunkIndex: number; payload: string; items: SerializedMessage[] }> = [];
    for (let offset = 0; offset < messageTotal; offset += PAGE_SIZE) {
        const messages = await getMessagesPaginated(TARGET_CHAT_ID, PAGE_SIZE, offset);
        const serialized = messages.map(serializeMessage);
        messageChunks.push({
            chunkIndex: Math.floor(offset / PAGE_SIZE),
            payload: JSON.stringify(serialized),
            items: serialized,
        });
    }

    const changedMessageChunks = await getChangedChunks('messages', messageChunks);

    for (const chunk of messageChunks) {
        if (changedMessageChunks.has(chunk.chunkIndex)) {
            await postChunk('messages', chunk.chunkIndex, chunk.items);
            uploadedMessages = Math.min(messageTotal, uploadedMessages + chunk.items.length);
        }
        onProgress?.({
            entity: 'messages',
            uploaded: Math.min(uploadedMessages, messageTotal),
            total: messageTotal,
            resumedFrom: 0,
        });
    }

    const postTotal = await getPostsCount();
    let uploadedPosts = Math.min(await getServerEntityTotal('posts'), postTotal);

    if (uploadedPosts > 0) {
        onProgress?.({
            entity: 'posts',
            uploaded: uploadedPosts,
            total: postTotal,
            resumedFrom: uploadedPosts,
        });
    }

    const postChunks: Array<{ chunkIndex: number; payload: string; items: SerializedPost[] }> = [];
    for (let offset = 0; offset < postTotal; offset += PAGE_SIZE) {
        const posts = await getPostsPaginated(PAGE_SIZE, offset);
        const serialized = posts.map(serializePost);
        postChunks.push({
            chunkIndex: Math.floor(offset / PAGE_SIZE),
            payload: JSON.stringify(serialized),
            items: serialized,
        });
    }

    const changedPostChunks = await getChangedChunks('posts', postChunks);

    for (const chunk of postChunks) {
        if (changedPostChunks.has(chunk.chunkIndex)) {
            await postChunk('posts', chunk.chunkIndex, chunk.items);
            uploadedPosts = Math.min(postTotal, uploadedPosts + chunk.items.length);
        }
        onProgress?.({
            entity: 'posts',
            uploaded: Math.min(uploadedPosts, postTotal),
            total: postTotal,
            resumedFrom: 0,
        });
    }
}

const SYNC_PROGRESS_PREFIX = 'luciko_sync_';

function getSyncCheckpoint(entity: string): number {
    try {
        return Number(localStorage.getItem(`${SYNC_PROGRESS_PREFIX}${entity}`)) || 0;
    } catch {
        return 0;
    }
}

function setSyncCheckpoint(entity: string, offset: number): void {
    try {
        localStorage.setItem(`${SYNC_PROGRESS_PREFIX}${entity}`, String(offset));
    } catch {
        // localStorage may be unavailable; silently skip
    }
}

function clearSyncCheckpoint(entity: string): void {
    try {
        localStorage.removeItem(`${SYNC_PROGRESS_PREFIX}${entity}`);
    } catch {
        // silently skip
    }
}

export async function hydrateLocalArchiveFromServer(): Promise<boolean> {
    const loadEntity = async <T>(
        entity: SyncEntity,
        deserialize: (item: unknown) => T,
        importer: (items: T[]) => Promise<void>
    ) => {
        let offset = getSyncCheckpoint(entity);
        let total = Number.POSITIVE_INFINITY;

        while (offset < total) {
            const response = await fetch(`${SYNC_ENDPOINT}?entity=${entity}&limit=${PAGE_SIZE}&offset=${offset}`, {
                method: 'GET',
                cache: 'no-store',
            });

            if (!response.ok) {
                const details = await response.text().catch(() => '');
                throw new Error(`Failed to fetch archive from server (${response.status})${details ? `: ${details}` : ''}`);
            }

            const payload = (await response.json()) as SyncResponse;
            const items = (payload.items ?? []).map(deserialize);
            total = payload.total ?? items.length;
            if (items.length === 0) {
                break;
            }
            await importer(items);
            offset += items.length;
            setSyncCheckpoint(entity, offset);
            if (items.length < PAGE_SIZE) {
                break;
            }
        }

        clearSyncCheckpoint(entity);
    };

    let importedMessages = false;
    let importedPosts = false;

    await Promise.all([
        loadEntity('messages', deserializeMessage, async (items) => {
            if (items.length > 0) {
                importedMessages = true;
                await importMessages(items as Message[]);
            }
        }),
        loadEntity('posts', deserializePost, async (items) => {
            if (items.length > 0) {
                importedPosts = true;
                await importPosts(items as PostRecord[]);
            }
        }),
    ]);

    return importedMessages || importedPosts;
}
