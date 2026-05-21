import { getMessagesCount, getMessagesPaginated, getPosts, importMessages, importPosts } from './db';
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

interface SyncPayload {
    messages?: SerializedMessage[];
    posts?: SerializedPost[];
}

interface SyncResponse {
    ok: boolean;
    schemaReady?: boolean;
    entity?: 'messages' | 'posts';
    offset?: number;
    limit?: number;
    total?: number;
    items?: unknown[];
}

const SYNC_ENDPOINT = '/api/sync';
const PAGE_SIZE = 50;

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

async function readAllMessages(chatId: string): Promise<Message[]> {
    const total = await getMessagesCount(chatId);
    const messages: Message[] = [];
    for (let offset = 0; offset < total; offset += PAGE_SIZE) {
        const batch = await getMessagesPaginated(chatId, PAGE_SIZE, offset);
        messages.push(...batch);
    }
    return messages;
}

export async function pushLocalArchiveToServer(): Promise<void> {
    const [messages, posts] = await Promise.all([
        readAllMessages(TARGET_CHAT_ID),
        getPosts(),
    ]);

    if (messages.length === 0 && posts.length === 0) {
        return;
    }

    for (let offset = 0; offset < messages.length; offset += PAGE_SIZE) {
        const response = await fetch(SYNC_ENDPOINT, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                messages: messages.slice(offset, offset + PAGE_SIZE).map(serializeMessage),
            } satisfies SyncPayload),
        });

        if (!response.ok) {
            const details = await response.text().catch(() => '');
            throw new Error(`Failed to push archive to server (${response.status})${details ? `: ${details}` : ''}`);
        }
    }

    for (let offset = 0; offset < posts.length; offset += PAGE_SIZE) {
        const response = await fetch(SYNC_ENDPOINT, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                posts: posts.slice(offset, offset + PAGE_SIZE).map(serializePost),
            } satisfies SyncPayload),
        });

        if (!response.ok) {
            const details = await response.text().catch(() => '');
            throw new Error(`Failed to push archive to server (${response.status})${details ? `: ${details}` : ''}`);
        }
    }
}

export async function hydrateLocalArchiveFromServer(): Promise<boolean> {
    const loadEntity = async <T>(
        entity: 'messages' | 'posts',
        deserialize: (item: unknown) => T,
        importer: (items: T[]) => Promise<void>
    ) => {
        let offset = 0;
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
            if (items.length < PAGE_SIZE) {
                break;
            }
        }
    };

    let imported = false;

    await loadEntity('messages', deserializeMessage, async (items) => {
        if (items.length > 0) {
            imported = true;
            await importMessages(items as Message[]);
        }
    });

    await loadEntity('posts', deserializePost, async (items) => {
        if (items.length > 0) {
            imported = true;
            await importPosts(items as PostRecord[]);
        }
    });

    return imported;
}
