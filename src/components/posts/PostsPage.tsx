import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { Bookmark, Eye, EyeOff } from "lucide-react";
import styles from "./PostsPage.module.css";
import { TARGET_CHAT } from "../../constants/chat";
import {
  getAttachment,
  getBookmark,
  getHiddenItems,
  getPostOffset,
  getPostsCount,
  getPostsPaginated,
  setBookmark,
  setHiddenItem,
} from "../../store/db";
import type { PostRecord } from "../../types/posts";

type MediaItem = {
  id: string;
  type: "image" | "video";
  src: string;
};

type Post = Omit<PostRecord, "media"> & {
  media: MediaItem[];
};

const PAGE_SIZE = 60;
const BOOKMARK_SCROLL_OFFSET = -70;

const mojibakeScore = (value: string): number => {
  const controlMatches = value.match(/[\u0080-\u00bf]/g);
  const sequenceMatches = value.match(/[ÃÂâå][\u0080-\u00bf]/g);
  return (
    (controlMatches?.length ?? 0) +
    (sequenceMatches?.length ?? 0) +
    (value.includes("�") ? 1 : 0)
  );
};

const decodeLatin1AsUtf8 = (value: string): string => {
  const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
};

const normalizeText = (value?: string): string | undefined => {
  if (!value) return value;
  const needsFix =
    /[\u0080-\u00bf]/.test(value) ||
    /[ÃÂâå][\u0080-\u00bf]/.test(value) ||
    value.includes("�");
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
  const [offset, setOffset] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [hasOlder, setHasOlder] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [loadedCount, setLoadedCount] = useState(0);
  const [bookmarkedPostId, setBookmarkedPostId] = useState<string | null>(null);
  const [isBookmarkReady, setIsBookmarkReady] = useState(false);
  const [hiddenPostIds, setHiddenPostIds] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const objectUrlsRef = useRef<string[]>([]);
  const pageRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const isFetchingRef = useRef(false);

  const hydratePosts = useCallback(
    async (records: PostRecord[]): Promise<Post[]> => {
      const normalizedPosts: Post[] = [];
      for (const post of records) {
        const mediaItems: MediaItem[] = [];
        const mediaList = post.media ?? [];
        for (const media of mediaList) {
          const blob = await getAttachment(media.id);
          if (!blob) continue;
          const url = URL.createObjectURL(blob);
          objectUrlsRef.current.push(url);
          mediaItems.push({
            id: media.id,
            type: media.type,
            src: url,
          });
        }

        normalizedPosts.push({
          ...post,
          text: normalizeText(post.text),
          activity: normalizeText(post.activity),
          media: mediaItems,
        });
      }

      return normalizedPosts.filter(
        (post) =>
          Boolean(post.text?.trim()) ||
          post.media.length > 0 ||
          Boolean(post.linkUrl),
      );
    },
    [],
  );

  const loadInitialPosts = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const total = await getPostsCount();
      const start = 0;
      const batch = await getPostsPaginated(PAGE_SIZE, start);
      const hydrated = await hydratePosts(batch);
      setPosts(hydrated);
      setOffset(start);
      setTotalCount(total);
      setHasOlder(false);
      setHasNewer(start + batch.length < total);
      setLoadedCount(batch.length);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load posts.";
      setError(message);
    } finally {
      isFetchingRef.current = false;
      setIsLoading(false);
    }
  }, [hydratePosts]);

  useEffect(() => {
    loadInitialPosts();
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current = [];
    };
  }, [loadInitialPosts]);

  useEffect(() => {
    let isActive = true;
    const loadBookmark = async () => {
      try {
        const stored = await getBookmark("posts");
        if (isActive) {
          setBookmarkedPostId(stored);
          setIsBookmarkReady(true);
        }
      } catch (err) {
        console.warn("Failed to load posts bookmark:", err);
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
    let isActive = true;
    const loadHidden = async () => {
      try {
        const hidden = await getHiddenItems("posts");
        if (isActive) {
          setHiddenPostIds(hidden);
        }
      } catch (err) {
        if (isActive) {
          console.warn("Failed to load hidden posts:", err);
        }
      }
    };

    loadHidden();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!isBookmarkReady) return;
    const persist = async () => {
      try {
        await setBookmark("posts", bookmarkedPostId);
      } catch (err) {
        console.warn("Failed to persist posts bookmark:", err);
      }
    };

    persist();
  }, [bookmarkedPostId, isBookmarkReady]);

  const loadOlderPosts = useCallback(async () => {
    if (!hasOlder || isFetchingRef.current) return 0;
    isFetchingRef.current = true;
    try {
      const nextOffset = Math.max(0, offset - PAGE_SIZE);
      const batch = await getPostsPaginated(PAGE_SIZE, nextOffset);
      if (batch.length > 0) {
        const hydrated = await hydratePosts(batch);
        setPosts((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const uniqueNew = hydrated.filter((p) => !existingIds.has(p.id));
          return [...uniqueNew, ...prev];
        });
        setOffset(nextOffset);
        setHasOlder(nextOffset > 0);
        setHasNewer(nextOffset + batch.length + loadedCount < totalCount);
        setLoadedCount((current) => current + batch.length);
        return batch.length;
      }
      setHasOlder(false);
      return 0;
    } finally {
      isFetchingRef.current = false;
    }
  }, [hasOlder, offset, hydratePosts, loadedCount, totalCount]);

  const loadNewerPosts = useCallback(async () => {
    if (!hasNewer || isFetchingRef.current) return 0;
    isFetchingRef.current = true;
    try {
      const start = offset + loadedCount;
      const batch = await getPostsPaginated(PAGE_SIZE, start);
      if (batch.length > 0) {
        const hydrated = await hydratePosts(batch);
        setPosts((prev) => {
          const existingIds = new Set(prev.map((p) => p.id));
          const uniqueNew = hydrated.filter((p) => !existingIds.has(p.id));
          return [...prev, ...uniqueNew];
        });
        setHasNewer(start + batch.length < totalCount);
        setLoadedCount((current) => current + batch.length);
        return batch.length;
      }
      setHasNewer(false);
      return 0;
    } finally {
      isFetchingRef.current = false;
    }
  }, [hasNewer, offset, hydratePosts, loadedCount, totalCount]);

  useEffect(() => {
    if (!hasOlder) return;
    const root = pageRef.current;
    if (!root || !topSentinelRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadOlderPosts();
        }
      },
      { root, rootMargin: "200px 0px", threshold: 0 },
    );
    observer.observe(topSentinelRef.current);
    return () => observer.disconnect();
  }, [hasOlder, loadOlderPosts, posts.length]);

  useEffect(() => {
    if (!hasNewer) return;
    const root = pageRef.current;
    if (!root || !bottomSentinelRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadNewerPosts();
        }
      },
      { root, rootMargin: "200px 0px", threshold: 0 },
    );
    observer.observe(bottomSentinelRef.current);
    return () => observer.disconnect();
  }, [hasNewer, loadNewerPosts, posts.length]);

  const handleBookmark = (postId: string) => {
    setBookmarkedPostId((current) => (current === postId ? null : postId));
  };

  const handleToggleHidden = async (postId: string) => {
    const next = new Set(hiddenPostIds);
    const isHidden = next.has(postId);
    if (isHidden) {
      next.delete(postId);
    } else {
      next.add(postId);
    }
    setHiddenPostIds(next);
    try {
      await setHiddenItem("posts", postId, !isHidden);
    } catch (err) {
      console.warn("Failed to persist hidden post:", err);
    }
  };

  const jumpToBookmark = () => {
    if (!bookmarkedPostId) return;
    const target = document.getElementById(`post-${bookmarkedPostId}`);
    if (target) {
      const root = pageRef.current;
      if (root) {
        const rootRect = root.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const nextTop =
          root.scrollTop +
          (targetRect.top - rootRect.top) +
          BOOKMARK_SCROLL_OFFSET;
        root.scrollTo({ top: nextTop, behavior: "smooth" });
      } else {
        const nextTop =
          window.scrollY +
          target.getBoundingClientRect().top +
          BOOKMARK_SCROLL_OFFSET;
        window.scrollTo({ top: nextTop, behavior: "smooth" });
      }
      return;
    }
    const jump = async () => {
      const position = await getPostOffset(bookmarkedPostId);
      if (position === null) return;
      const total = await getPostsCount();
      const start = Math.max(
        0,
        Math.min(
          position - Math.floor(PAGE_SIZE / 2),
          Math.max(0, total - PAGE_SIZE),
        ),
      );
      const batch = await getPostsPaginated(PAGE_SIZE, start);
      const hydrated = await hydratePosts(batch);
      setPosts(hydrated);
      setOffset(start);
      setTotalCount(total);
      setHasOlder(start > 0);
      setHasNewer(start + batch.length < total);
      setLoadedCount(batch.length);
    };
    jump();
  };

  const displayName = useMemo(() => TARGET_CHAT.name, []);
  const getAvatarForAuthor = (author?: string) => {
    if (!author) return TARGET_CHAT.avatarUrl ?? "";
    if (author.toLowerCase().includes("valerio")) {
      return "/assets/valerio.jpg";
    }
    return TARGET_CHAT.avatarUrl ?? "";
  };

  if (isLoading) {
    return <div className={styles.state}>Loading posts...</div>;
  }

  if (error) {
    return <div className={styles.state}>Error: {error}</div>;
  }

  return (
    <div className={styles.page} ref={pageRef}>
      <div className={styles.header}>
        <div className={styles.headerInfo}>
          <span className={styles.title}>Posts</span>
        </div>
        <div className={styles.headerActions}>
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
          {hiddenPostIds.size > 0 && (
            <button
              type="button"
              className={styles.scrollToBookmarkButton}
              onClick={() => setShowHidden((current) => !current)}
              aria-label={
                showHidden ? "Hide hidden posts" : "Show hidden posts"
              }
            >
              {showHidden ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          )}
        </div>
      </div>
      <div ref={topSentinelRef} className={styles.sentinel} />
      <div className={styles.feed}>
        {(showHidden
          ? posts
          : posts.filter((post) => !hiddenPostIds.has(post.id))
        ).map((post) => (
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
                <div className={styles.name}>
                  {post.authorName ?? displayName}
                </div>
                <div className={styles.meta}>
                  {format(
                    new Date(post.timestamp * 1000),
                    "MMM d, yyyy • HH:mm",
                  )}
                </div>
              </div>
              <div className={styles.postActions}>
                <button
                  className={`${styles.bookmarkButton} ${bookmarkedPostId === post.id ? styles.bookmarkButtonActive : ""}`}
                  onClick={() => handleBookmark(post.id)}
                  aria-label={
                    bookmarkedPostId === post.id
                      ? "Remove bookmark"
                      : "Add bookmark"
                  }
                  title={
                    bookmarkedPostId === post.id
                      ? "Remove bookmark"
                      : "Add bookmark"
                  }
                >
                  <Bookmark size={16} />
                </button>
                <button
                  className={`${styles.bookmarkButton} ${hiddenPostIds.has(post.id) ? styles.hideButtonActive : ""}`}
                  onClick={() => handleToggleHidden(post.id)}
                  aria-label={
                    hiddenPostIds.has(post.id) ? "Unhide post" : "Hide post"
                  }
                  title={
                    hiddenPostIds.has(post.id) ? "Unhide post" : "Hide post"
                  }
                >
                  <EyeOff size={16} />
                </button>
              </div>
            </div>

            {post.text && <div className={styles.text}>{post.text}</div>}

            {post.media.length > 0 && (
              <div
                className={`${styles.mediaGrid} ${post.media.length === 1 ? styles.mediaSingle : ""}`}
              >
                {post.media.map((media, index) =>
                  media.type === "video" ? (
                    <video
                      key={`${post.id}-media-${index}`}
                      controls
                      className={styles.mediaItem}
                    >
                      <source src={media.src} />
                    </video>
                  ) : (
                    <img
                      key={`${post.id}-media-${index}`}
                      src={media.src}
                      alt=""
                      className={styles.mediaItem}
                    />
                  ),
                )}
              </div>
            )}

            {post.linkUrl && (
              <a
                href={post.linkUrl}
                target="_blank"
                rel="noreferrer"
                className={styles.link}
              >
                {post.linkUrl}
              </a>
            )}
          </article>
        ))}
      </div>
      <div ref={bottomSentinelRef} className={styles.sentinel} />
    </div>
  );
}
