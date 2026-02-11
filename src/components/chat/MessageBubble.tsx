import { useState, useEffect } from "react";
import { format } from "date-fns";
import { Bookmark, Check, CheckCheck, Download, EyeOff } from "lucide-react";
import { getAttachment } from "../../store/db";
import type { Attachment, Message } from "../../types/chat";
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
  isHidden: boolean;
  onBookmark: (messageId: string) => void;
  onToggleHidden: (messageId: string) => void;
}

interface AttachmentPreviewProps {
  attachment: Attachment;
}

const TRUNCATE_LIMIT = 350;

const formatAttachmentSize = (size: number) => `${(size / 1024).toFixed(1)} KB`;

function AttachmentPreview({ attachment }: AttachmentPreviewProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let url: string | null = null;

    const loadBlob = async () => {
      try {
        const blob = await getAttachment(attachment.id);
        if (blob) {
          url = URL.createObjectURL(blob);
          setBlobUrl(url);
        }
      } catch (error) {
        console.error("Failed to load attachment blob:", error);
      } finally {
        setIsLoading(false);
      }
    };

    loadBlob();

    return () => {
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [attachment.id]);

  if (isLoading) {
    return (
      <div
        className={`${styles.attachmentStatus} ${styles.attachmentStatusLoading}`}
      >
        Loading attachment...
      </div>
    );
  }

  if (!blobUrl) {
    return (
      <div
        className={`${styles.attachmentStatus} ${styles.attachmentStatusError}`}
      >
        Error loading file
      </div>
    );
  }

  const attachmentContent = (() => {
    switch (attachment.type) {
      case "image":
        return (
          <img
            src={blobUrl}
            alt={attachment.fileName}
            className={`${styles.attachmentMedia} ${styles.attachmentImage}`}
          />
        );
      case "video":
        return (
          <video src={blobUrl} controls className={styles.attachmentMedia} />
        );
      case "audio":
        return (
          <div className={styles.audioWrapper}>
            <audio
              src={blobUrl}
              controls
              className={styles.audioPlayer}
              controlsList="nodownload noplaybackrate"
            />
          </div>
        );
      case "document":
        return (
          <a
            href={blobUrl}
            download={attachment.fileName}
            className={styles.documentLink}
          >
            <span className={styles.documentIcon}>📄</span>
            <div className={styles.documentInfo}>
              <div className={styles.documentName}>{attachment.fileName}</div>
              {attachment.size && (
                <div className={styles.documentSize}>
                  {formatAttachmentSize(attachment.size)}
                </div>
              )}
            </div>
            <Download size={16} className={styles.documentDownloadIcon} />
          </a>
        );
      default:
        return null;
    }
  })();

  return <div className={styles.attachmentWrapper}>{attachmentContent}</div>;
}

export function MessageBubble({
  message,
  isMe,
  isBookmarked,
  isHidden,
  onBookmark,
  onToggleHidden,
}: MessageBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const shouldTruncate = message.content.length > TRUNCATE_LIMIT && !isExpanded;
  const displayContent = shouldTruncate
    ? message.content.substring(0, TRUNCATE_LIMIT) + "..."
    : message.content;
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

  const renderContent = (content: string, isGmail: boolean) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;

    const renderLines = (lines: string[], keyPrefix: string) =>
      lines.map((line, lineIndex) => (
        <span key={`${keyPrefix}-line-${lineIndex}`}>
          {line.split(urlRegex).map((part, partIndex) => {
            if (part.match(urlRegex)) {
              return (
                <a
                  key={`${keyPrefix}-link-${lineIndex}-${partIndex}`}
                  href={part}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.messageLink}
                >
                  {part}
                </a>
              );
            }
            return (
              <span key={`${keyPrefix}-text-${lineIndex}-${partIndex}`}>
                {part}
              </span>
            );
          })}
          {lineIndex < lines.length - 1 && <br />}
        </span>
      ));

    if (isGmail) {
      const separatorIndex = content.indexOf("\n\n");
      const subject =
        separatorIndex >= 0
          ? content.slice(0, separatorIndex)
          : content.split("\n")[0] || "";
      const body =
        separatorIndex >= 0
          ? content.slice(separatorIndex + 2)
          : content.split("\n").slice(1).join("\n");
      const bodyLines = body.split("\n");

      return (
        <>
          <strong>{subject}</strong>
          <br />
          <br />
          {renderLines(bodyLines, "gmail")}
        </>
      );
    }

    const lines = content.split("\n");
    return renderLines(lines, "default");
  };

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
              <button
                type="button"
                className={`${styles.bookmarkButton} ${isHidden ? styles.hideButtonActive : ""}`}
                onClick={() => onToggleHidden(message.id)}
                aria-label={isHidden ? "Unhide message" : "Hide message"}
              >
                <EyeOff size={14} />
              </button>
            </div>
          </div>
        )}
        <div
          className={`${styles.bubbleBase} ${isMe ? styles.bubbleMe : styles.bubbleOther}`}
        >
          <div className={styles.messageContent}>
            {/* Sender Name (if not me, or always if debugging) */}
            {!isMe && (
              <div className={styles.senderName}>{message.senderId}</div>
            )}
            {message.quotedText && (
              <div
                className={`${styles.replyBubble} ${isMe ? styles.replyBubbleMe : styles.replyBubbleOther}`}
              >
                <div className={styles.replyLabel}>
                  {message.quotedSender || "Reply"}
                </div>
                <div className={styles.replyText}>{message.quotedText}</div>
              </div>
            )}
            {/* Attachments */}
            {message.attachments &&
              message.attachments.map((att: Attachment) => (
                <AttachmentPreview key={att.id} attachment={att} />
              ))}
            {renderContent(displayContent, message.source === "gmail")}
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
              {message.reactions.map((reaction) => (
                <div key={reaction.emoji} className={styles.reactionChip}>
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
              <button
                type="button"
                className={`${styles.bookmarkButton} ${isHidden ? styles.hideButtonActive : ""}`}
                onClick={() => onToggleHidden(message.id)}
                aria-label={isHidden ? "Unhide message" : "Hide message"}
              >
                <EyeOff size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
