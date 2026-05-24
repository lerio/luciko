export interface Attachment {
    id: string;
    type: 'image' | 'video' | 'audio' | 'document';
    fileName: string;
    mimeType?: string;
    size?: number;
    file?: Blob; // Raw file data for persistence
    contentHash?: string; // SHA-256 of file contents when available
}

export interface Message {
    id: string;
    chatId: string;
    senderId: string;
    content: string;
    timestamp: Date;
    status: 'sent' | 'delivered' | 'read';
    attachments?: Attachment[];
    quotedText?: string;
    quotedSender?: string;
    reactions?: { emoji: string; count: number }[];
    source?: 'whatsapp' | 'facebook' | 'instagram' | 'googlechat' | 'googlechat_old' | 'imessage' | 'gmail';
    externalId?: string; // For deduplication (hash or unique string)
}

export interface Chat {
    id: string;
    name: string;
    isGroup: boolean;
    avatarUrl?: string;
}

export function validateMessage(input: unknown): Message {
    if (!input || typeof input !== 'object') {
        throw new Error('Invalid message: expected object');
    }
    const m = input as Record<string, unknown>;
    if (typeof m.id !== 'string' || !m.id) throw new Error('Invalid message: missing or invalid id');
    if (typeof m.chatId !== 'string' || !m.chatId) throw new Error('Invalid message: missing or invalid chatId');
    if (typeof m.senderId !== 'string') throw new Error('Invalid message: missing senderId');
    if (typeof m.content !== 'string') throw new Error('Invalid message: missing content');
    if (!(m.timestamp instanceof Date) && typeof m.timestamp !== 'string') {
        throw new Error('Invalid message: timestamp must be Date or ISO string');
    }
    return m as unknown as Message;
}
