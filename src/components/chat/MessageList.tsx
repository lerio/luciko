/**
 * Renders a list of messages with automatic date separators.
 *
 * Iterates through messages and inserts a date chip whenever the day
 * changes between consecutive messages. Each message is rendered via
 * {@link MessageBubble}, receiving `isMe` based on whether its sender
 * matches `currentUserId`.
 *
 * Date markers carry `data-date-marker="true"` and `data-date-label`
 * attributes so the parent {@link ChatArea} can implement sticky date
 * headers by hiding the in-flow marker that matches the current sticky label.
 *
 * @module MessageList
 */

import type { Message } from '../../types/chat';
import { MessageBubble } from './MessageBubble';
import { format, isSameDay } from 'date-fns';
import type { ReactNode } from 'react';
import styles from './MessageList.module.css';

interface MessageListProps {
    messages: Message[];
    currentUserId: string;
    bookmarkedMessageId: string | null;
    onBookmark: (messageId: string) => void;
}

export function MessageList({ messages, currentUserId, bookmarkedMessageId, onBookmark }: MessageListProps) {
    const { nodes } = messages.reduce(
        (acc, msg) => {
            const isNewDay = !acc.lastDate || !isSameDay(acc.lastDate, msg.timestamp);
            const dateKey = format(msg.timestamp, 'yyyy-MM-dd');
            const dateLabel = format(msg.timestamp, 'MMMM d, yyyy');
            const dateRow = isNewDay ? (
                <div
                    key={`date-${dateKey}-${msg.id}`}
                    className={styles.dateRow}
                    data-date-marker="true"
                    data-date-key={dateKey}
                    data-date-label={dateLabel}
                >
                    <span className={styles.dateChip}>
                        {dateLabel}
                    </span>
                </div>
            ) : null;

            const bubble = (
                <MessageBubble
                    key={msg.id}
                    message={msg}
                    isMe={msg.senderId === currentUserId}
                    isBookmarked={bookmarkedMessageId === msg.id}
                    onBookmark={onBookmark}
                />
            );

            return {
                nodes: dateRow ? [...acc.nodes, dateRow, bubble] : [...acc.nodes, bubble],
                lastDate: msg.timestamp
            };
        },
        { nodes: [] as ReactNode[], lastDate: null as Date | null }
    );

    return (
        <>
            {nodes}
        </>
    );
}
