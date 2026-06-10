/**
 * Renders message text content with URL auto-linking and Gmail-specific handling.
 *
 * For Gmail messages:
 * - Extracts and bolds the subject line (text before the first `\n\n`).
 * - Strips quoted reply chains in both English ("On ... wrote:") and
 *   Italian ("Il giorno ... ha scritto:") variants.
 * - Resolves goomoji image URLs (`https://mail.google.com/mail/e/<CODE>`)
 *   to inline Unicode emoji via {@link resolveGmailGoomoji}.
 *
 * For all other messages, URLs are converted to clickable `<a>` links with
 * `target="_blank"` and `rel="noreferrer"`.
 *
 * @module renderMessageContent
 */

import type { ReactNode } from "react";
import { isGmailGoomojiUrl, resolveGmailGoomoji } from "../../utils/gmailGoomoji";
import styles from "./MessageBubble.module.css";

/**
 * Renders message text content as React nodes.
 *
 * @param content - The raw message content string.
 * @param isGmail - Whether the message source is Gmail (enables special rendering).
 * @returns React nodes representing the parsed content.
 */
export function renderMessageContent(
  content: string,
  isGmail: boolean,
): ReactNode {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const gmailGoomojiTokenRegex =
    /(https:\/\/mail\.google\.com\/mail\/e\/[A-Za-z0-9]{3})/g;
  const quoteHeaderRegexes = [
    /^on\s+.+<[^>]+>\s*wrote:\s*$/i,
    /^(il giorno|in data)\s+.+<[^>]+>\s*ha scritto:\s*$/i,
  ];

  /** Normalizes a line for quote-header detection by stripping prefixes. */
  const normalizeLineForQuoteMatch = (line: string) =>
    line
      .trim()
      .replace(/^>+\s*/, "")
      .replace(/^"+|"+$/g, "")
      .trim();

  /**
   * Strips trailing quoted reply chains from email bodies.
   *
   * Detects both single-line ("On Date, Name <email> wrote:") and multi-line
   * patterns where the header spans 2-3 lines. Supports English and Italian
   * quote formats.
   */
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

  /** Splits a line into parts, separating URLs from plain text. */
  const splitGmailLineParts = (line: string) => {
    if (!isGmail) return line.split(urlRegex);

    return line.split(gmailGoomojiTokenRegex).flatMap((part) => {
      if (isGmailGoomojiUrl(part)) return [part];
      return part.split(urlRegex).filter((segment) => segment.length > 0);
    });
  };

  /** Renders an array of text lines, auto-linking URLs and resolving goomoji. */
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
