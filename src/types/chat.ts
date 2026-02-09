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
