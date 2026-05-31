import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { Message } from '../types/chat';
import { validateMessage } from '../types/chat';
import type { PostRecord, PostMedia } from '../types/posts';
import { validatePostRecord } from '../types/posts';
import { normalizeMojibakeText } from '../utils/text';

interface LucikoDB extends DBSchema {
    messages: {
        key: string;
        value: Message;
        indexes: {
            'chatId': string;
            'externalId': string;
            'chatId_timestamp': [string, Date];
        };
    };
    posts: {
        key: string;
        value: PostRecord;
        indexes: {
            'externalId': string;
            'timestamp': number;
        };
    };
    hiddenItems: {
        key: string;
        value: { key: string; scope: string; itemId: string };
        indexes: {
            'scope': string;
        };
    };
    attachments: {
        key: string;
        value: Blob;
    };
    bookmarks: {
        key: string;
        value: { chatId: string; messageId: string };
    };
}

const DB_NAME = 'luciko-db';
const DB_VERSION = 8; // Add hidden items store

let dbPromise: Promise<IDBPDatabase<LucikoDB>> | undefined;

export function initDB() {
    if (!dbPromise) {
        dbPromise = openDB<LucikoDB>(DB_NAME, DB_VERSION, {
            upgrade(db, oldVersion, _newVersion, transaction) {
                if (!db.objectStoreNames.contains('messages')) {
                    const messageStore = db.createObjectStore('messages', { keyPath: 'id' });
                    messageStore.createIndex('chatId', 'chatId', { unique: false });
                    messageStore.createIndex('externalId', 'externalId', { unique: false });
                    messageStore.createIndex('chatId_timestamp', ['chatId', 'timestamp'], { unique: false });
                } else {
                    const messageStore = transaction.objectStore('messages');
                    if (oldVersion < 2) {
                        messageStore.createIndex('externalId', 'externalId', { unique: false });
                    }
                    if (oldVersion < 3) {
                        messageStore.createIndex('chatId_timestamp', ['chatId', 'timestamp'], { unique: false });
                    }
                }
                if (!db.objectStoreNames.contains('posts')) {
                    const postStore = db.createObjectStore('posts', { keyPath: 'id' });
                    postStore.createIndex('externalId', 'externalId', { unique: false });
                    postStore.createIndex('timestamp', 'timestamp', { unique: false });
                } else if (oldVersion < 7) {
                    const postStore = transaction.objectStore('posts');
                    if (!postStore.indexNames.contains('externalId')) {
                        postStore.createIndex('externalId', 'externalId', { unique: false });
                    }
                    if (!postStore.indexNames.contains('timestamp')) {
                        postStore.createIndex('timestamp', 'timestamp', { unique: false });
                    }
                }
                if (!db.objectStoreNames.contains('hiddenItems')) {
                    const hiddenStore = db.createObjectStore('hiddenItems', { keyPath: 'key' });
                    hiddenStore.createIndex('scope', 'scope', { unique: false });
                }
                if (!db.objectStoreNames.contains('attachments')) {
                    db.createObjectStore('attachments');
                }
                if (!db.objectStoreNames.contains('bookmarks')) {
                    db.createObjectStore('bookmarks', { keyPath: 'chatId' });
                }
                if (oldVersion < 6 && Array.from(db.objectStoreNames as unknown as string[]).includes('chats')) {
                    db.deleteObjectStore('chats' as never);
                }
            },
        }).catch((error) => {
            // Reset promise so future calls can attempt reconnection
            dbPromise = undefined;
            throw error;
        });
    }
    return dbPromise;
}

export async function getAttachment(id: string): Promise<Blob | undefined> {
    const db = await initDB();
    return db.get('attachments', id);
}

export async function getBookmark(chatId: string): Promise<string | null> {
    const db = await initDB();
    const record = await db.get('bookmarks', chatId);
    return record?.messageId ?? null;
}

