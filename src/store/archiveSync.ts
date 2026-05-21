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
    messages: SerializedMessage[];
    posts: SerializedPost[];
}

interface SyncResponse extends SyncPayload {
    ok: boolean;
    schemaReady?: boolean;
}

const SYNC_ENDPOINT = '/api/sync';
const PAGE_SIZE = 250;

const serializeMessage = (message: Message): SerializedMessage => ({
    ...message,
    timestamp: message.timestamp.toISOString(),
    attachments: message.attachments?.map((attachment) => {
        const next = { ...attachment };
        delete next.file;
        return next;
    }),
});

const deserializeMessage = (message: SerializedMessage): Message => ({
    ...message,
    timestamp: new Date(message.timestamp),
    attachments: message.attachments?.map((attachment) => ({ ...attachment })),
});

const serializePost = (post: PostRecord): SerializedPost => ({
    ...post,
    media: post.media?.map((media) => {
        const next = { ...media };
        delete next.file;
        return next;
    }),
});

const deserializePost = (post: SerializedPost): PostRecord => ({
    ...post,
    media: post.media?.map((media) => ({ ...media })),
});

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

    const response = await fetch(SYNC_ENDPOINT, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            messages: messages.map(serializeMessage),
            posts: posts.map(serializePost),
        } satisfies SyncPayload),
    });

    if (!response.ok) {
        throw new Error(`Failed to push archive to server (${response.status})`);
    }
}

export async function hydrateLocalArchiveFromServer(): Promise<boolean> {
    const response = await fetch(SYNC_ENDPOINT, {
        method: 'GET',
        cache: 'no-store',
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch archive from server (${response.status})`);
    }

    const payload = (await response.json()) as SyncResponse;
    const messages = payload.messages?.map(deserializeMessage) ?? [];
    const posts = payload.posts?.map(deserializePost) ?? [];

    if (messages.length === 0 && posts.length === 0) {
        return false;
    }

    if (messages.length > 0) {
        await importMessages(messages);
    }

    if (posts.length > 0) {
        await importPosts(posts);
    }

    return true;
}
