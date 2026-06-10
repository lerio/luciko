/**
 * Chat message view with infinite scroll, sticky date headers, and bookmarking.
 *
 * Features:
 * - **Infinite scroll** — Two {@link IntersectionObserver} sentinels trigger
 *   loading older/newer messages when they enter the viewport. Scroll position
 *   is preserved when older messages are prepended.
 * - **Sticky date header** — An overlay at the top of the scrollable area
 *   shows the date of the first currently-visible date marker. The "covered"
 *   marker in the list is hidden to avoid duplication.
 * - **Bookmarks** — Loads the persisted bookmark on mount and auto-scrolls to
 *   it on first load. Bookmark changes are persisted back to IndexedDB.
 * - **Search result focus** — Accepts a `focusRequest` prop from the search
 *   page and jumps to the requested message, loading surrounding context if
 *   needed.
 * - **Scroll-to-bottom** — Floating button that reloads the latest page.
 *
 * @module ChatArea
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Chat, Message } from "../../types/chat";
import { MessageList } from "../chat/MessageList";
import { Bookmark } from "lucide-react";
import { useBookmark } from "../../hooks/useBookmark";
import { useInfiniteScroll } from "../../hooks/useInfiniteScroll";
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
}

/** Hardcoded current user — used to determine message alignment (sent vs received). */
const CURRENT_USER_ID = "Valerio Donati";

/**
 * Renders the chat area for a single conversation.
 *
 * Handles message display, infinite scroll via sentinel elements,
 * sticky date overlay, bookmark persistence and scroll-to-bookmark,
 * and search result focus navigation.
 */
export function ChatArea({
  activeChat,
  messages,
  onLoadOlder,
  onLoadNewer,
  hasOlder,
  hasNewer,
  onJumpToLatest,
  onJumpToBookmark,
  focusRequest,
  onFocusRequestHandled,
}: ChatAreaProps) {
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const initialAutoScrollRef = useRef(true);
  const hiddenMarkerRef = useRef<HTMLElement | null>(null);
  const [isBookmarkScrollPending, setIsBookmarkScrollPending] = useState(false);
  const [stickyDateLabel, setStickyDateLabel] = useState<string | null>(null);

  const { bookmarkedId: bookmarkedMessageId, toggleBookmark: handleBookmark, isReady: isBookmarkReady } = useBookmark(activeChat?.id ?? '');

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
      container.scrollTop =
        prevScrollTop + (nextScrollHeight - prevScrollHeight);
    });
  }, [onLoadOlder]);

  const handleLoadNewer = useCallback(async () => {
    if (!onLoadNewer) return;
    await onLoadNewer();
  }, [onLoadNewer]);

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
    if (!isBookmarkScrollPending || !bookmarkedMessageId) return;
    const target = document.getElementById(`message-${bookmarkedMessageId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    requestAnimationFrame(() => setIsBookmarkScrollPending(false));
  }, [bookmarkedMessageId, isBookmarkScrollPending, messages.length]);

  useEffect(() => {
    if (!focusRequest?.messageId || !activeChat?.id || !onJumpToBookmark)
      return;

    let isActive = true;
    const jump = async () => {
      setIsBookmarkScrollPending(true);
      try {
        const didJump = await onJumpToBookmark(focusRequest.messageId);
        if (!isActive || !didJump) return;

        const target = document.getElementById(
          `message-${focusRequest.messageId}`,
        );
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
  }, [
    activeChat?.id,
    focusRequest?.messageId,
    focusRequest?.token,
    onJumpToBookmark,
    onFocusRequestHandled,
  ]);

  useEffect(() => {
    if (messages.length === 0) {
      hiddenMarkerRef.current?.classList.remove(
        messageListStyles.dateRowHidden,
      );
      hiddenMarkerRef.current = null;
      requestAnimationFrame(() => setStickyDateLabel(null));
      return;
    }

    const container = messagesRef.current;
    if (!container) {
      hiddenMarkerRef.current?.classList.remove(
        messageListStyles.dateRowHidden,
      );
      hiddenMarkerRef.current = null;
      setStickyDateLabel(format(messages[0].timestamp, "MMMM d, yyyy"));
      return;
    }

    const stickyOffset = 10;

    const updateStickyDate = () => {
      const markers = Array.from(
        container.querySelectorAll<HTMLElement>("[data-date-marker='true']"),
      );
      if (markers.length === 0) {
        hiddenMarkerRef.current?.classList.remove(
          messageListStyles.dateRowHidden,
        );
        hiddenMarkerRef.current = null;
        const nextLabel = format(messages[0].timestamp, "MMMM d, yyyy");
        requestAnimationFrame(() => setStickyDateLabel(nextLabel));
        return;
      }

      const containerTop = container.getBoundingClientRect().top;
      const threshold = containerTop + stickyOffset;
      let nextLabel: string | null = markers[0].dataset.dateLabel ?? format(messages[0].timestamp, "MMMM d, yyyy");
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
        hiddenMarkerRef.current.classList.remove(
          messageListStyles.dateRowHidden,
        );
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
      hiddenMarkerRef.current?.classList.remove(
        messageListStyles.dateRowHidden,
      );
      hiddenMarkerRef.current = null;
    };
  }, [messages]);

  useInfiniteScroll({
    rootRef: messagesRef,
    topSentinelRef,
    bottomSentinelRef,
    hasOlder: hasOlder ?? false,
    hasNewer: hasNewer ?? false,
    onLoadOlder: handleLoadOlder,
    onLoadNewer: handleLoadNewer,
  });

  if (!activeChat) {
    return (
      <main className={`${styles.mainBase} ${styles.emptyState}`}>
        <div className={styles.emptyStateText}>
          <h2>Welcome to Luciko</h2>
          <p style={{ marginTop: "10px" }}>Select a chat to start reading.</p>
        </div>
      </main>
    );
  }

  return (
    <main className={`${styles.mainBase} ${styles.chatMain}`}>
      {/* Background could be an image */}
      <div className={styles.header}>
        <div className={styles.headerInfo}>
          <div className={styles.avatar}>
            {activeChat.avatarUrl ? (
              <img
                src={activeChat.avatarUrl}
                alt={activeChat.name}
                className={styles.avatarImage}
              />
            ) : (
              <span className={styles.avatarFallback}>
                {activeChat.name.charAt(0)}
              </span>
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
          messages={messages}
          currentUserId={CURRENT_USER_ID}
          bookmarkedMessageId={bookmarkedMessageId}
          onBookmark={handleBookmark}
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