export async function getAllBookmarks(): Promise<Array<{ chatId: string; messageId: string }>> {
    const db = await initDB();
    const tx = db.transaction('bookmarks', 'readonly');
    const bookmarks: Array<{ chatId: string; messageId: string }> = [];
    let cursor = await tx.store.openCursor();
    while (cursor) {
        bookmarks.push(cursor.value);
        cursor = await cursor.continue();
    }
    return bookmarks;
}

export async function importBookmarks(bookmarks: Array<{ chatId: string; messageId: string }>): Promise<void> {
    const db = await initDB();
    const tx = db.transaction('bookmarks', 'readwrite');
    // Clear all existing bookmarks, then insert the server's set.
    // This handles deletions that happened on other devices.
    let cursor = await tx.store.openCursor();
    while (cursor) {
        await tx.store.delete(cursor.key);
        cursor = await cursor.continue();
    }
    for (const bookmark of bookmarks) {
        await tx.store.put(bookmark);
    }
    await tx.done;
}

export async function setBookmark(chatId: string, messageId: string | null): Promise<void> {
    const db = await initDB();
    if (messageId) {
        await db.put('bookmarks', { chatId, messageId });
    } else {
        await db.delete('bookmarks', chatId);
    }
}

export async function getMessagesCount(chatId: string): Promise<number> {
    const db = await initDB();
    return db.countFromIndex('messages', 'chatId', chatId);
}

export async function getPosts(): Promise<PostRecord[]> {
    const db = await initDB();
    const tx = db.transaction('posts', 'readonly');
    const index = tx.store.index('timestamp');
    const posts: PostRecord[] = [];
    let cursor = await index.openCursor(null, 'next');
    while (cursor) {
        posts.push(cursor.value);
        cursor = await cursor.continue();
    }
    return posts;
}

export async function getPostsCount(): Promise<number> {
    const db = await initDB();
    return db.count('posts');
}

export async function getPostOffset(postId: string): Promise<number | null> {
    const db = await initDB();
    const tx = db.transaction('posts', 'readonly');
    const index = tx.store.index('timestamp');
    let cursor = await index.openCursor();
    let offset = 0;

    while (cursor) {
        if (cursor.value.id === postId) {
            return offset;
        }
        offset += 1;
        cursor = await cursor.continue();
    }

    return null;
}

export async function getPostsPaginated(limit: number, offset: number): Promise<PostRecord[]> {
    const db = await initDB();
    const tx = db.transaction('posts', 'readonly');
    const index = tx.store.index('timestamp');
    let cursor = await index.openCursor();

    if (offset > 0 && cursor) {
        cursor = await cursor.advance(offset);
    }

    const posts: PostRecord[] = [];
    while (cursor && posts.length < limit) {
        posts.push(cursor.value);
        cursor = await cursor.continue();
    }

    return posts;
}

export async function getHiddenItems(scope: string): Promise<Set<string>> {
    const db = await initDB();
    const tx = db.transaction('hiddenItems', 'readonly');
    const index = tx.store.index('scope');
    const keys: string[] = [];
    let cursor = await index.openCursor(scope);
    while (cursor) {
        keys.push(cursor.value.itemId);
        cursor = await cursor.continue();
    }
    return new Set(keys);
}

export async function setHiddenItem(scope: string, itemId: string, hidden: boolean): Promise<void> {
    const db = await initDB();
    const key = `${scope}:${itemId}`;
    if (hidden) {
        await db.put('hiddenItems', { key, scope, itemId });
    } else {
        await db.delete('hiddenItems', key);
    }
}



export async function getMessageOffsetInChat(chatId: string, messageId: string): Promise<number | null> {
    const db = await initDB();
    const tx = db.transaction('messages', 'readonly');
    const index = tx.store.index('chatId_timestamp');
    const range = IDBKeyRange.bound([chatId, new Date(0)], [chatId, new Date(8640000000000000)]);

    let cursor = await index.openCursor(range, 'next');
    let offset = 0;

    while (cursor) {
        if (cursor.value.id === messageId) {
            return offset;
        }
        offset += 1;
        cursor = await cursor.continue();
    }

    return null;
}

