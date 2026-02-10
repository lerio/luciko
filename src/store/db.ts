import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { Message } from '../types/chat';
import type { PostRecord, PostMedia } from '../types/posts';

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
const DB_VERSION = 7; // Add posts store

let dbPromise: Promise<IDBPDatabase<LucikoDB>>;

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
 * Imports messages, skipping duplicates based on externalId.
 * Returns the number of new messages imported.
 */
export async function importMessages(messages: Message[]): Promise<number> {
    const db = await initDB();

    let importedCount = 0;

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

    const hashBlob = async (blob: Blob): Promise<string> => {
        if (!globalThis.crypto?.subtle) {
            return '';
        }
        const buffer = await blob.arrayBuffer();
        const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    };

    const buildAttachmentKey = async (att: NonNullable<Message['attachments']>[number]) => {
        if (att.contentHash) {
            return `hash:${att.contentHash}`;
        }
        if (att.file) {
            const hash = await hashBlob(att.file);
            if (hash) {
                att.contentHash = hash;
                return `hash:${hash}`;
            }
        }
        const mime = att.mimeType ?? '';
        const size = att.size ?? '';
        return `meta:${mime}:${size}`;
    };

    const dedupeAttachments = async (attachments?: Message['attachments']) => {
        if (!attachments || attachments.length === 0) return undefined;
        const seen = new Map<string, NonNullable<Message['attachments']>[number]>();
        for (const att of attachments) {
            const key = await buildAttachmentKey(att);
            if (!seen.has(key)) {
                seen.set(key, att);
            }
        }
        return Array.from(seen.values());
    };

    const normalizedMessages: Message[] = [];
    for (const msg of messages) {
        if (msg.attachments && msg.attachments.length > 0) {
            msg.attachments = await dedupeAttachments(msg.attachments);
        }
        normalizedMessages.push(msg);
    }

    // Use a single transaction for both stores to prevent auto-commit issues
    const tx = db.transaction(['messages', 'attachments'], 'readwrite');
    const messageStore = tx.objectStore('messages');
    const attachmentStore = tx.objectStore('attachments');
    const externalIdIndex = messageStore.index('externalId');

    for (const msg of normalizedMessages) {
        if (msg.externalId) {
            const existing = await externalIdIndex.get(msg.externalId);

            if (!existing) {
                // Save attachments first
                if (msg.attachments) {
                    for (const att of msg.attachments) {
                        if (att.file) {
                            await attachmentStore.put(att.file, att.id);
                        }
                    }
                }

                // Strip blobs before saving to message store
                const msgToStore = { ...msg };
                if (msgToStore.attachments) {
                    msgToStore.attachments = msgToStore.attachments.map(att => ({
                        ...att,
                        file: undefined
                    }));
                }

                await messageStore.put(msgToStore);
                importedCount++;
            } else {
                // UPGRADE CASE: Message exists, check if new import has attachments to fill in
                let wasUpdated = false;
                if (msg.attachments && msg.attachments.length > 0) {
                    const updatedAttachments = [...(existing.attachments || [])];

                    const existingByKey = new Map<string, NonNullable<Message['attachments']>[number]>();
                    for (const existingAtt of updatedAttachments) {
                        const key = await buildAttachmentKey(existingAtt);
                        existingByKey.set(key, existingAtt);
                    }

                    for (const newAtt of msg.attachments) {
                        if (newAtt.file) {
                            const key = await buildAttachmentKey(newAtt);
                            const existingAtt = existingByKey.get(key);

                            if (!existingAtt) {
                                // New attachment metadata entirely
                                await attachmentStore.put(newAtt.file, newAtt.id);
                                updatedAttachments.push({ ...newAtt, file: undefined });
                                wasUpdated = true;
                                existingByKey.set(key, newAtt);
                            } else {
                                // Meta exists, check if blob is actually in store (or just assume we should put it)
                                // We'll use the ID from the existing metadata to keep it consistent
                                await attachmentStore.put(newAtt.file, existingAtt.id);
                                wasUpdated = true;
                            }
                        }
                    }

                    if (wasUpdated) {
                        existing.attachments = await dedupeAttachments(updatedAttachments);
                        // Also sync content just in case it was cleaned up by parser
                        existing.content = msg.content;
                    }
                }
                if (msg.reactions && msg.reactions.length > 0 && !reactionsEqual(existing.reactions, msg.reactions)) {
                    existing.reactions = msg.reactions;
                    wasUpdated = true;
                }

                if (wasUpdated) {
                    await messageStore.put(existing);
                    importedCount++;
                }
            }
        } else {
            await messageStore.put(msg);
            importedCount++;
        }
    }

    await tx.done;
    return importedCount;
}

