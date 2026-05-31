import { useState, useEffect, useCallback } from 'react';
import { HardDrive, Database, RefreshCw } from 'lucide-react';
import { getMessagesCount, getPostsCount } from '../../store/db';
import { getAuthHeaders } from '../../store/auth';
import { TARGET_CHAT_ID } from '../../constants/chat';
import styles from './StorageInfo.module.css';

interface RemoteCounts {
    messages: number;
    posts: number;
}

type FetchState = 'idle' | 'loading' | 'loaded' | 'error';

export function StorageInfo() {
    const [localMessages, setLocalMessages] = useState<number | null>(null);
    const [localPosts, setLocalPosts] = useState<number | null>(null);
    const [remote, setRemote] = useState<RemoteCounts | null>(null);
    const [remoteState, setRemoteState] = useState<FetchState>('idle');
    const [remoteError, setRemoteError] = useState<string>('');

    const fetchLocal = useCallback(async () => {
        try {
            const [msgCount, postCount] = await Promise.all([
                getMessagesCount(TARGET_CHAT_ID),
                getPostsCount(),
            ]);
            setLocalMessages(msgCount);
            setLocalPosts(postCount);
        } catch {
            // IndexedDB unavailable
        }
    }, []);

    const fetchRemote = useCallback(async () => {
        const headers = getAuthHeaders();
        if (!headers.Authorization) {
            setRemoteState('idle');
            return;
        }

        setRemoteState('loading');
        setRemoteError('');

        try {
            const url = `/api/sync/counts?chatId=${encodeURIComponent(TARGET_CHAT_ID)}`;
            const response = await fetch(url, { headers });

            if (!response.ok) {
                if (response.status === 401) {
                    setRemoteState('idle');
                    return;
                }
                throw new Error(`Server returned ${response.status}`);
            }

            const contentType = response.headers.get('Content-Type') || '';
            if (contentType.includes('text/html')) {
                // API not available (e.g., running under npm run dev without wrangler)
                setRemoteState('idle');
                return;
            }

            const data = await response.json() as { ok: boolean; messages: number; posts: number };
            if (data.ok) {
                setRemote({ messages: data.messages, posts: data.posts });
                setRemoteState('loaded');
            }
        } catch (err) {
            setRemoteError(err instanceof Error ? err.message : 'Failed to fetch');
            setRemoteState('error');
        }
    }, []);

    useEffect(() => {
        fetchLocal();
        fetchRemote();
    }, [fetchLocal, fetchRemote]);

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h3 className={styles.title}>Storage</h3>
                <button
                    className={styles.refreshButton}
                    onClick={() => { fetchLocal(); fetchRemote(); }}
                    title="Refresh counts"
                >
                    <RefreshCw size={14} />
                </button>
            </div>

            <div className={styles.grid}>
                {/* Local */}
                <div className={styles.card}>
                    <div className={styles.cardHeader}>
                        <HardDrive size={16} className={styles.cardIcon} />
                        <span className={styles.cardLabel}>Local</span>
                    </div>
                    <div className={styles.counts}>
                        <div className={styles.countRow}>
                            <span className={styles.countLabel}>Messages</span>
                            <span className={styles.countValue}>
                                {localMessages !== null ? localMessages.toLocaleString() : '—'}
                            </span>
                        </div>
                        <div className={styles.countRow}>
                            <span className={styles.countLabel}>Posts</span>
                            <span className={styles.countValue}>
                                {localPosts !== null ? localPosts.toLocaleString() : '—'}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Remote */}
                <div className={styles.card}>
                    <div className={styles.cardHeader}>
                        <Database size={16} className={styles.cardIcon} />
                        <span className={styles.cardLabel}>Remote</span>
                    </div>
                    {remoteState === 'loading' && (
                        <p className={styles.statusText}>Loading...</p>
                    )}
                    {remoteState === 'error' && (
                        <p className={styles.errorText}>{remoteError}</p>
                    )}
                    {remoteState === 'idle' && (
                        <p className={styles.statusText}>Not connected</p>
                    )}
                    {remoteState === 'loaded' && remote && (
                        <div className={styles.counts}>
                            <div className={styles.countRow}>
                                <span className={styles.countLabel}>Messages</span>
                                <span className={styles.countValue}>
                                    {remote.messages.toLocaleString()}
                                </span>
                            </div>
                            <div className={styles.countRow}>
                                <span className={styles.countLabel}>Posts</span>
                                <span className={styles.countValue}>
                                    {remote.posts.toLocaleString()}
                                </span>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