/**
 * Fetches a slice of messages for a chat, sorted by timestamp.
 */
export async function getMessagesPaginated(
    chatId: string,
    limit: number,
    offset: number
): Promise<Message[]> {
    const db = await initDB();
    const tx = db.transaction('messages', 'readonly');
    const index = tx.store.index('chatId_timestamp');

    // We want messages where [chatId, min_timestamp] <= [chatId, timestamp] <= [chatId, max_timestamp]
    // The range IDBKeyRange.bound([chatId, new Date(0)], [chatId, new Date(8640000000000000)]) 
    // works because IndexedDB compares arrays element by element.
    const range = IDBKeyRange.bound([chatId, new Date(0)], [chatId, new Date(8640000000000000)]);

    let cursor = await index.openCursor(range, 'next');

    // Advance to offset
    if (offset > 0 && cursor) {
        cursor = await cursor.advance(offset);
    }

    const messages: Message[] = [];
    while (cursor && messages.length < limit) {
        messages.push(cursor.value);
        cursor = await cursor.continue();
    }

    return messages;
}

/**
 * Import summary for messages and posts.
 */
export interface ImportStats {
    inserted: number;
    updated: number;
    /** UUIDs of items that were inserted (not updated/existing). Used to identify items needing remote upload. */
    insertedIds?: string[];
    /** externalId values for inserted items (undefined for items without externalId). Same length/order as insertedIds. */
    insertedExternalIds?: (string | undefined)[];
}

