import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Bookmark } from 'lucide-react';
import styles from './PostsPage.module.css';
import { TARGET_CHAT } from '../../constants/chat';
import { getAttachment, getPosts, getBookmark, setBookmark } from '../../store/db';
import type { PostRecord } from '../../types/posts';

type MediaItem = {
    id: string;
    type: 'image' | 'video';
    src: string;
};

type Post = Omit<PostRecord, 'media'> & {
    media: MediaItem[];
};

const mojibakeScore = (value: string): number => {
    const controlMatches = value.match(/[\u0080-\u00bf]/g);
    const sequenceMatches = value.match(/[ÃÂâå][\u0080-\u00bf]/g);
    return (controlMatches?.length ?? 0) + (sequenceMatches?.length ?? 0) + (value.includes('�') ? 1 : 0);
};

const decodeLatin1AsUtf8 = (value: string): string => {
    const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
};

const normalizeText = (value?: string): string | undefined => {
    if (!value) return value;
    const needsFix = /[\u0080-\u00bf]/.test(value) || /[ÃÂâå][\u0080-\u00bf]/.test(value) || value.includes('�');
    if (!needsFix) return value;
    try {
        let best = value;
        let bestScore = mojibakeScore(value);
        let current = value;

        for (let i = 0; i < 2; i += 1) {
            current = decodeLatin1AsUtf8(current);
            const score = mojibakeScore(current);
            if (score < bestScore) {
                best = current;
                bestScore = score;
            }
            if (score === 0) break;
        }

        return best;
    } catch {
        return value;
    }
};

export function PostsPage() {
    const [posts, setPosts] = useState<Post[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [bookmarkedPostId, setBookmarkedPostId] = useState<string | null>(null);
    const [isBookmarkReady, setIsBookmarkReady] = useState(false);

    useEffect(() => {
        let isMounted = true;
        const objectUrls: string[] = [];

        const load = async () => {
            try {
                const stored = await getPosts();
                const normalizedPosts: Post[] = [];

                for (const post of stored) {
                    const mediaItems: MediaItem[] = [];
                    const mediaList = post.media ?? [];
                    for (const media of mediaList) {
                        const blob = await getAttachment(media.id);
                        if (!blob) continue;
                        const url = URL.createObjectURL(blob);
                        objectUrls.push(url);
                        mediaItems.push({
                            id: media.id,
                            type: media.type,
                            src: url
                        });
                    }

                    normalizedPosts.push({
                        ...post,
                        text: normalizeText(post.text),
                        activity: normalizeText(post.activity),
                        media: mediaItems
                    });
                }

                const filteredPosts = normalizedPosts.filter(
                    (post) => Boolean(post.text?.trim()) || post.media.length > 0 || Boolean(post.linkUrl)
                );
                filteredPosts.sort((a, b) => a.timestamp - b.timestamp);
                if (isMounted) {
                    setPosts(filteredPosts);
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to load posts.';
                if (isMounted) {
                    setError(message);
                }
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
            }
        };

        load();
        return () => {
            isMounted = false;
            objectUrls.forEach((url) => URL.revokeObjectURL(url));
        };
    }, []);

    useEffect(() => {
        let isActive = true;
        const loadBookmark = async () => {
            try {
                const stored = await getBookmark('posts');
                if (isActive) {
                    setBookmarkedPostId(stored);
                    setIsBookmarkReady(true);
                }
            } catch (err) {
                console.warn('Failed to load posts bookmark:', err);
                if (isActive) {
                    setIsBookmarkReady(true);
                }
            }
        };

        loadBookmark();
        return () => {
            isActive = false;
        };
    }, []);

    useEffect(() => {
        if (!isBookmarkReady) return;
        const persist = async () => {
            try {
                await setBookmark('posts', bookmarkedPostId);
            } catch (err) {
                console.warn('Failed to persist posts bookmark:', err);
            }
        };

        persist();
    }, [bookmarkedPostId, isBookmarkReady]);

    const handleBookmark = (postId: string) => {
        setBookmarkedPostId((current) => (current === postId ? null : postId));
    };

    const jumpToBookmark = () => {
        if (!bookmarkedPostId) return;
        const target = document.getElementById(`post-${bookmarkedPostId}`);
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    };

    const displayName = useMemo(() => TARGET_CHAT.name, []);
    const getAvatarForAuthor = (author?: string) => {
        if (!author) return TARGET_CHAT.avatarUrl ?? '';
        if (author.toLowerCase().includes('valerio')) {
            return '/assets/valerio.jpg';
        }
        return TARGET_CHAT.avatarUrl ?? '';
    };

    if (isLoading) {
        return <div className={styles.state}>Loading posts...</div>;
    }

    if (error) {
        return <div className={styles.state}>Error: {error}</div>;
    }

    return (
        <div className={styles.page}>
            <div className={styles.header}>
                <div className={styles.headerInfo}>
                    <span className={styles.title}>Posts</span>
                    {bookmarkedPostId && (
                        <button
                            type="button"
                            className={styles.scrollToBookmarkButton}
                            onClick={jumpToBookmark}
                            aria-label="Scroll to bookmarked post"
                        >
                            <Bookmark size={16} />
                        </button>
                    )}
                </div>
            </div>
            <div className={styles.feed}>
                {posts.map((post) => (
                    <article key={post.id} id={`post-${post.id}`} className={styles.card}>
                        <div className={styles.cardHeader}>
                            <div className={styles.avatar}>
                                {getAvatarForAuthor(post.authorName) ? (
                                    <img
                                        src={getAvatarForAuthor(post.authorName)}
                                        alt={post.authorName ?? displayName}
                                        className={styles.avatarImage}
                                    />
                                ) : (
                                    <span className={styles.avatarFallback}>
                                        {(post.authorName ?? displayName).charAt(0)}
                                    </span>
                                )}
                            </div>
                            <div>
                                <div className={styles.name}>{post.authorName ?? displayName}</div>
                                <div className={styles.meta}>
                                    {format(new Date(post.timestamp * 1000), 'MMM d, yyyy • HH:mm')}
                                </div>
                            </div>
                            <button
                                className={`${styles.bookmarkButton} ${bookmarkedPostId === post.id ? styles.bookmarkButtonActive : ''}`}
                                onClick={() => handleBookmark(post.id)}
                                aria-label={bookmarkedPostId === post.id ? 'Remove bookmark' : 'Add bookmark'}
                                title={bookmarkedPostId === post.id ? 'Remove bookmark' : 'Add bookmark'}
                            >
                                <Bookmark size={16} />
                            </button>
                        </div>

                        {post.text && <div className={styles.text}>{post.text}</div>}

                        {post.media.length > 0 && (
                            <div className={`${styles.mediaGrid} ${post.media.length === 1 ? styles.mediaSingle : ''}`}>
                                {post.media.map((media, index) => (
                                    media.type === 'video' ? (
                                        <video key={`${post.id}-media-${index}`} controls className={styles.mediaItem}>
                                            <source src={media.src} />
                                        </video>
                                    ) : (
                                        <img
                                            key={`${post.id}-media-${index}`}
                                            src={media.src}
                                            alt=""
                                            className={styles.mediaItem}
                                        />
                                    )
                                ))}
                            </div>
                        )}

                        {post.linkUrl && (
                            <a href={post.linkUrl} target="_blank" rel="noreferrer" className={styles.link}>
                                {post.linkUrl}
                            </a>
                        )}

                    </article>
                ))}
            </div>
        </div>
    );
}
