import { useState, useEffect, useCallback } from 'react';
import type { Chat, Message } from '../../types/chat';
import { ChatArea } from './ChatArea';
import { ImportPage } from '../import/ImportPage';
import { getChats, getMessagesPaginated, getMessagesCount, initDB } from '../../store/db';
import { Upload, MessageSquare } from 'lucide-react';
import styles from './AppLayout.module.css';

const PAGE_SIZE = 100;

export function AppLayout() {
    const [activeChat, setActiveChat] = useState<Chat | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [currentView, setCurrentView] = useState<'chat' | 'import'>('chat');
    const [offset, setOffset] = useState(0);
    const [hasMore, setHasMore] = useState(false); // Initialize to false
    const [isFetching, setIsFetching] = useState(false);

    const fetchMessages = useCallback(
        (chatId: string, startOffset: number) => getMessagesPaginated(chatId, PAGE_SIZE, startOffset),
        []
    );

    // Initial load of chats
    useEffect(() => {
        const loadData = async () => {
            try {
                await initDB();
                const loadedChats = await getChats();
                setActiveChat(loadedChats[0] ?? null);
            } catch (error) {
                console.error('Failed to load data:', error);
            } finally {
                setIsLoading(false);
            }
        };

        loadData();
    }, [currentView]);

    // Initial messages or reset when chat changes
    useEffect(() => {
        if (!activeChat) return;

        const loadInitialMessages = async () => {
            setIsFetching(true);
            try {
                const msgs = await fetchMessages(activeChat.id, 0);
                setMessages(msgs);
                setOffset(msgs.length);
                setHasMore(msgs.length === PAGE_SIZE);
            } catch (error) {
                console.error('Failed to load initial messages:', error);
            } finally {
                setIsFetching(false);
            }
        };

        loadInitialMessages();
    }, [activeChat, currentView, fetchMessages]);

    const loadLatestMessages = async () => {
        if (!activeChat || isFetching) return;
        setIsFetching(true);
        try {
            const total = await getMessagesCount(activeChat.id);
            const start = Math.max(0, total - PAGE_SIZE);
            const latest = await fetchMessages(activeChat.id, start);
            setMessages(latest);
            setOffset(start + latest.length);
            setHasMore(start > 0);
        } catch (error) {
            console.error('Failed to load latest messages:', error);
        } finally {
            setIsFetching(false);
        }
    };

    const loadMoreMessages = async () => {
        if (!activeChat || !hasMore || isFetching) return 0;

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
                setHasMore(nextOffset > 0);
                return nextBatch.length;
            }
            setHasMore(false);
            return 0;
        } catch (error) {
            console.error('Failed to load more messages:', error);
            return 0;
        } finally {
            setIsFetching(false);
        }
    };

    if (isLoading) {
        return (
            <div className={`${styles.fullScreen} ${styles.centered}`}>
                Loading Luciko...
            </div>
        );
    }

    if (!activeChat && currentView === 'chat') {
        return (
            <div className={`${styles.fullScreen} ${styles.centered} ${styles.emptyState}`}>
                <div style={{ fontSize: '18px' }}>No chat history found.</div>
                <button
                    onClick={() => setCurrentView('import')}
                    className={styles.ctaButton}
                >
                    Go to Import
                </button>
            </div>
        );
    }

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
                        onLoadMore={loadMoreMessages}
                        hasMore={hasMore}
                        onJumpToLatest={loadLatestMessages}
                    />
                ) : (
                    <ImportPage />
                )}
            </div>
        </div>
    );
}