async function hashBlob(blob: Blob): Promise<string> {
    if (!globalThis.crypto?.subtle) {
        return '';
    }
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Imports messages, skipping duplicates based on externalId.
 * Returns counts for inserted and updated messages.
 */
export async function importMessages(messages: Message[]): Promise<ImportStats> {
    const db = await initDB();

    let insertedCount = 0;
    let updatedCount = 0;
    const insertedIds: string[] = [];
    const insertedExternalIds: (string | undefined)[] = [];

    const normalizeMessage = (message: Message): Message => ({
        ...message,
        senderId: normalizeMojibakeText(message.senderId) ?? message.senderId,
        content: normalizeMojibakeText(message.content) ?? message.content,
        quotedText: normalizeMojibakeText(message.quotedText),
        quotedSender: normalizeMojibakeText(message.quotedSender),
        attachments: message.attachments?.map((attachment) => ({
            ...attachment,
            fileName: normalizeMojibakeText(attachment.fileName) ?? attachment.fileName
        }))
    });

    const normalizeReactions = (reactions?: Message['reactions']) => {
        if (!reactions) return [];
        return [...reactions].sort((a, b) => a.emoji.localeCompare(b.emoji));
    };

    const reactionsEqual = (a?: Message['reactions'], b?: Message['reactions']) => {
        const left = normalizeReactions(a);
        const right = normalizeReactions(b);
        if (left.length !== right.length) return false;
        return left.every((reaction, index) =>
            reaction.emoji === right[index].emoji && reaction.count === right[index].count
        );
    };

    // Pre-compute all attachment hashes and keys before opening any transaction.
    // crypto.subtle.digest is non-IDB async work that would cause auto-commit.
    const precomputeAttachmentKeys = async (attachments?: Message['attachments']): Promise<Map<number, string>> => {
        const keys = new Map<number, string>();
        if (!attachments || attachments.length === 0) return keys;
        for (let i = 0; i < attachments.length; i += 1) {
            const att = attachments[i];
            if (att.contentHash) {
                keys.set(i, `hash:${att.contentHash}`);
            } else if (att.file) {
                const hash = await hashBlob(att.file);
                if (hash) {
                    att.contentHash = hash;
                    keys.set(i, `hash:${hash}`);
                } else {
                    keys.set(i, `meta:${att.mimeType ?? ''}:${att.size ?? ''}`);
                }
            } else {
                keys.set(i, `meta:${att.mimeType ?? ''}:${att.size ?? ''}`);
            }
        }
        return keys;
    };

    const dedupeAttachmentsByKey = (attachments: NonNullable<Message['attachments']>, keys: Map<number, string>): NonNullable<Message['attachments']> => {
        const seen = new Map<string, NonNullable<Message['attachments']>[number]>();
        const result: NonNullable<Message['attachments']> = [];
        for (let i = 0; i < attachments.length; i += 1) {
            const key = keys.get(i) ?? '';
            if (!seen.has(key)) {
                seen.set(key, attachments[i]);
                result.push(attachments[i]);
            }
        }
        return result;
    };

    const normalizedMessages: Message[] = [];
    for (const msg of messages) {
        const normalizedMessage = normalizeMessage(msg);
        if (normalizedMessage.attachments && normalizedMessage.attachments.length > 0) {
            // Pre-compute all hashes first, then deduplicate synchronously
            const keys = await precomputeAttachmentKeys(normalizedMessage.attachments);
            normalizedMessage.attachments = dedupeAttachmentsByKey(normalizedMessage.attachments, keys);
        }
        normalizedMessages.push(normalizedMessage);
    }

    for (const msg of normalizedMessages) {
        validateMessage(msg);
    }

    // Use a single transaction for both stores to prevent auto-commit issues
    const tx = db.transaction(['messages', 'attachments'], 'readwrite');
    const messageStore = tx.objectStore('messages');
    const attachmentStore = tx.objectStore('attachments');
    const externalIdIndex = messageStore.index('externalId');

    // Phase 1: Batch all externalId lookups in parallel
    const lookupResults = await Promise.all(
        normalizedMessages.map(async (msg) => {
            if (!msg.externalId) return { msg, existing: undefined };
            const existing = await externalIdIndex.get(msg.externalId);
            return { msg, existing };
        })
    );

    const pendingPuts: Promise<unknown>[] = [];

    const getAttachmentKey = (att: NonNullable<Message['attachments']>[number]): string => {
        if (att.contentHash) return `hash:${att.contentHash}`;
        const meta = `meta:${att.mimeType ?? ''}:${att.size ?? ''}`;
        if (meta.length > 6) return meta;
        return att.id;
    };

    for (const { msg, existing: existingMsg } of lookupResults) {
        if (!msg.externalId) {
            // New message (no externalId)
            pendingPuts.push(messageStore.put(msg));
            insertedCount++;
            insertedIds.push(msg.id);
            insertedExternalIds.push(undefined);
        } else if (!existingMsg) {
            // Insert: message not in DB yet
            if (msg.attachments) {
                for (const att of msg.attachments) {
                    if (att.file) {
                        pendingPuts.push(attachmentStore.put(att.file, att.id));
                    }
                }
            }

            const msgToStore = { ...msg };
            if (msgToStore.attachments) {
                msgToStore.attachments = msgToStore.attachments.map(({ id, type, fileName, size }) => ({ id, type, fileName, size }));
            }

            pendingPuts.push(messageStore.put(msgToStore));
            insertedCount++;
            insertedIds.push(msg.id);
            insertedExternalIds.push(msg.externalId);
        } else {
            // Upgrade: message exists, merge new data
            let existing = existingMsg;
            let wasUpdated = false;

            // Apply mojibake normalization to the existing record if needed
            const normalizedExisting = normalizeMessage(existing);
            if (
                normalizedExisting.senderId !== existing.senderId ||
                normalizedExisting.content !== existing.content ||
                normalizedExisting.quotedText !== existing.quotedText ||
                normalizedExisting.quotedSender !== existing.quotedSender ||
                JSON.stringify(normalizedExisting.attachments ?? []) !== JSON.stringify(existing.attachments ?? [])
            ) {
                existing = { ...existing, ...normalizedExisting };
                wasUpdated = true;
            }

            // Merge incoming field changes (content, sender, quoted) regardless of attachments
            if (
                msg.senderId !== existing.senderId ||
                msg.content !== existing.content ||
                msg.quotedText !== existing.quotedText ||
                msg.quotedSender !== existing.quotedSender
            ) {
                existing.senderId = msg.senderId;
                existing.content = msg.content;
                existing.quotedText = msg.quotedText;
                existing.quotedSender = msg.quotedSender;
                wasUpdated = true;
            }

            if (msg.attachments && msg.attachments.length > 0) {
                const updatedAttachments = [...(existing.attachments || [])];

                const existingByKey = new Map<string, NonNullable<Message['attachments']>[number]>();
                for (const existingAtt of updatedAttachments) {
                    existingByKey.set(getAttachmentKey(existingAtt), existingAtt);
                }

                for (const newAtt of msg.attachments) {
                    if (newAtt.file) {
                        const key = getAttachmentKey(newAtt);
                        const existingAtt = existingByKey.get(key);

                        if (!existingAtt) {
                            pendingPuts.push(attachmentStore.put(newAtt.file, newAtt.id));
                            updatedAttachments.push({ id: newAtt.id, type: newAtt.type, fileName: newAtt.fileName, size: newAtt.size });
                            wasUpdated = true;
                            existingByKey.set(key, newAtt);
                        } else {
                            const storedBlob = await attachmentStore.get(existingAtt.id);
                            if (!storedBlob) {
                                pendingPuts.push(attachmentStore.put(newAtt.file, existingAtt.id));
                                wasUpdated = true;
                            }
                        }
                    }
                }

                if (wasUpdated) {
                    const seenKeys = new Set<string>();
                    existing.attachments = updatedAttachments.filter((att) => {
                        const key = getAttachmentKey(att);
                        if (seenKeys.has(key)) return false;
                        seenKeys.add(key);
                        return true;
                    });
                }
            }

            if (msg.reactions && msg.reactions.length > 0 && !reactionsEqual(existing.reactions, msg.reactions)) {
                existing.reactions = msg.reactions;
                wasUpdated = true;
            }

            if (wasUpdated) {
                pendingPuts.push(messageStore.put(existing));
                updatedCount++;
            }
        }
    }

    // Await all accumulated writes, then the transaction
    await Promise.all(pendingPuts);
    await tx.done;
    return { inserted: insertedCount, updated: updatedCount, insertedIds, insertedExternalIds };
}

/**
 * Imports posts, skipping duplicates based on externalId.
 * Returns counts for inserted and updated posts.
 */
export async function importPosts(posts: PostRecord[]): Promise<ImportStats> {
    const db = await initDB();
    let insertedCount = 0;
    let updatedCount = 0;
    const insertedIds: string[] = [];
    const insertedExternalIds: (string | undefined)[] = [];

    // Pre-compute all media hashes and keys before opening any transaction.
    // crypto.subtle.digest is non-IDB async work that would cause auto-commit.
    const precomputeMediaKeys = async (media?: PostMedia[]): Promise<Map<number, string>> => {
        const keys = new Map<number, string>();
        if (!media || media.length === 0) return keys;
        for (let i = 0; i < media.length; i += 1) {
            const item = media[i];
            if (item.contentHash) {
                keys.set(i, `hash:${item.contentHash}`);
            } else if (item.file) {
                const hash = await hashBlob(item.file);
                if (hash) {
                    item.contentHash = hash;
                    keys.set(i, `hash:${hash}`);
                } else if (item.sourceUri) {
                    keys.set(i, `uri:${item.sourceUri}`);
                } else {
                    keys.set(i, `meta:${item.fileName}:${item.mimeType ?? ''}:${item.size ?? ''}`);
                }
            } else if (item.sourceUri) {
                keys.set(i, `uri:${item.sourceUri}`);
            } else {
                keys.set(i, `meta:${item.fileName}:${item.mimeType ?? ''}:${item.size ?? ''}`);
            }
        }
        return keys;
    };

    const dedupeMediaByKey = (media: PostMedia[], keys: Map<number, string>): PostMedia[] => {
        const seen = new Map<string, PostMedia>();
        for (let i = 0; i < media.length; i += 1) {
            const key = keys.get(i) ?? '';
            if (!seen.has(key)) {
                const next = { ...media[i], id: key };
                seen.set(key, next);
            }
        }
        return Array.from(seen.values());
    };

    const normalizedPosts: PostRecord[] = [];
    for (const post of posts) {
        if (post.media && post.media.length > 0) {
            const keys = await precomputeMediaKeys(post.media);
            post.media = dedupeMediaByKey(post.media, keys);
        }
        normalizedPosts.push(post);
    }

    for (const post of normalizedPosts) {
        validatePostRecord(post);
    }

    const tx = db.transaction(['posts', 'attachments'], 'readwrite');
    const postStore = tx.objectStore('posts');
    const attachmentStore = tx.objectStore('attachments');
    const externalIdIndex = postStore.index('externalId');

    // Phase 1: Batch all externalId lookups in parallel
    const lookupResults = await Promise.all(
        normalizedPosts.map(async (post) => {
            if (!post.externalId) return { post, existing: undefined };
            const existing = await externalIdIndex.get(post.externalId);
            return { post, existing };
        })
    );

    const pendingPuts: Promise<unknown>[] = [];

    for (const { post, existing: existingPost } of lookupResults) {
        if (!post.externalId) {
            // New post without externalId
            pendingPuts.push(postStore.put(post));
            insertedCount++;
            insertedIds.push(post.id);
            insertedExternalIds.push(undefined);
        } else if (!existingPost) {
            // Insert
            if (post.media) {
                for (const media of post.media) {
                    if (media.file) {
                        pendingPuts.push(attachmentStore.put(media.file, media.id));
                    }
                }
            }

            const postToStore: PostRecord = { ...post };
            if (postToStore.media) {
                postToStore.media = postToStore.media.map(({ id, type, fileName }) => ({ id, type, fileName }));
            }
            pendingPuts.push(postStore.put(postToStore));
            insertedCount++;
            insertedIds.push(post.id);
            insertedExternalIds.push(post.externalId);
        } else {
            // Upgrade
            const existing = existingPost;
            let wasUpdated = false;
            if (post.media && post.media.length > 0) {
                const updatedMedia = [...(existing.media || [])];
                const existingById = new Map(updatedMedia.map((media) => [media.id, media]));

                for (const media of post.media) {
                    const current = existingById.get(media.id);
                    if (!current) {
                        if (media.file) {
                            pendingPuts.push(attachmentStore.put(media.file, media.id));
                        }
                        updatedMedia.push({ id: media.id, type: media.type, fileName: media.fileName });
                        wasUpdated = true;
                    } else if (media.file) {
                        const storedBlob = await attachmentStore.get(current.id);
                        if (!storedBlob) {
                            pendingPuts.push(attachmentStore.put(media.file, current.id));
                            wasUpdated = true;
                        }
                    }
                }

                if (wasUpdated) {
                    existing.media = updatedMedia;
                }
            }

            if (!existing.text && post.text) {
                existing.text = post.text;
                wasUpdated = true;
            }
            if (!existing.activity && post.activity) {
                existing.activity = post.activity;
                wasUpdated = true;
            }
            if (!existing.linkUrl && post.linkUrl) {
                existing.linkUrl = post.linkUrl;
                wasUpdated = true;
            }

            if (wasUpdated) {
                pendingPuts.push(postStore.put(existing));
                updatedCount++;
            }
        }
    }

    await Promise.all(pendingPuts);
    await tx.done;
    return { inserted: insertedCount, updated: updatedCount, insertedIds, insertedExternalIds };
}


/**
 * Imports post comments, skipping duplicates based on externalId.
 * Returns the number of new comments imported.
 */
