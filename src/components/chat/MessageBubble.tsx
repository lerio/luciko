import { useState, useEffect } from "react";
import { format } from "date-fns";
import { Bookmark, Check, CheckCheck, Download } from "lucide-react";
import { getAttachment } from "../../store/db";
import type { Attachment, Message } from "../../types/chat";
import { isGmailGoomojiUrl, resolveGmailGoomoji } from "../../utils/gmailGoomoji";
import { normalizeMojibakeText } from "../../utils/text";
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

interface AttachmentPreviewProps {
  attachment: Attachment;
}

const TRUNCATE_LIMIT = 350;

const formatAttachmentSize = (size: number) => `${(size / 1024).toFixed(1)} KB`;

function AttachmentPreview({ attachment }: AttachmentPreviewProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
  const fileName = normalizeMojibakeText(attachment.fileName) ?? attachment.fileName;

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

  useEffect(() => {
    if (!isImageViewerOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsImageViewerOpen(false);
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isImageViewerOpen]);

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
          <>
            <button
              type="button"
              className={styles.imageButton}
              onClick={() => setIsImageViewerOpen(true)}
              aria-label={`Open image ${fileName}`}
            >
              <img
                src={blobUrl}
                alt={fileName}
                className={`${styles.attachmentMedia} ${styles.attachmentImage}`}
              />
            </button>
            {isImageViewerOpen && (
              <div
                className={styles.imageViewerOverlay}
                onClick={() => setIsImageViewerOpen(false)}
                role="presentation"
              >
                <div
                  className={styles.imageViewerDialog}
                  onClick={(event) => event.stopPropagation()}
                  role="dialog"
                  aria-modal="true"
                  aria-label={fileName}
                >
                  <button
                    type="button"
                    className={styles.imageViewerClose}
                    onClick={() => setIsImageViewerOpen(false)}
                    aria-label="Close image viewer"
                  >
                    ×
                  </button>
                  <img
                    src={blobUrl}
                    alt={fileName}
                    className={styles.imageViewerImage}
                  />
                </div>
              </div>
            )}
          </>
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
            download={fileName}
            className={styles.documentLink}
          >
            <span className={styles.documentIcon}>📄</span>
            <div className={styles.documentInfo}>
              <div className={styles.documentName}>{fileName}</div>
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

function renderContent(content: string, isGmail: boolean) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const gmailGoomojiTokenRegex =
      /(https:\/\/mail\.google\.com\/mail\/e\/[A-Za-z0-9]{3})/g;
    const quoteHeaderRegexes = [
      /^on\s+.+<[^>]+>\s*wrote:\s*$/i,
      /^(il giorno|in data)\s+.+<[^>]+>\s*ha scritto:\s*$/i,
    ];
    const normalizeLineForQuoteMatch = (line: string) =>
      line
        .trim()
        .replace(/^>+\s*/, "")
        .replace(/^"+|"+$/g, "")
        .trim();
    const stripQuotedReply = (text: string) => {
      const lines = text.split("\n");
      let quoteStart = -1;

      for (let i = 0; i < lines.length; i += 1) {
        const l0 = normalizeLineForQuoteMatch(lines[i] ?? "");
        const l1 = normalizeLineForQuoteMatch(lines[i + 1] ?? "");
        const l2 = normalizeLineForQuoteMatch(lines[i + 2] ?? "");

        const joined2 = `${l0} ${l1}`.trim();
        const joined3 = `${l0} ${l1} ${l2}`.trim();
        const windows = [l0, joined2, joined3];

        const isHeader = windows.some((window) =>
          quoteHeaderRegexes.some((regex) => regex.test(window)),
        );

        if (isHeader) {
          quoteStart = i;
          break;
        }

        const startsEnglish = /^on\b/i.test(l0) || /^on\b/i.test(joined2);
        const startsItalian =
          /^(il giorno|in data)\b/i.test(l0) ||
          /^(il giorno|in data)\b/i.test(joined2);
        const endsWithWrote = /^wrote:\s*$/i.test(l0);
        const endsWithHaScritto = /^ha scritto:\s*$/i.test(l0);

        if ((endsWithWrote && startsEnglish) || (endsWithHaScritto && startsItalian)) {
          quoteStart = i;
          break;
        }
      }

      return quoteStart >= 0 ? lines.slice(0, quoteStart).join("\n").trim() : text;
    };

    const splitGmailLineParts = (line: string) => {
      if (!isGmail) return line.split(urlRegex);

      return line.split(gmailGoomojiTokenRegex).flatMap((part) => {
        if (isGmailGoomojiUrl(part)) return [part];
        return part.split(urlRegex).filter((segment) => segment.length > 0);
      });
    };

    const renderLines = (lines: string[], keyPrefix: string) =>
      lines.map((line, lineIndex) => (
        <span key={`${keyPrefix}-line-${lineIndex}`}>
          {splitGmailLineParts(line).map((part, partIndex) => {
            if (part.match(urlRegex)) {
              if (isGmail && isGmailGoomojiUrl(part)) {
                const goomoji = resolveGmailGoomoji(part);
                if (goomoji) {
                  return (
                    <span
                      key={`${keyPrefix}-emoji-${lineIndex}-${partIndex}`}
                      className={styles.gmailInlineEmoji}
                      aria-label={goomoji}
                      role="img"
                    >
                      {goomoji}
                    </span>
                  );
                }

                return (
                  <span
                    key={`${keyPrefix}-emoji-${lineIndex}-${partIndex}`}
                    className={styles.gmailInlineEmoji}
                    aria-hidden="true"
                  />
                );
              }
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
          : "";
      const body =
        separatorIndex >= 0
          ? content.slice(separatorIndex + 2)
          : content;
      const cleanedBody = stripQuotedReply(body);
      const bodyLines = cleanedBody.split("\n");

      return (
        <>
          {subject && (
            <>
              <strong>{subject}</strong>
              <br />
              <br />
            </>
          )}
          {renderLines(bodyLines, "gmail")}
        </>
      );
    }

    const lines = content.split("\n");
    return renderLines(lines, "default");
}

export function MessageBubble({
  message,
  isMe,
  isBookmarked,
  onBookmark,
}: MessageBubbleProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const content = normalizeMojibakeText(message.content) ?? message.content;
  const senderName = normalizeMojibakeText(message.senderId) ?? message.senderId;
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
