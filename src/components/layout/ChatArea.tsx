import { useCallback, useEffect, useRef } from "react";
import type { Chat, Message } from "../../types/chat";
import { MessageList } from "../chat/MessageList";
import styles from "./ChatArea.module.css";

interface ChatAreaProps {
  activeChat: Chat | null | undefined;
  messages: Message[];
  onLoadMore?: () => Promise<number> | number | void;
  hasMore?: boolean;
  onJumpToLatest?: () => Promise<void> | void;
}

const CURRENT_USER_ID = "Valerio Donati";

export function ChatArea({ activeChat, messages, onLoadMore, hasMore, onJumpToLatest }: ChatAreaProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

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

  const handleLoadMore = useCallback(async () => {
    if (!onLoadMore || !messagesRef.current) return;
    const container = messagesRef.current;
    const prevScrollHeight = container.scrollHeight;
    const prevScrollTop = container.scrollTop;
    const added = await onLoadMore();
    if (!added) return;
    requestAnimationFrame(() => {
      const nextScrollHeight = container.scrollHeight;
      container.scrollTop = prevScrollTop + (nextScrollHeight - prevScrollHeight);
    });
  }, [onLoadMore]);

  useEffect(() => {
    if (!onLoadMore || !hasMore) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        handleLoadMore();
      }
    }, { threshold: 1.0 });

    if (sentinelRef.current) {
      observer.observe(sentinelRef.current);
    }

    return () => observer.disconnect();
  }, [handleLoadMore, hasMore, messages.length, onLoadMore]); // Re-observe when messages change
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
      </div>

      <div className={styles.messagesWrapper} ref={messagesRef}>
        {/* Sentinel for infinite scroll (load older messages) */}
        <div ref={sentinelRef} className={styles.sentinel} />
        <MessageList messages={messages} currentUserId={CURRENT_USER_ID} />
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
