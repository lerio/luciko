import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chat, Message } from "../../types/chat";
import { MessageList } from "../chat/MessageList";
import { Bookmark, EyeOff, Eye } from "lucide-react";
import { getBookmark, setBookmark, getHiddenItems, setHiddenItem } from "../../store/db";
import { pushBookmarksToServer } from "../../store/archiveSync";
import styles from "./ChatArea.module.css";
import { format } from "date-fns";
import messageListStyles from "../chat/MessageList.module.css";

interface ChatAreaProps {
  activeChat: Chat | null | undefined;
  messages: Message[];
  onLoadOlder?: () => Promise<number> | number | void;
  onLoadNewer?: () => Promise<number> | number | void;
  hasOlder?: boolean;
  hasNewer?: boolean;
  onJumpToLatest?: () => Promise<void> | void;
  onJumpToBookmark?: (messageId: string) => Promise<boolean>;
  focusRequest?: { messageId: string; token: number } | null;
  onFocusRequestHandled?: () => void;
  bookmarkVersion?: number;
}

const CURRENT_USER_ID = "Valerio Donati";

export function ChatArea({ activeChat, messages, onLoadOlder, onLoadNewer, hasOlder, hasNewer, onJumpToLatest, onJumpToBookmark, focusRequest, onFocusRequestHandled, bookmarkVersion }: ChatAreaProps) {
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const bookmarkLoadTokenRef = useRef(0);
  const initialAutoScrollRef = useRef(true);
  const hiddenMarkerRef = useRef<HTMLElement | null>(null);
  const [bookmarkedMessageId, setBookmarkedMessageId] = useState<string | null>(null);
  const [isBookmarkReady, setIsBookmarkReady] = useState(false);
  const [isBookmarkScrollPending, setIsBookmarkScrollPending] = useState(false);
  const [hiddenMessageIds, setHiddenMessageIds] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [stickyDateLabel, setStickyDateLabel] = useState<string | null>(null);

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
      return () => {
        isActive = false;
      };
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
  }, [activeChat?.id, bookmarkVersion]);

  // Reset auto-scroll flag when the active chat changes.
  useEffect(() => {
    initialAutoScrollRef.current = true;
  }, [activeChat?.id]);

  // Auto-scroll to bookmarked message on initial load.
  useEffect(() => {
    if (!initialAutoScrollRef.current) return;
    if (!isBookmarkReady || !bookmarkedMessageId) return;
    if (messages.length === 0) return;

    initialAutoScrollRef.current = false;

    const target = document.getElementById(`message-${bookmarkedMessageId}`);
    if (target) {
      requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return;
    }

    if (onJumpToBookmark) {
      requestAnimationFrame(() => setIsBookmarkScrollPending(true));
      onJumpToBookmark(bookmarkedMessageId).then((didJump) => {
        if (!didJump) {
          setIsBookmarkScrollPending(false);
        }
      });
    }
  }, [isBookmarkReady, bookmarkedMessageId, messages.length, onJumpToBookmark]);

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
  }, [activeChat?.id, bookmarkVersion]);

  useEffect(() => {
    if (!activeChat?.id) return;
    if (!isBookmarkReady) return;

    const persist = async () => {
      try {
        await setBookmark(activeChat.id, bookmarkedMessageId);
        await pushBookmarksToServer();
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
    requestAnimationFrame(() => setIsBookmarkScrollPending(false));
  }, [bookmarkedMessageId, isBookmarkScrollPending, messages.length]);

  useEffect(() => {
    if (!focusRequest?.messageId || !activeChat?.id || !onJumpToBookmark) return;

    let isActive = true;
    const jump = async () => {
      setIsBookmarkScrollPending(true);
      try {
        const didJump = await onJumpToBookmark(focusRequest.messageId);
        if (!isActive || !didJump) return;

        const target = document.getElementById(`message-${focusRequest.messageId}`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        onFocusRequestHandled?.();
      } finally {
        if (isActive) {
          setIsBookmarkScrollPending(false);
        }
      }
    };

    jump();
    return () => {
      isActive = false;
    };
  }, [activeChat?.id, focusRequest?.messageId, focusRequest?.token, onJumpToBookmark, onFocusRequestHandled]);

  const chatId = activeChat?.id ?? null;

  const handleToggleHidden = useCallback(async (messageId: string) => {
    if (!chatId) return;
    const scope = `chat:${chatId}`;
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
  }, [chatId, hiddenMessageIds]);

  const visibleMessages = useMemo(
    () => (showHidden ? messages : messages.filter((msg) => !hiddenMessageIds.has(msg.id))),
    [messages, showHidden, hiddenMessageIds]
  );

  useEffect(() => {
    if (visibleMessages.length === 0) {
      hiddenMarkerRef.current?.classList.remove(messageListStyles.dateRowHidden);
      hiddenMarkerRef.current = null;
      requestAnimationFrame(() => setStickyDateLabel(null));
      return;
    }

    const container = messagesRef.current;
    if (!container) {
      hiddenMarkerRef.current?.classList.remove(messageListStyles.dateRowHidden);
      hiddenMarkerRef.current = null;
      setStickyDateLabel(format(visibleMessages[0].timestamp, "MMMM d, yyyy"));
      return;
    }

    const stickyOffset = 10;

    const updateStickyDate = () => {
      const markers = Array.from(container.querySelectorAll<HTMLElement>("[data-date-marker='true']"));
      if (markers.length === 0) {
        hiddenMarkerRef.current?.classList.remove(messageListStyles.dateRowHidden);
        hiddenMarkerRef.current = null;
        const nextLabel = format(visibleMessages[0].timestamp, "MMMM d, yyyy");
        requestAnimationFrame(() => setStickyDateLabel(nextLabel));
        return;
      }

      const containerTop = container.getBoundingClientRect().top;
      const threshold = containerTop + stickyOffset;
      let nextLabel = markers[0].dataset.dateLabel ?? format(visibleMessages[0].timestamp, "MMMM d, yyyy");
      let nextMarker: HTMLElement | null = null;

      for (const marker of markers) {
        if (marker.getBoundingClientRect().top <= threshold) {
          nextLabel = marker.dataset.dateLabel ?? nextLabel;
          nextMarker = marker;
        } else {
          break;
        }
      }

      if (hiddenMarkerRef.current && hiddenMarkerRef.current !== nextMarker) {
        hiddenMarkerRef.current.classList.remove(messageListStyles.dateRowHidden);
      }
      if (nextMarker) {
        nextMarker.classList.add(messageListStyles.dateRowHidden);
      }
      hiddenMarkerRef.current = nextMarker;
      requestAnimationFrame(() => setStickyDateLabel(nextLabel));
    };

    const handleScroll = () => {
      updateStickyDate();
    };

    updateStickyDate();
    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      container.removeEventListener("scroll", handleScroll);
      hiddenMarkerRef.current?.classList.remove(messageListStyles.dateRowHidden);
      hiddenMarkerRef.current = null;
    };
  }, [visibleMessages]);

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
  }, [handleLoadOlder, hasOlder, onLoadOlder]);

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
  }, [handleLoadNewer, hasNewer, onLoadNewer]);
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
        {stickyDateLabel && (
          <div className={styles.stickyDateOverlay} aria-hidden="true">
            <span className={styles.stickyDateChip}>{stickyDateLabel}</span>
          </div>
        )}
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
