import { useState, useEffect } from "react";
import { format } from "date-fns";
import { Check, CheckCheck, Download } from "lucide-react";
import { getAttachment } from "../../store/db";
import type { Attachment, Message } from "../../types/chat";
import styles from "./MessageBubble.module.css";

interface MessageBubbleProps {
  message: Message;
  isMe: boolean;
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
      <div className={`${styles.attachmentStatus} ${styles.attachmentStatusLoading}`}>
        Loading attachment...
      </div>
    );
  }

  if (!blobUrl) {
    return (
      <div className={`${styles.attachmentStatus} ${styles.attachmentStatusError}`}>
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
          <video
            src={blobUrl}
            controls
            className={styles.attachmentMedia}
          />
        );
      case "audio":
        return (
          <div className={styles.audioWrapper}>
            <audio
              src={blobUrl}
              controls
              className={styles.audioPlayer}
              controlsList="nodownload noplaybackrate"
              disablePictureInPicture
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

  return (
    <div className={styles.attachmentWrapper}>{attachmentContent}</div>
  );
}

export function MessageBubble({ message, isMe }: MessageBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const shouldTruncate = message.content.length > TRUNCATE_LIMIT && !isExpanded;
  const displayContent = shouldTruncate
    ? message.content.substring(0, TRUNCATE_LIMIT) + "..."
    : message.content;

  return (
    <div
      className={`${styles.messageContainer} ${message.reactions && message.reactions.length > 0 ? styles.messageContainerWithReactions : ''} ${isMe ? styles.messageContainerMe : styles.messageContainerOther}`}
    >
      <div
        className={`${styles.bubbleBase} ${isMe ? styles.bubbleMe : styles.bubbleOther}`}
      >
        <div className={styles.messageContent}>
          {/* Sender Name (if not me, or always if debugging) */}
          {!isMe && (
            <div className={styles.senderName}>
              {message.senderId}
            </div>
          )}
          {message.quotedText && (
            <div className={`${styles.replyBubble} ${isMe ? styles.replyBubbleMe : styles.replyBubbleOther}`}>
              <div className={styles.replyLabel}>{message.quotedSender || 'Reply'}</div>
              <div className={styles.replyText}>{message.quotedText}</div>
            </div>
          )}
          {/* Attachments */}
          {message.attachments &&
            message.attachments.map((att: Attachment) => (
              <AttachmentPreview key={att.id} attachment={att} />
            ))}
          {displayContent}
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
          <span className={styles.timestamp}>{format(message.timestamp, "HH:mm")}</span>
          {isMe && (
            <span
              className={message.status === "read" ? styles.statusRead : styles.statusSent}
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
          <div className={`${styles.reactionsRow} ${isMe ? styles.reactionsRowMe : styles.reactionsRowOther}`}>
            {message.reactions.map((reaction) => (
              <div key={reaction.emoji} className={styles.reactionChip}>
                <span className={styles.reactionEmoji}>{reaction.emoji}</span>
                {reaction.count > 1 && (
                  <span className={styles.reactionCount}>{reaction.count}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
