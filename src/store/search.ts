import { initDB } from './db';
import { normalizeMojibakeText } from '../utils/text';
import type { Message } from '../types/chat';
import type { PostRecord } from '../types/posts';

export interface MessageSearchResult {
    message: Message;
    score: number;
    excerpt: string;
}

export interface PostSearchResult {
    post: PostRecord;
    score: number;
    excerpt: string;
}

const stripDiacritics = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const normalizeSearchText = (value?: string | null): string => {
    if (!value) return '';
    const normalized = normalizeMojibakeText(value) ?? value;
    return stripDiacritics(normalized.toLowerCase()).replace(/\s+/g, ' ').trim();
};

const tokenizeQuery = (query: string): string[] =>
    normalizeSearchText(query)
        .split(/[^a-z0-9]+/i)
        .map((part) => part.trim())
        .filter(Boolean);

const buildSnippet = (source: string, tokens: string[]): string => {
    const normalizedSource = normalizeSearchText(source);
    if (!normalizedSource) return '';

    let matchIndex = Number.POSITIVE_INFINITY;
    for (const token of tokens) {
        const nextIndex = normalizedSource.indexOf(token);
        if (nextIndex >= 0 && nextIndex < matchIndex) {
            matchIndex = nextIndex;
        }
    }

    if (!Number.isFinite(matchIndex)) {
        return source.slice(0, 180);
    }

    const start = Math.max(0, matchIndex - 48);
    return source.slice(start, start + 180);
};

const scoreMatch = (haystack: string, tokens: string[], normalizedQuery: string): number => {
    if (!tokens.length || !haystack) return 0;

    let score = 0;
    let matchedTokens = 0;
    for (const token of tokens) {
        if (haystack.includes(token)) {
            matchedTokens += 1;
            score += 10;
        }
    }

    if (matchedTokens === 0) return 0;
    if (matchedTokens === tokens.length) {
        score += 25;
    }
    if (normalizedQuery && haystack.includes(normalizedQuery)) {
        score += 35;
    }

    return score;
};

const buildMessageHaystack = (message: Message): string => {
    const attachmentNames = message.attachments?.map((attachment) => attachment.fileName).join(' ') ?? '';
    return normalizeSearchText(
        [
            message.senderId,
            message.content,
            message.quotedText,
            message.quotedSender,
            attachmentNames,
            message.source,
            message.externalId,
        ]
            .filter(Boolean)
            .join(' ')
    );
};

const buildPostHaystack = (post: PostRecord): string => {
    const mediaNames = post.media?.map((media) => media.fileName).join(' ') ?? '';
    return normalizeSearchText(
        [
            post.authorName,
            post.text,
            post.activity,
            post.linkUrl,
            mediaNames,
            post.source,
            post.externalId,
        ]
            .filter(Boolean)
            .join(' ')
    );
};

export async function searchMessages(query: string, limit = 100): Promise<MessageSearchResult[]> {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [];

    const normalizedQuery = normalizeSearchText(query);
    const db = await initDB();
    const tx = db.transaction('messages', 'readonly');
    const store = tx.store;
    const results: MessageSearchResult[] = [];

    let cursor = await store.openCursor();
    while (cursor) {
        const message = cursor.value;
        const haystack = buildMessageHaystack(message);
        const score = scoreMatch(haystack, tokens, normalizedQuery);

        if (score > 0) {
            const excerptSource =
                message.content?.trim() ||
                message.quotedText?.trim() ||
                message.senderId ||
                message.attachments?.map((attachment) => attachment.fileName).join(', ') ||
                '';

            results.push({
                message,
                score,
                excerpt: buildSnippet(excerptSource, tokens),
            });
        }

        cursor = await cursor.continue();
    }

    return results
        .sort((a, b) => (b.score - a.score) || b.message.timestamp.getTime() - a.message.timestamp.getTime())
        .slice(0, limit);
}

export async function searchPosts(query: string, limit = 100): Promise<PostSearchResult[]> {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [];

    const normalizedQuery = normalizeSearchText(query);
    const db = await initDB();
    const tx = db.transaction('posts', 'readonly');
    const store = tx.store;
    const results: PostSearchResult[] = [];

    let cursor = await store.openCursor();
    while (cursor) {
        const post = cursor.value;
        const haystack = buildPostHaystack(post);
        const score = scoreMatch(haystack, tokens, normalizedQuery);

        if (score > 0) {
            const excerptSource =
                post.text?.trim() ||
                post.activity?.trim() ||
                post.authorName ||
                post.media?.map((media) => media.fileName).join(', ') ||
                '';

            results.push({
                post,
                score,
                excerpt: buildSnippet(excerptSource, tokens),
            });
        }

        cursor = await cursor.continue();
    }

    return results
        .sort((a, b) => (b.score - a.score) || b.post.timestamp - a.post.timestamp)
        .slice(0, limit);
}