/**
 * Imports posts, skipping duplicates based on externalId.
 * Returns the number of new posts imported.
 */
export async function importPosts(posts: PostRecord[]): Promise<number> {
    const db = await initDB();
    let importedCount = 0;

    const hashBlob = async (blob: Blob): Promise<string> => {
        if (!globalThis.crypto?.subtle) {
            return '';
        }
        const buffer = await blob.arrayBuffer();
        const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    };

    const buildMediaKey = async (media: PostMedia) => {
        if (media.contentHash) {
            return `hash:${media.contentHash}`;
        }
        if (media.file) {
            const hash = await hashBlob(media.file);
            if (hash) {
                media.contentHash = hash;
                return `hash:${hash}`;
            }
        }
        if (media.sourceUri) {
            return `uri:${media.sourceUri}`;
        }
        const mime = media.mimeType ?? '';
        const size = media.size ?? '';
        return `meta:${media.fileName}:${mime}:${size}`;
    };

    const dedupeMedia = async (media?: PostMedia[]) => {
        if (!media || media.length === 0) return undefined;
        const seen = new Map<string, PostMedia>();
        for (const item of media) {
            const key = await buildMediaKey(item);
            if (!seen.has(key)) {
                const next = { ...item, id: key };
                seen.set(key, next);
            }
        }
        return Array.from(seen.values());
    };

    const normalizedPosts: PostRecord[] = [];
    for (const post of posts) {
        if (post.media && post.media.length > 0) {
            post.media = await dedupeMedia(post.media);
        }
        normalizedPosts.push(post);
    }

    const tx = db.transaction(['posts', 'attachments'], 'readwrite');
    const postStore = tx.objectStore('posts');
    const attachmentStore = tx.objectStore('attachments');
    const externalIdIndex = postStore.index('externalId');

    for (const post of normalizedPosts) {
        let existing: PostRecord | undefined;
        if (post.externalId) {
            existing = await externalIdIndex.get(post.externalId);
        }

        if (!existing) {
            if (post.media) {
                for (const media of post.media) {
                    if (media.file) {
                        await attachmentStore.put(media.file, media.id);
                    }
                }
            }

            const postToStore: PostRecord = { ...post };
            if (postToStore.media) {
                postToStore.media = postToStore.media.map((media) => ({ ...media, file: undefined }));
            }
            await postStore.put(postToStore);
            importedCount++;
        } else {
            let wasUpdated = false;
            if (post.media && post.media.length > 0) {
                const updatedMedia = [...(existing.media || [])];
                const existingById = new Map(updatedMedia.map((media) => [media.id, media]));

                for (const media of post.media) {
                    const current = existingById.get(media.id);
                    if (!current) {
                        if (media.file) {
                            await attachmentStore.put(media.file, media.id);
                        }
                        updatedMedia.push({ ...media, file: undefined });
                        wasUpdated = true;
                    } else if (media.file) {
                        await attachmentStore.put(media.file, current.id);
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
                await postStore.put(existing);
                importedCount++;
            }
        }
    }

    await tx.done;
    return importedCount;
}

/**
 * Imports post comments, skipping duplicates based on externalId.
 * Returns the number of new comments imported.
 */
