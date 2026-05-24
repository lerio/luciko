export type PostSource = 'posts' | 'photos' | 'videos';

export interface PostMedia {
    id: string;
    type: 'image' | 'video';
    fileName: string;
    mimeType?: string;
    size?: number;
    file?: Blob;
    contentHash?: string;
    sourceUri?: string;
}

export interface PostRecord {
    id: string;
    timestamp: number;
    authorName?: string;
    text?: string;
    activity?: string;
    media?: PostMedia[];
    linkUrl?: string;
    source: PostSource;
    externalId?: string;
}

export function validatePostRecord(input: unknown): PostRecord {
    if (!input || typeof input !== 'object') {
        throw new Error('Invalid post: expected object');
    }
    const p = input as Record<string, unknown>;
    if (typeof p.id !== 'string' || !p.id) throw new Error('Invalid post: missing or invalid id');
    if (typeof p.timestamp !== 'number') throw new Error('Invalid post: timestamp must be a number');
    if (p.source !== 'posts' && p.source !== 'photos' && p.source !== 'videos') {
        throw new Error(`Invalid post: unexpected source "${String(p.source)}"`);
    }
    return p as unknown as PostRecord;
}
