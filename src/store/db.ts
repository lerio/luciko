import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { Message } from '../types/chat';

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
const DB_VERSION = 6; // Remove chats store

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
                if (!db.objectStoreNames.contains('attachments')) {
                    db.createObjectStore('attachments');
                }
                if (!db.objectStoreNames.contains('bookmarks')) {
                    db.createObjectStore('bookmarks', { keyPath: 'chatId' });
                }
                if (oldVersion < 6 && db.objectStoreNames.contains('chats')) {
                    db.deleteObjectStore('chats');
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
