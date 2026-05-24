import { useState, useEffect, useCallback, useReducer } from 'react';
import type { Message } from '../../types/chat';
import { ChatArea } from './ChatArea';
import { ImportPage } from '../import/ImportPage';
import { PostsPage } from '../posts/PostsPage';
import { getMessageOffsetInChat, getMessagesPaginated, getMessagesCount } from '../../store/db';
import { Upload, MessageSquare, Newspaper, Search, LogOut } from 'lucide-react';
import styles from './AppLayout.module.css';
import { TARGET_CHAT } from '../../constants/chat';
import { SearchPage } from '../search/SearchPage';
import { hydrateLocalArchiveFromServer } from '../../store/archiveSync';
import { logout } from '../../store/auth';

const PAGE_SIZE = 100;

interface PaginationState {
    messages: Message[];
    offset: number;
    hasOlder: boolean;
    hasNewer: boolean;
    totalCount: number;
    isFetching: boolean;
}

type PaginationAction =
    | { type: 'SET_FETCHING'; fetching: boolean }
    | { type: 'RESET'; msgs: Message[]; total: number }
    | { type: 'LOADED_OLDER'; prevMessages: Message[]; nextOffset: number }
    | { type: 'LOADED_NEWER'; prevMessages: Message[] }
    | { type: 'JUMPED'; msgs: Message[]; start: number; total: number }
    | { type: 'NO_MORE_OLDER' }
    | { type: 'NO_MORE_NEWER' };

function paginationReducer(state: PaginationState, action: PaginationAction): PaginationState {
    switch (action.type) {
        case 'SET_FETCHING':
            return { ...state, isFetching: action.fetching };
        case 'RESET':
            return {
                messages: action.msgs,
                offset: 0,
                hasOlder: false,
                hasNewer: action.msgs.length < action.total,
                totalCount: action.total,
                isFetching: false,
            };
        case 'LOADED_OLDER': {
            const existingIds = new Set(state.messages.map(m => m.id));
            const uniqueNew = action.prevMessages.filter(m => !existingIds.has(m.id));
            const merged = [...uniqueNew, ...state.messages];
            return {
                ...state,
                messages: merged,
                offset: action.nextOffset,
                hasOlder: action.nextOffset > 0,
                hasNewer: action.nextOffset + merged.length < state.totalCount,
                isFetching: false,
            };
        }
        case 'LOADED_NEWER': {
            const existingIds = new Set(state.messages.map(m => m.id));
            const uniqueNew = action.prevMessages.filter(m => !existingIds.has(m.id));
            const merged = [...state.messages, ...uniqueNew];
            return {
                ...state,
                messages: merged,
                hasNewer: state.offset + merged.length < state.totalCount,
                isFetching: false,
            };
        }
        case 'JUMPED':
            return {
                messages: action.msgs,
                offset: action.start,
                hasOlder: action.start > 0,
                hasNewer: action.start + action.msgs.length < action.total,
                totalCount: action.total,
                isFetching: false,
            };
        case 'NO_MORE_OLDER':
            return { ...state, hasOlder: false, isFetching: false };
        case 'NO_MORE_NEWER':
            return { ...state, hasNewer: false, isFetching: false };
    }
}

const initialPagination: PaginationState = {
    messages: [],
    offset: 0,
    hasOlder: false,
    hasNewer: false,
    totalCount: 0,
    isFetching: false,
};

