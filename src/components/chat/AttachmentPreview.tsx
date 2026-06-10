/**
 * Renders a single message attachment (image, video, audio, or document).
 *
 * Loads the blob from IndexedDB (with transparent R2 fallback via
 * {@link getAttachment}), creates an object URL, and renders the appropriate
 * media element:
 * - **Images** — Thumbnail that opens a full-screen lightbox on click.
 *   Lightbox closes on Escape, overlay click, or close button.
 * - **Videos** — HTML5 `<video>` player with controls.
 * - **Audio** — HTML5 `<audio>` player with controls (download disabled).
 * - **Documents** — Download link with file icon, name, and size.
 *
 * Handles loading and error states. Cleans up object URLs on unmount.
 *
 * @module AttachmentPreview
 */

import { useState, useEffect } from "react";
import { Download } from "lucide-react";
import { getAttachment } from "../../store/db";
import type { Attachment } from "../../types/chat";
import { normalizeMojibakeText } from "../../utils/text";
import styles from "./MessageBubble.module.css";

interface AttachmentPreviewProps {
  attachment: Attachment;
}

/** Formats a byte size as KB with one decimal place. */
const formatAttachmentSize = (size: number) => `${(size / 1024).toFixed(1)} KB`;

/**
 * Loads and renders a single attachment (image, video, audio, or document).
 *
 * Fetches the blob from IndexedDB (with transparent R2 fallback via
 * {@link getAttachment}), creates an object URL, and renders the appropriate
 * media element. Images open in a full-screen lightbox on click.
 */
export function AttachmentPreview({ attachment }: AttachmentPreviewProps) {
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
