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
