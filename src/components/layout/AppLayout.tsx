import { useState, useEffect, useCallback } from 'react';
import type { Message } from '../../types/chat';
import { ChatArea } from './ChatArea';
import { ImportPage } from '../import/ImportPage';
import { PostsPage } from '../posts/PostsPage';
import { getMessageOffsetInChat, getMessagesPaginated, getMessagesCount } from '../../store/db';
import { Upload, MessageSquare, Newspaper } from 'lucide-react';
import styles from './AppLayout.module.css';
import { TARGET_CHAT } from '../../constants/chat';

const PAGE_SIZE = 100;

export function AppLayout() {
    const activeChat = TARGET_CHAT;
    const [messages, setMessages] = useState<Message[]>([]);
    const [currentView, setCurrentView] = useState<'chat' | 'import' | 'posts'>('chat');
    const [offset, setOffset] = useState(0);
    const [hasOlder, setHasOlder] = useState(false);
    const [hasNewer, setHasNewer] = useState(false);
    const [totalCount, setTotalCount] = useState(0);
    const [isFetching, setIsFetching] = useState(false);

    const fetchMessages = useCallback(
        (chatId: string, startOffset: number) => getMessagesPaginated(chatId, PAGE_SIZE, startOffset),
        []
    );

    // Initial messages or reset when chat changes
    useEffect(() => {
        const loadInitialMessages = async () => {
            setIsFetching(true);
            try {
                const total = await getMessagesCount(activeChat.id);
                const start = 0;
                const msgs = await fetchMessages(activeChat.id, start);
                setMessages(msgs);
                setOffset(start);
                setTotalCount(total);
                setHasOlder(false);
                setHasNewer(msgs.length < total);
            } catch (error) {
                console.error('Failed to load initial messages:', error);
            } finally {
                setIsFetching(false);
            }
        };

        loadInitialMessages();
    }, [activeChat.id, currentView, fetchMessages]);

    const loadLatestMessages = async () => {
        if (isFetching) return;
        setIsFetching(true);
        try {
            const total = await getMessagesCount(activeChat.id);
            const start = Math.max(0, total - PAGE_SIZE);
            const latest = await fetchMessages(activeChat.id, start);
            setMessages(latest);
            setOffset(start);
            setTotalCount(total);
            setHasOlder(start > 0);
            setHasNewer(start + latest.length < total);
        } catch (error) {
            console.error('Failed to load latest messages:', error);
        } finally {
            setIsFetching(false);
        }
    };

    const loadOlderMessages = async () => {
        if (!hasOlder || isFetching) return 0;

        setIsFetching(true);
        try {
            const nextOffset = Math.max(0, offset - PAGE_SIZE);
            const nextBatch = await fetchMessages(activeChat.id, nextOffset);
            if (nextBatch.length > 0) {
                setMessages(prev => {
                    const existingIds = new Set(prev.map(m => m.id));
                    const uniqueNew = nextBatch.filter(m => !existingIds.has(m.id));
                    return [...uniqueNew, ...prev];
                });
                setOffset(nextOffset);
                setHasOlder(nextOffset > 0);
                setHasNewer(nextOffset + nextBatch.length + messages.length < totalCount);
                return nextBatch.length;
            }
            setHasOlder(false);
            return 0;
        } catch (error) {
            console.error('Failed to load more messages:', error);
            return 0;
        } finally {
            setIsFetching(false);
        }
    };

    const loadNewerMessages = async () => {
        if (!hasNewer || isFetching) return 0;

        setIsFetching(true);
        try {
            const start = offset + messages.length;
            const nextBatch = await fetchMessages(activeChat.id, start);
            if (nextBatch.length > 0) {
                setMessages(prev => {
                    const existingIds = new Set(prev.map(m => m.id));
                    const uniqueNew = nextBatch.filter(m => !existingIds.has(m.id));
                    return [...prev, ...uniqueNew];
                });
                setHasNewer(start + nextBatch.length < totalCount);
                return nextBatch.length;
            }
            setHasNewer(false);
            return 0;
        } catch (error) {
            console.error('Failed to load newer messages:', error);
            return 0;
        } finally {
            setIsFetching(false);
        }
    };

    const jumpToMessage = async (messageId: string): Promise<boolean> => {
        if (isFetching) return false;
        setIsFetching(true);
        try {
            const position = await getMessageOffsetInChat(activeChat.id, messageId);
            if (position === null) {
                return false;
            }
            const total = await getMessagesCount(activeChat.id);
            const start = Math.max(0, Math.min(position - Math.floor(PAGE_SIZE / 2), Math.max(0, total - PAGE_SIZE)));
            const msgs = await fetchMessages(activeChat.id, start);
            setMessages(msgs);
            setOffset(start);
            setTotalCount(total);
            setHasOlder(start > 0);
            setHasNewer(start + msgs.length < total);
            return true;
        } catch (error) {
            console.error('Failed to jump to message:', error);
            return false;
        } finally {
            setIsFetching(false);
        }
    };

    return (
        <div className={styles.container}>
            {/* Header for navigation */}
            <header className={styles.header}>
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                    Luciko
                </div>
                <div className={styles.nav}>
                    <button
                        onClick={() => setCurrentView('chat')}
                        className={`${styles.navButton} ${currentView === 'chat' ? styles.navButtonActive : ''}`}
                    >
                        <MessageSquare size={20} /> Chat
                    </button>
                    <button
                        onClick={() => setCurrentView('posts')}
                        className={`${styles.navButton} ${currentView === 'posts' ? styles.navButtonActive : ''}`}
                    >
                        <Newspaper size={20} /> Posts
                    </button>
                    <button
                        onClick={() => setCurrentView('import')}
                        className={`${styles.navButton} ${currentView === 'import' ? styles.navButtonActive : ''}`}
                    >
                        <Upload size={20} /> Import
                    </button>
                </div>
            </header>

            {/* Main Content */}
            <div className={styles.main}>
                {currentView === 'chat' ? (
                    <ChatArea
                        activeChat={activeChat}
                        messages={messages}
                        onLoadOlder={loadOlderMessages}
                        onLoadNewer={loadNewerMessages}
                        hasOlder={hasOlder}
                        hasNewer={hasNewer}
                        onJumpToLatest={loadLatestMessages}
                        onJumpToBookmark={jumpToMessage}
                    />
                ) : currentView === 'import' ? (
                    <ImportPage />
                ) : (
                    <PostsPage />
                )}
            </div>
        </div>
    );
}
