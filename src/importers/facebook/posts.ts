import JSZip from 'jszip';
import { v4 as uuidv4 } from 'uuid';
import { getAttachmentType } from '../utils';
import type { PostRecord, PostMedia, PostSource } from '../../types/posts';

type PostsJsonItem = {
    timestamp?: number;
    title?: string;
    data?: Array<{ post?: string; update_timestamp?: number }>;
    attachments?: Array<{
        data?: Array<{
            media?: { uri?: string };
            external_context?: { url?: string };
        }>;
    }>;
};

type PhotosJson = {
    other_photos_v2?: Array<{ uri?: string; creation_timestamp?: number; description?: string }>;
};

type VideosJson = {
    videos_v2?: Array<{ uri?: string; creation_timestamp?: number; description?: string; title?: string }>;
};

export type ParsePostsResult = {
    posts: PostRecord[];
    errors?: string[];
    logs?: string[];
};

const findFirst = (zip: JSZip, pattern: RegExp) => {
    const match = Object.keys(zip.files).find((name) => pattern.test(name));
    return match || null;
};

const mapSourceUriToZipPath = (sourceUri: string, rootPrefix: string, zip: JSZip): string | null => {
    const cleaned = sourceUri.replace(/^\/+/, '');
    const candidates = [
        cleaned,
        `${rootPrefix}/${cleaned}`.replace(/\/{2,}/g, '/'),
        `${rootPrefix}/${cleaned.replace(/^your_facebook_activity\//, '')}`.replace(/\/{2,}/g, '/'),
        `${rootPrefix}/${cleaned.replace(/^posts\//, 'posts/')}`.replace(/\/{2,}/g, '/'),
        `${rootPrefix}/${cleaned.replace(/^your_facebook_activity\//, 'posts/')}`.replace(/\/{2,}/g, '/')
    ];

    for (const candidate of candidates) {
        if (zip.file(candidate)) {
            return candidate;
        }
    }
    return null;
};

const buildExternalId = (source: PostSource, timestamp: number, text?: string, activity?: string, linkUrl?: string, mediaUris?: string[]) => {
    const base = [
        source,
        timestamp,
        text ?? '',
        activity ?? '',
        linkUrl ?? '',
        ...(mediaUris ?? [])
    ].join('|');
    return `fbpost_${base}`;
};

const toPostMedia = async (
    zip: JSZip,
    rootPrefix: string,
    uri: string,
    logs: string[]
): Promise<PostMedia | null> => {
    const zipPath = mapSourceUriToZipPath(uri, rootPrefix, zip);
    if (!zipPath) {
        logs.push(`Missing media file: ${uri}`);
        return null;
    }

    const entry = zip.file(zipPath);
    if (!entry) {
        logs.push(`Missing media entry: ${zipPath}`);
        return null;
    }

    const blob = await entry.async('blob');
    const fileName = zipPath.split('/').pop() || zipPath;
    const type = getAttachmentType(fileName);
    if (type !== 'image' && type !== 'video') {
        return null;
    }

    return {
        id: uuidv4(),
        type,
        fileName,
        mimeType: blob.type || undefined,
        size: blob.size,
        file: blob,
        sourceUri: uri
    };
};

const detectOwnerName = (items: PostsJsonItem[]): string | undefined => {
    for (const item of items) {
        const title = item.title ?? '';
        const match = title.match(/^(.+?)\s+ha\s+/i);
        if (match && match[1]) {
            return match[1].trim();
        }
    }
    return undefined;
};

export async function parseFacebookPostsZip(file: File, zipInput?: JSZip): Promise<ParsePostsResult> {
    const zip = zipInput ?? await JSZip.loadAsync(file);
    const logs: string[] = [];
    const errors: string[] = [];
    const posts: PostRecord[] = [];

    const postsJsonPath = findFirst(zip, /posts\/your_posts__check_ins__photos_and_videos_\d+\.json$/i);
    const photosJsonPath = findFirst(zip, /posts\/your_uncategorized_photos\.json$/i);
    const videosJsonPath = findFirst(zip, /posts\/your_videos\.json$/i);

    if (!postsJsonPath && !photosJsonPath && !videosJsonPath) {
        throw new Error('No Facebook posts JSON found in zip.');
    }

    const rootPrefix = (postsJsonPath || photosJsonPath || videosJsonPath || '').split('/').slice(0, -2).join('/');

    if (postsJsonPath) {
        const data = JSON.parse(await zip.file(postsJsonPath)!.async('string')) as PostsJsonItem[];
        const ownerName = detectOwnerName(data);

        for (const item of data) {
            const timestamp = item.timestamp ?? item.data?.find((entry) => entry.update_timestamp)?.update_timestamp ?? 0;
            const postText = item.data?.find((entry) => entry.post)?.post;
            const activity = item.title;
            const media: PostMedia[] = [];
            let linkUrl: string | undefined;
            const mediaUris: string[] = [];

            item.attachments?.forEach((attachment) => {
                attachment.data?.forEach((entry) => {
                    if (entry.external_context?.url) {
                        linkUrl = entry.external_context.url;
                    }
                    if (entry.media?.uri) {
                        mediaUris.push(entry.media.uri);
                    }
                });
            });

            for (const uri of mediaUris) {
                const mediaItem = await toPostMedia(zip, rootPrefix, uri, logs);
                if (mediaItem) {
                    media.push(mediaItem);
                }
            }

            if (!postText && !activity && media.length === 0 && !linkUrl) continue;

            posts.push({
                id: uuidv4(),
                timestamp,
                authorName: ownerName,
                text: postText,
                activity,
                media: media.length ? media : undefined,
                linkUrl,
                source: 'posts',
                externalId: buildExternalId('posts', timestamp, postText, activity, linkUrl, mediaUris)
            });
        }
    }

    if (photosJsonPath) {
        const photosJson = JSON.parse(await zip.file(photosJsonPath)!.async('string')) as PhotosJson;
        const ownerName = posts.find((post) => post.authorName)?.authorName;
        for (const item of photosJson.other_photos_v2 ?? []) {
            if (!item.uri) continue;
            const mediaItem = await toPostMedia(zip, rootPrefix, item.uri, logs);
            if (!mediaItem) continue;
            posts.push({
                id: uuidv4(),
                timestamp: item.creation_timestamp ?? 0,
                authorName: ownerName,
                text: item.description,
                media: [mediaItem],
                source: 'photos',
                externalId: buildExternalId('photos', item.creation_timestamp ?? 0, item.description, undefined, undefined, [item.uri])
            });
        }
    }

    if (videosJsonPath) {
        const videosJson = JSON.parse(await zip.file(videosJsonPath)!.async('string')) as VideosJson;
        const ownerName = posts.find((post) => post.authorName)?.authorName;
        for (const item of videosJson.videos_v2 ?? []) {
            if (!item.uri) continue;
            const mediaItem = await toPostMedia(zip, rootPrefix, item.uri, logs);
            if (!mediaItem) continue;
            const text = item.description || item.title;
            posts.push({
                id: uuidv4(),
                timestamp: item.creation_timestamp ?? 0,
                authorName: ownerName,
                text,
                media: [mediaItem],
                source: 'videos',
                externalId: buildExternalId('videos', item.creation_timestamp ?? 0, text, undefined, undefined, [item.uri])
            });
        }
    }

    posts.sort((a, b) => a.timestamp - b.timestamp);
    return { posts, errors, logs };
}