export function AppLayout() {
    const activeChat = TARGET_CHAT;
    const [pagination, dispatch] = useReducer(paginationReducer, initialPagination);
    const { messages, offset, hasOlder, hasNewer, isFetching } = pagination;
    const [currentView, setCurrentView] = useState<'chat' | 'import' | 'posts' | 'search'>('chat');
    const [chatRefreshToken, setChatRefreshToken] = useState(0);
    const [messageFocusRequest, setMessageFocusRequest] = useState<{ messageId: string; token: number } | null>(null);
    const [postFocusRequest, setPostFocusRequest] = useState<{ postId: string; token: number } | null>(null);
    const [cloudStatus, setCloudStatus] = useState<'loading' | 'ready' | 'offline'>('loading');
    const [syncStatus, setSyncStatus] = useState<'syncing' | 'synced' | 'error' | null>(null);

    const fetchMessages = useCallback(
        (chatId: string, startOffset: number) => getMessagesPaginated(chatId, PAGE_SIZE, startOffset),
        []
    );

    const syncArchive = useCallback(async (force = false) => {
        if (!force && currentView !== 'chat') {
            return;
        }

        try {
            setSyncStatus('syncing');
            console.info('Archive sync: pulling from server');
            const imported = await hydrateLocalArchiveFromServer();
            if (!imported) {
                console.info('Archive sync: nothing available on the server yet.');
                setSyncStatus('synced');
                return;
            }

            const refreshedTotal = await getMessagesCount(activeChat.id);
            const msgs = await fetchMessages(activeChat.id, 0);
            dispatch({ type: 'RESET', msgs, total: refreshedTotal });
            console.info(`Archive sync: hydrated ${refreshedTotal} messages from the server.`);
            setSyncStatus('synced');
        } catch (error) {
            console.error('Failed to sync archive:', error);
            setSyncStatus('error');
        }
    }, [activeChat.id, currentView, fetchMessages]);

    // Initial messages load
    useEffect(() => {
        let isActive = true;
        const loadInitialMessages = async () => {
            if (currentView !== 'chat' || messages.length > 0) {
                return;
            }
            dispatch({ type: 'SET_FETCHING', fetching: true });
            try {
                const total = await getMessagesCount(activeChat.id);
                if (total === 0) {
                    await hydrateLocalArchiveFromServer();
                }

                if (!isActive) {
                    return;
                }

                const refreshedTotal = await getMessagesCount(activeChat.id);
                const msgs = await fetchMessages(activeChat.id, 0);
                dispatch({ type: 'RESET', msgs, total: refreshedTotal });
            } catch (error) {
                console.error('Failed to load initial messages:', error);
                if (isActive) {
                    dispatch({ type: 'SET_FETCHING', fetching: false });
                }
            }
        };

        loadInitialMessages();
        return () => {
            isActive = false;
        };
    }, [activeChat.id, currentView, fetchMessages, messages.length]);

    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            void syncArchive();
        }, 0);

        return () => {
            window.clearTimeout(timeoutId);
        };
    }, [chatRefreshToken, syncArchive]);

    const loadLatestMessages = async () => {
        if (isFetching) return;
        dispatch({ type: 'SET_FETCHING', fetching: true });
        try {
            const total = await getMessagesCount(activeChat.id);
            const start = Math.max(0, total - PAGE_SIZE);
            const latest = await fetchMessages(activeChat.id, start);
            dispatch({ type: 'JUMPED', msgs: latest, start, total });
        } catch (error) {
            console.error('Failed to load latest messages:', error);
            dispatch({ type: 'SET_FETCHING', fetching: false });
        }
    };

    const loadOlderMessages = async () => {
        if (!hasOlder || isFetching) return 0;

        dispatch({ type: 'SET_FETCHING', fetching: true });
        try {
            const nextOffset = Math.max(0, offset - PAGE_SIZE);
            const nextBatch = await fetchMessages(activeChat.id, nextOffset);
            if (nextBatch.length > 0) {
                dispatch({ type: 'LOADED_OLDER', prevMessages: nextBatch, nextOffset });
                return nextBatch.length;
            }
            dispatch({ type: 'NO_MORE_OLDER' });
            return 0;
        } catch (error) {
            console.error('Failed to load more messages:', error);
            dispatch({ type: 'SET_FETCHING', fetching: false });
            return 0;
        }
    };

    const loadNewerMessages = async () => {
        if (!hasNewer || isFetching) return 0;

        dispatch({ type: 'SET_FETCHING', fetching: true });
        try {
            const start = offset + messages.length;
            const nextBatch = await fetchMessages(activeChat.id, start);
            if (nextBatch.length > 0) {
                dispatch({ type: 'LOADED_NEWER', prevMessages: nextBatch });
                return nextBatch.length;
            }
            dispatch({ type: 'NO_MORE_NEWER' });
            return 0;
        } catch (error) {
            console.error('Failed to load newer messages:', error);
            dispatch({ type: 'SET_FETCHING', fetching: false });
            return 0;
        }
    };

    const jumpToMessage = async (messageId: string): Promise<boolean> => {
        if (isFetching) return false;
        dispatch({ type: 'SET_FETCHING', fetching: true });
        try {
            const position = await getMessageOffsetInChat(activeChat.id, messageId);
            if (position === null) {
                dispatch({ type: 'SET_FETCHING', fetching: false });
                return false;
            }
            const total = await getMessagesCount(activeChat.id);
            const start = Math.max(0, Math.min(position - Math.floor(PAGE_SIZE / 2), Math.max(0, total - PAGE_SIZE)));
            const msgs = await fetchMessages(activeChat.id, start);
            dispatch({ type: 'JUMPED', msgs, start, total });
            return true;
        } catch (error) {
            console.error('Failed to jump to message:', error);
            dispatch({ type: 'SET_FETCHING', fetching: false });
            return false;
        }
    };

    const openMessageResult = (messageId: string) => {
        setMessageFocusRequest({ messageId, token: Date.now() });
        setChatRefreshToken((token) => token + 1);
        setCurrentView('chat');
    };

    const openPostResult = (postId: string) => {
        setPostFocusRequest({ postId, token: Date.now() });
        setCurrentView('posts');
    };

    const handleMessageFocusHandled = useCallback(() => {
        setMessageFocusRequest(null);
    }, []);

    const handlePostFocusHandled = useCallback(() => {
        setPostFocusRequest(null);
    }, []);

    useEffect(() => {
        let isActive = true;
        const timeoutId = window.setTimeout(async () => {
            try {
                const response = await fetch('/api/health', { cache: 'no-store' });
                if (!isActive) return;
                setCloudStatus(response.ok ? 'ready' : 'offline');
            } catch {
                if (isActive) {
                    setCloudStatus('offline');
                }
            }
        }, 0);

        return () => {
            isActive = false;
            window.clearTimeout(timeoutId);
        };
    }, []);

    useEffect(() => {
        if (!syncStatus) return;
        const timeoutId = window.setTimeout(() => setSyncStatus(null), 5000);
        return () => window.clearTimeout(timeoutId);
    }, [syncStatus]);

    const handleLogout = async () => {
        await logout();
        window.location.reload();
    };

    return (
        <div className={styles.container}>
            {/* Header for navigation */}
            <header className={styles.header}>
                <div className={styles.brand}>
                    <span className={styles.brandTitle}>Luciko</span>
                    <span className={`${styles.cloudStatus} ${cloudStatus === 'ready' ? styles.cloudStatusReady : cloudStatus === 'offline' ? styles.cloudStatusOffline : styles.cloudStatusLoading}`}>
                        {cloudStatus === 'ready' ? 'Cloud ready' : cloudStatus === 'offline' ? 'Offline mode' : 'Connecting'}
                    </span>
                    {syncStatus && (
                        <span className={`${styles.syncStatus} ${syncStatus === 'error' ? styles.syncStatusError : styles.syncStatusSuccess}`}>
                            {syncStatus === 'syncing' ? 'Syncing...' : syncStatus === 'synced' ? 'Synced' : 'Sync failed'}
                        </span>
                    )}
                </div>
                <div className={styles.nav}>
                    <button
                        onClick={() => {
                            setChatRefreshToken((token) => token + 1);
                            setCurrentView('chat');
                            void syncArchive(true);
                        }}
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
                        onClick={() => setCurrentView('search')}
                        className={`${styles.navButton} ${currentView === 'search' ? styles.navButtonActive : ''}`}
                    >
                        <Search size={20} /> Search
                    </button>
                    <button
                        onClick={() => setCurrentView('import')}
                        className={`${styles.navButton} ${currentView === 'import' ? styles.navButtonActive : ''}`}
                    >
                        <Upload size={20} /> Import
                    </button>
                    <button
                        onClick={handleLogout}
                        className={styles.navButton}
                        title="Log out"
                    >
                        <LogOut size={20} />
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
                        focusRequest={messageFocusRequest}
                        onFocusRequestHandled={handleMessageFocusHandled}
                    />
                ) : currentView === 'import' ? (
                    <ImportPage />
                ) : currentView === 'search' ? (
                    <SearchPage
                        onOpenMessage={openMessageResult}
                        onOpenPost={openPostResult}
                    />
                ) : (
                    <PostsPage
                        focusRequest={postFocusRequest}
                        onFocusRequestHandled={handlePostFocusHandled}
                    />
                )}
            </div>
        </div>
    );
}
