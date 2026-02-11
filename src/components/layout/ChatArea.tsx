import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chat, Message } from "../../types/chat";
import { MessageList } from "../chat/MessageList";
import { Bookmark, EyeOff, Eye } from "lucide-react";
import { getBookmark, setBookmark, getHiddenItems, setHiddenItem } from "../../store/db";
import styles from "./ChatArea.module.css";

interface ChatAreaProps {
  activeChat: Chat | null | undefined;
  messages: Message[];
  onLoadOlder?: () => Promise<number> | number | void;
  onLoadNewer?: () => Promise<number> | number | void;
  hasOlder?: boolean;
  hasNewer?: boolean;
  onJumpToLatest?: () => Promise<void> | void;
  onJumpToBookmark?: (messageId: string) => Promise<boolean>;
}

const CURRENT_USER_ID = "Valerio Donati";

export function ChatArea({ activeChat, messages, onLoadOlder, onLoadNewer, hasOlder, hasNewer, onJumpToLatest, onJumpToBookmark }: ChatAreaProps) {
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const bookmarkLoadTokenRef = useRef(0);
  const [bookmarkedMessageId, setBookmarkedMessageId] = useState<string | null>(null);
  const [isBookmarkReady, setIsBookmarkReady] = useState(false);
  const [isBookmarkScrollPending, setIsBookmarkScrollPending] = useState(false);
  const [hiddenMessageIds, setHiddenMessageIds] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);

  const scrollToBottom = async () => {
    if (onJumpToLatest) {
      await onJumpToLatest();
    }
    const container = messagesRef.current;
    if (!container) return;
    requestAnimationFrame(() => {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    });
  };

  const handleLoadOlder = useCallback(async () => {
    if (!onLoadOlder || !messagesRef.current) return;
    const container = messagesRef.current;
    const prevScrollHeight = container.scrollHeight;
    const prevScrollTop = container.scrollTop;
    const added = await onLoadOlder();
    if (!added) return;
    requestAnimationFrame(() => {
      const nextScrollHeight = container.scrollHeight;
      container.scrollTop = prevScrollTop + (nextScrollHeight - prevScrollHeight);
    });
  }, [onLoadOlder]);

  const handleLoadNewer = useCallback(async () => {
    if (!onLoadNewer) return;
    await onLoadNewer();
  }, [onLoadNewer]);

  const handleBookmark = useCallback((messageId: string) => {
    // Invalidate any in-flight bookmark load so it cannot overwrite user intent.
    bookmarkLoadTokenRef.current += 1;
    setBookmarkedMessageId((current) => (current === messageId ? null : messageId));
  }, []);

  const handleScrollToBookmark = useCallback(async () => {
    if (!bookmarkedMessageId) return;
    const target = document.getElementById(`message-${bookmarkedMessageId}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    if (onJumpToBookmark) {
      setIsBookmarkScrollPending(true);
      const didJump = await onJumpToBookmark(bookmarkedMessageId);
      if (!didJump) {
        setIsBookmarkScrollPending(false);
      }
    }
  }, [bookmarkedMessageId, onJumpToBookmark]);


  useEffect(() => {
    let isActive = true;
    if (!activeChat?.id) {
      setBookmarkedMessageId(null);
      setIsBookmarkReady(false);
      setHiddenMessageIds(new Set());
      setShowHidden(false);
      return;
    }

    const loadToken = bookmarkLoadTokenRef.current + 1;
    bookmarkLoadTokenRef.current = loadToken;

    const load = async () => {
      try {
        const stored = await getBookmark(activeChat.id);
        if (!isActive || bookmarkLoadTokenRef.current !== loadToken) return;
        setBookmarkedMessageId(stored);
      } catch (error) {
        if (!isActive || bookmarkLoadTokenRef.current !== loadToken) return;
        console.warn("Failed to read bookmark from storage:", error);
        setBookmarkedMessageId(null);
      } finally {
        if (isActive && bookmarkLoadTokenRef.current === loadToken) {
          setIsBookmarkReady(true);
        }
      }
    };

    load();
    return () => {
      isActive = false;
    };
  }, [activeChat?.id]);

  useEffect(() => {
    let isActive = true;
    if (!activeChat?.id) return;
    const scope = `chat:${activeChat.id}`;

    const load = async () => {
      try {
        const hidden = await getHiddenItems(scope);
        if (isActive) {
          setHiddenMessageIds(hidden);
        }
      } catch (error) {
        if (isActive) {
          console.warn("Failed to read hidden messages:", error);
        }
      }
    };

    load();
    return () => {
      isActive = false;
    };
  }, [activeChat?.id]);

  useEffect(() => {
    if (!activeChat?.id) return;
    if (!isBookmarkReady) return;

    const persist = async () => {
      try {
        await setBookmark(activeChat.id, bookmarkedMessageId);
      } catch (error) {
        console.warn("Failed to persist bookmark to storage:", error);
      }
    };

    persist();
  }, [activeChat?.id, bookmarkedMessageId, isBookmarkReady]);

  useEffect(() => {
    if (!isBookmarkScrollPending || !bookmarkedMessageId) return;
    const target = document.getElementById(`message-${bookmarkedMessageId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setIsBookmarkScrollPending(false);
  }, [bookmarkedMessageId, isBookmarkScrollPending, messages.length]);

  const handleToggleHidden = useCallback(async (messageId: string) => {
    if (!activeChat?.id) return;
    const scope = `chat:${activeChat.id}`;
    const next = new Set(hiddenMessageIds);
    const isHidden = next.has(messageId);
    if (isHidden) {
      next.delete(messageId);
    } else {
      next.add(messageId);
    }
    setHiddenMessageIds(next);
    try {
      await setHiddenItem(scope, messageId, !isHidden);
    } catch (error) {
      console.warn("Failed to persist hidden message:", error);
    }
  }, [activeChat?.id, hiddenMessageIds]);

  const visibleMessages = useMemo(
    () => (showHidden ? messages : messages.filter((msg) => !hiddenMessageIds.has(msg.id))),
    [messages, showHidden, hiddenMessageIds]
  );

  useEffect(() => {
    if (!onLoadOlder || !hasOlder) return;

    const root = messagesRef.current;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        handleLoadOlder();
      }
    }, { root, rootMargin: "200px 0px", threshold: 0 });

    if (topSentinelRef.current) {
      observer.observe(topSentinelRef.current);
    }

    return () => observer.disconnect();
  }, [handleLoadOlder, hasOlder, messages.length, onLoadOlder]); // Re-observe when messages change

  useEffect(() => {
    if (!onLoadNewer || !hasNewer) return;

    const root = messagesRef.current;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        handleLoadNewer();
      }
    }, { root, rootMargin: "200px 0px", threshold: 0 });

    if (bottomSentinelRef.current) {
      observer.observe(bottomSentinelRef.current);
    }

    return () => observer.disconnect();
  }, [handleLoadNewer, hasNewer, messages.length, onLoadNewer]);
  if (!activeChat) {
    return (
      <main
        className={`${styles.mainBase} ${styles.emptyState}`}
      >
        <div className={styles.emptyStateText}>
          <h2>Welcome to Luciko</h2>
          <p style={{ marginTop: "10px" }}>Select a chat to start reading.</p>
        </div>
      </main>
    );
  }

  return (
    <main
      className={`${styles.mainBase} ${styles.chatMain}`}
    >
      {/* Background could be an image */}
      <div className={styles.header}>
        <div className={styles.headerInfo}>
          <div
            className={styles.avatar}
          >
            {activeChat.avatarUrl ? (
              <img
                src={activeChat.avatarUrl}
                alt={activeChat.name}
                className={styles.avatarImage}
              />
            ) : (
              <span className={styles.avatarFallback}>{activeChat.name.charAt(0)}</span>
            )}
          </div>
          <span style={{ fontWeight: "bold" }}>{activeChat.name}</span>
        </div>
        <div className={styles.headerActions}>
          {bookmarkedMessageId && (
            <button
              type="button"
              className={styles.scrollToBookmarkButton}
              onClick={handleScrollToBookmark}
              aria-label="Scroll to bookmark"
            >
              <Bookmark size={16} />
            </button>
          )}
          {hiddenMessageIds.size > 0 && (
            <button
              type="button"
              className={styles.scrollToBookmarkButton}
              onClick={() => setShowHidden((current) => !current)}
              aria-label={showHidden ? "Hide hidden messages" : "Show hidden messages"}
            >
              {showHidden ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          )}
        </div>
      </div>

      <div className={styles.messagesWrapper} ref={messagesRef}>
        {/* Sentinel for infinite scroll (load older messages) */}
        <div ref={topSentinelRef} className={styles.sentinel} />
        <MessageList
          messages={visibleMessages}
          currentUserId={CURRENT_USER_ID}
          bookmarkedMessageId={bookmarkedMessageId}
          onBookmark={handleBookmark}
          hiddenMessageIds={hiddenMessageIds}
          onToggleHidden={handleToggleHidden}
        />
        {/* Sentinel for infinite scroll (load newer messages) */}
        <div ref={bottomSentinelRef} className={styles.sentinel} />
      </div>
      <button
        type="button"
        className={styles.scrollToBottomButton}
        onClick={scrollToBottom}
        aria-label="Scroll to bottom"
      >
        ↓
      </button>
    </main>
  );
}
