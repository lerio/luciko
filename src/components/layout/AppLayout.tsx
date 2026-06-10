/**
 * Main application layout — navigation, view routing, and cloud sync orchestration.
 *
 * Responsibilities:
 * - Renders the top navigation bar with Chat / Search / Import tabs and a logout button.
 * - Manages view state (`chat | search | import | posts`) and routes to the correct page.
 * - Handles chat message pagination via a {@link paginationReducer} (infinite scroll).
 * - Pings `/api/health` on mount and every 5 minutes to track cloud connectivity.
 * - Triggers the initial `syncAll()` pull/push cycle once the cloud is reachable.
 * - Coordinates focus requests from Search → Chat and Search → Posts.
 *
 * @module AppLayout
 */

import { useState, useEffect, useCallback, useReducer, useRef } from 'react';
import type { Message } from '../../types/chat';
import { ChatArea } from './ChatArea';
import { ImportPage } from '../import/ImportPage';
import { PostsPage } from '../posts/PostsPage';
import { getMessageOffsetInChat, getMessagesPaginated, getMessagesCount } from '../../store/db';
import { Upload, MessageSquare, Search, LogOut, Cloud, CloudOff, RefreshCw } from 'lucide-react';
import styles from './AppLayout.module.css';
import { TARGET_CHAT } from '../../constants/chat';
import { SearchPage } from '../search/SearchPage';
import { useAuth, getAuthHeaders } from '../../contexts/AuthContext';
import { syncAll } from '../../store/archiveSync';

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

/**
 * Reducer for the chat message pagination window.
 *
 * Manages a sliding window of messages with support for loading older pages,
 * loading newer pages, resetting, and jumping to a specific position.
 * Deduplicates messages by id when merging batches.
 */
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

/**
 * Top-level layout component.
 *
 * Manages cloud connectivity polling, initial sync, view switching,
 * and chat message pagination. Acts as the primary coordinator between
 * the navigation UI and the page components.
 */
export function AppLayout() {
    const activeChat = TARGET_CHAT;
    const [pagination, dispatch] = useReducer(paginationReducer, initialPagination);
    const { messages, offset, hasOlder, hasNewer, isFetching } = pagination;
    const [currentView, setCurrentView] = useState<'chat' | 'import' | 'posts' | 'search'>('chat');
    const [messageFocusRequest, setMessageFocusRequest] = useState<{ messageId: string; token: number } | null>(null);
    const [postFocusRequest, setPostFocusRequest] = useState<{ postId: string; token: number } | null>(null);
    const [cloudStatus, setCloudStatus] = useState<'loading' | 'syncing' | 'ready' | 'offline'>('loading');
    const initialSyncDoneRef = useRef(false);

    const fetchMessages = useCallback(
        (chatId: string, startOffset: number) => getMessagesPaginated(chatId, PAGE_SIZE, startOffset),
        []
    );

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

                if (!isActive) {
                    return;
                }

                const msgs = await fetchMessages(activeChat.id, 0);
                dispatch({ type: 'RESET', msgs, total });
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
        let timer: ReturnType<typeof setInterval>;

        const check = async () => {
            try {
                const response = await fetch('/api/health', { cache: 'no-store', headers: getAuthHeaders() });
                if (!isActive) return;
                if (response.ok) {
                    // Trigger initial pull sync if not done yet
                    if (!initialSyncDoneRef.current) {
                        initialSyncDoneRef.current = true;
                        setCloudStatus('syncing');
                        void syncAll().finally(() => {
                            if (isActive) {
                                setCloudStatus('ready');
                            }
                        });
                    } else {
                        setCloudStatus('ready');
                    }
                } else {
                    setCloudStatus('offline');
                }
            } catch {
                if (isActive) {
                    setCloudStatus('offline');
                }
            }
        };

        // Initial check
        void check();

        // Re-check every 5 minutes
        timer = setInterval(check, 5 * 60_000);

        // Also check on online/offline browser events
        const handleOnline = () => { void check(); };
        const handleOffline = () => { if (isActive) setCloudStatus('offline'); };
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        return () => {
            isActive = false;
            clearInterval(timer);
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    const { logout } = useAuth();

    const handleLogout = async () => {
        await logout();
    };

    return (
        <div className={styles.container}>
            {/* Header for navigation */}
            <header className={styles.header}>
                <div className={styles.brand}>
                    <span className={styles.brandTitle}>Luciko</span>
                    {cloudStatus === 'syncing' ? (
                        <RefreshCw size={18} className={styles.syncIcon} />
                    ) : cloudStatus === 'ready' ? (
                        <Cloud size={18} className={styles.cloudIcon} />
                    ) : cloudStatus === 'offline' ? (
                        <CloudOff size={18} className={styles.cloudIcon} />
                    ) : (
                        <Cloud size={18} className={styles.cloudIconLoading} />
                    )}
                </div>
                <div className={styles.nav}>
                    <button
                        onClick={() => {
                            setCurrentView('chat');
                        }}
                        className={`${styles.navButton} ${currentView === 'chat' ? styles.navButtonActive : ''}`}
                    >
                        <MessageSquare size={20} /> <span className={styles.navLabel}>Chat</span>
                    </button>
                    <button
                        onClick={() => setCurrentView('search')}
                        className={`${styles.navButton} ${currentView === 'search' ? styles.navButtonActive : ''}`}
                    >
                        <Search size={20} /> <span className={styles.navLabel}>Search</span>
                    </button>
                    <button
                        onClick={() => setCurrentView('import')}
                        className={`${styles.navButton} ${currentView === 'import' ? styles.navButtonActive : ''}`}
                    >
                        <Upload size={20} /> <span className={styles.navLabel}>Import</span>
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
