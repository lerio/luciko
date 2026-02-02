import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { Chat, Message } from '../types/chat';

interface LucikoDB extends DBSchema {
    chats: {
        key: string;
        value: Chat;
    };
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
}

const DB_NAME = 'luciko-db';
const DB_VERSION = 4; // Increment version for attachments store

let dbPromise: Promise<IDBPDatabase<LucikoDB>>;

export function initDB() {
    if (!dbPromise) {
        dbPromise = openDB<LucikoDB>(DB_NAME, DB_VERSION, {
            upgrade(db, oldVersion, _newVersion, transaction) {
                if (!db.objectStoreNames.contains('chats')) {
                    db.createObjectStore('chats', { keyPath: 'id' });
                }
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
            },
        });
    }
    return dbPromise;
}

export async function getAttachment(id: string): Promise<Blob | undefined> {
    const db = await initDB();
    return db.get('attachments', id);
}

export async function getChats(): Promise<Chat[]> {
    const db = await initDB();
    return db.getAll('chats');
}

export async function getMessagesCount(chatId: string): Promise<number> {
    const db = await initDB();
    return db.countFromIndex('messages', 'chatId', chatId);
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

export async function saveChat(chat: Chat): Promise<void> {
    const db = await initDB();
    await db.put('chats', chat);
}

/**
 * Imports messages, skipping duplicates based on externalId.
 * Returns the number of new messages imported.
 */
export async function importMessages(messages: Message[]): Promise<number> {
    const db = await initDB();
    // Use a single transaction for both stores to prevent auto-commit issues
    const tx = db.transaction(['messages', 'attachments'], 'readwrite');
    const messageStore = tx.objectStore('messages');
    const attachmentStore = tx.objectStore('attachments');
    const externalIdIndex = messageStore.index('externalId');

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

    for (const msg of messages) {
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

                    for (const newAtt of msg.attachments) {
                        if (newAtt.file) {
                            // Find if this attachment already exists in the message metadata
                            const existingAttIndex = updatedAttachments.findIndex(a => a.fileName === newAtt.fileName);

                            if (existingAttIndex === -1) {
                                // New attachment metadata entirely
                                await attachmentStore.put(newAtt.file, newAtt.id);
                                updatedAttachments.push({ ...newAtt, file: undefined });
                                wasUpdated = true;
                            } else {
                                // Meta exists, check if blob is actually in store (or just assume we should put it)
                                // We'll use the ID from the existing metadata to keep it consistent
                                await attachmentStore.put(newAtt.file, updatedAttachments[existingAttIndex].id);
                                wasUpdated = true;
                            }
                        }
                    }

                    if (wasUpdated) {
                        existing.attachments = updatedAttachments;
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
