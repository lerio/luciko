/**
 * Renders a single chat message as a chat-style bubble.
 *
 * Features:
 * - **Attachment previews** — Delegates to {@link AttachmentPreview} which
 *   loads blobs from IndexedDB (with R2 fallback) and renders images
 *   (click-to-lightbox), videos, audio players, and document download links.
 * - **Quoted replies** — Renders a reply bubble showing the quoted sender
 *   and text above the main message content.
 * - **Reactions** — Displays emoji reaction chips with counts.
 * - **Source badge** — Shows the originating platform's logo (WhatsApp,
 *   Facebook, Gmail, etc.) on the side of the bubble.
 * - **Gmail rendering** — Delegates to {@link renderMessageContent} which
 *   bolds the subject line, strips quoted reply chains, and resolves
 *   goomoji image references to Unicode emoji.
 * - **Truncation** — Long messages (>350 chars) are collapsed with a "more"
 *   button.
 * - **Message status** — Shows single or double checkmarks for sent/read status
 *   on the current user's messages.
 * - **Bookmark button** — Toggle bookmark on/off for the message.
 *
 * @module MessageBubble
 */

import { useState } from "react";
import { format } from "date-fns";
import { Bookmark, Check, CheckCheck } from "lucide-react";
import type { Attachment, Message } from "../../types/chat";
import { normalizeMojibakeText } from "../../utils/text";
import { AttachmentPreview } from "./AttachmentPreview";
import { renderMessageContent } from "./renderMessageContent";
import styles from "./MessageBubble.module.css";
import whatsappLogo from "../../assets/whatsapp.png";
import facebookLogo from "../../assets/facebook-messenger.svg";
import instagramLogo from "../../assets/instagram.png";
import googleChatLogo from "../../assets/google-chat.png";
import imessageLogo from "../../assets/imessage.png";
import gmailLogo from "../../assets/gmail.webp";

interface MessageBubbleProps {
  message: Message;
  isMe: boolean;
  isBookmarked: boolean;
  onBookmark: (messageId: string) => void;
}

const TRUNCATE_LIMIT = 350;

/**
 * Renders a single chat message bubble.
 *
 * Layout varies by sender:
 * - **Other person's messages** — aligned left with source badge and bookmark
 *   button on the left side.
 * - **Current user's messages** — aligned right with controls on the right side
 *   and delivery status checkmarks.
 */
export function MessageBubble({
  message,
  isMe,
  isBookmarked,
  onBookmark,
}: MessageBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const content = normalizeMojibakeText(message.content) ?? message.content;

  const quotedText = normalizeMojibakeText(message.quotedText);
  const quotedSender = normalizeMojibakeText(message.quotedSender);
  const hasAudioAttachment = Boolean(
    message.attachments?.some((attachment) => attachment.type === "audio"),
  );
  const shouldTruncate = content.length > TRUNCATE_LIMIT && !isExpanded;
  const displayContent = shouldTruncate
    ? content.substring(0, TRUNCATE_LIMIT) + "..."
    : content;
  const sourceLogo = (() => {
    switch (message.source) {
      case "whatsapp":
        return { src: whatsappLogo, alt: "WhatsApp" };
      case "facebook":
        return { src: facebookLogo, alt: "Facebook Messenger" };
      case "instagram":
        return { src: instagramLogo, alt: "Instagram" };
      case "googlechat":
        return { src: googleChatLogo, alt: "Google Chat" };
      case "googlechat_old":
        return { src: googleChatLogo, alt: "Google Chat" };
      case "imessage":
        return { src: imessageLogo, alt: "iMessage" };
      case "gmail":
        return { src: gmailLogo, alt: "Gmail" };
      default:
        return null;
    }
  })();


  return (
    <div
      id={`message-${message.id}`}
      className={`${styles.messageContainer} ${message.reactions && message.reactions.length > 0 ? styles.messageContainerWithReactions : ""} ${isMe ? styles.messageContainerMe : styles.messageContainerOther}`}
    >
      <div
        className={`${styles.messageRow} ${isMe ? styles.messageRowMe : styles.messageRowOther}`}
      >
        {!isMe && (
          <div className={styles.sideControls}>
            {sourceLogo && (
              <span
                className={`${styles.sourceBadge} ${styles[`sourceBadge_${message.source ?? "unknown"}`]}`}
              >
                <img
                  src={sourceLogo.src}
                  alt={`${sourceLogo.alt} logo`}
                  className={styles.sourceLogo}
                />
              </span>
            )}
            <div className={styles.actionStack}>
              <button
                type="button"
                className={`${styles.bookmarkButton} ${isBookmarked ? styles.bookmarkButtonActive : ""}`}
                onClick={() => onBookmark(message.id)}
                aria-label={isBookmarked ? "Remove bookmark" : "Add bookmark"}
              >
                <Bookmark size={14} />
              </button>
            </div>
          </div>
        )}
        <div
          className={`${styles.bubbleBase} ${isMe ? styles.bubbleMe : styles.bubbleOther} ${hasAudioAttachment ? styles.bubbleWithAudio : ""}`}
        >
          <div className={styles.messageContent}>
            {quotedText && (
              <div
                className={`${styles.replyBubble} ${isMe ? styles.replyBubbleMe : styles.replyBubbleOther}`}
              >
                <div className={styles.replyLabel}>
                  {quotedSender || "Reply"}
                </div>
                <div className={styles.replyText}>{quotedText}</div>
              </div>
            )}
            {/* Attachments */}
            {message.attachments &&
              message.attachments.map((att: Attachment) => (
                <AttachmentPreview key={att.id} attachment={att} />
              ))}
            {renderMessageContent(displayContent, message.source === "gmail")}
            {shouldTruncate && (
              <button
                onClick={() => setIsExpanded(true)}
                className={styles.moreButton}
              >
                more
              </button>
            )}
          </div>
          <div className={styles.metaRow}>
            <span className={styles.timestamp}>
              {format(message.timestamp, "HH:mm")}
            </span>
            {isMe && (
              <span
                className={
                  message.status === "read"
                    ? styles.statusRead
                    : styles.statusSent
                }
              >
                {message.status === "read" ? (
                  <CheckCheck size={14} />
                ) : (
                  <Check size={14} />
                )}
              </span>
            )}
          </div>
          {message.reactions && message.reactions.length > 0 && (
            <div
              className={`${styles.reactionsRow} ${isMe ? styles.reactionsRowMe : styles.reactionsRowOther}`}
            >
              {message.reactions.map((reaction, index) => (
                <div key={`${reaction.emoji}-${index}`} className={styles.reactionChip}>
                  <span className={styles.reactionEmoji}>{reaction.emoji}</span>
                  {reaction.count > 1 && (
                    <span className={styles.reactionCount}>
                      {reaction.count}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {isMe && (
          <div className={styles.sideControls}>
            {sourceLogo && (
              <span
                className={`${styles.sourceBadge} ${styles[`sourceBadge_${message.source ?? "unknown"}`]}`}
              >
                <img
                  src={sourceLogo.src}
                  alt={`${sourceLogo.alt} logo`}
                  className={styles.sourceLogo}
                />
              </span>
            )}
            <div className={styles.actionStack}>
              <button
                type="button"
                className={`${styles.bookmarkButton} ${isBookmarked ? styles.bookmarkButtonActive : ""}`}
                onClick={() => onBookmark(message.id)}
                aria-label={isBookmarked ? "Remove bookmark" : "Add bookmark"}
              >
                <Bookmark size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
