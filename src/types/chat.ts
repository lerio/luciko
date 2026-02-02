export interface User {
    id: string;
    name: string;
    avatarUrl?: string;
    color?: string; // For generating avatar background if no image
}

export interface Attachment {
    id: string;
    type: 'image' | 'video' | 'audio' | 'document';
    url: string; // Blob URL or internal ID
    fileName: string;
    mimeType?: string;
    size?: number;
    file?: Blob; // Raw file data for persistence
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
    externalId?: string; // For deduplication (hash or unique string)
}

export interface Chat {
    id: string;
    name: string;
    isGroup: boolean;
    participants: User[];
    lastMessage?: Message;
    avatarUrl?: string;
}
