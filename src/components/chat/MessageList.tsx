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
            const dateRow = isNewDay ? (
                <div key={`date-${format(msg.timestamp, 'yyyy-MM-dd')}-${msg.id}`} className={styles.dateRow}>
                    <span className={styles.dateChip}>
                        {format(msg.timestamp, 'MMMM d, yyyy')}
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
