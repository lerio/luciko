/**
 * Full-text search page with scope tabs and result navigation.
 *
 * Features:
 * - **Debounced search** — Typing triggers a search after 200ms of inactivity.
 * - **Scope tabs** — "All" (messages + posts), "Chat" (messages only), or
 *   "Posts" (posts only). Changing scope re-runs the current query.
 * - **Result display** — Messages and posts are shown in separate sections
 *   with counts. Each result card shows metadata (sender/author, timestamp,
 *   source) and a text excerpt with the matching term highlighted.
 * - **Click-to-navigate** — Clicking a result calls `onOpenMessage` or
 *   `onOpenPost`, which switches the main view to Chat or Posts and jumps
 *   to the specific item.
 *
 * @module SearchPage
 */

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import styles from './SearchPage.module.css';
import { searchMessages, searchPosts, type MessageSearchResult, type PostSearchResult } from '../../store/search';

type SearchScope = 'all' | 'chat' | 'posts';

interface SearchPageProps {
    onOpenMessage: (messageId: string) => void;
    onOpenPost: (postId: string) => void;
}

/**
 * Full-text search page component.
 *
 * Searches the local IndexedDB archive for messages and/or posts matching
 * the user's query, with results split by type and clickable to navigate
 * to the source item in the Chat or Posts view.
 */
export function SearchPage({ onOpenMessage, onOpenPost }: SearchPageProps) {
    const [query, setQuery] = useState('');
    const [scope, setScope] = useState<SearchScope>('all');
    const [messageResults, setMessageResults] = useState<MessageSearchResult[]>([]);
    const [postResults, setPostResults] = useState<PostSearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    const trimmedQuery = useMemo(() => query.trim(), [query]);

    useEffect(() => {
        let isActive = true;

        if (trimmedQuery.length === 0) {
            const resetId = window.setTimeout(() => {
                if (!isActive) return;
                setMessageResults([]);
                setPostResults([]);
                setIsSearching(false);
            }, 0);
            return () => {
                isActive = false;
                window.clearTimeout(resetId);
            };
        }

        const timeoutId = window.setTimeout(async () => {
            try {
                setIsSearching(true);
                const [nextMessages, nextPosts] = await Promise.all([
                    scope === 'posts' ? Promise.resolve([]) : searchMessages(trimmedQuery, 60),
                    scope === 'chat' ? Promise.resolve([]) : searchPosts(trimmedQuery, 60),
                ]);

                if (!isActive) return;
                setMessageResults(nextMessages);
                setPostResults(nextPosts);
            } catch (error) {
                console.error('Failed to search archive:', error);
                if (isActive) {
                    setMessageResults([]);
                    setPostResults([]);
                }
            } finally {
                if (isActive) {
                    setIsSearching(false);
                }
            }
        }, 200);

        return () => {
            isActive = false;
            window.clearTimeout(timeoutId);
        };
    }, [scope, trimmedQuery]);

    const messageCount = messageResults.length;
    const postCount = postResults.length;

    return (
        <div className={styles.page}>
            <div className={styles.header}>
                <div className={styles.titleRow}>
                    <div>
                        <h1 className={styles.title}>Search</h1>
                        <p className={styles.subtitle}>Search your local archive across chats and posts.</p>
                    </div>
                    <div className={styles.scopeGroup} role="tablist" aria-label="Search scope">
                        {(['all', 'chat', 'posts'] as SearchScope[]).map((nextScope) => (
                            <button
                                key={nextScope}
                                type="button"
                                className={`${styles.scopeButton} ${scope === nextScope ? styles.scopeButtonActive : ''}`}
                                onClick={() => setScope(nextScope)}
                            >
                                {nextScope === 'all' ? 'All' : nextScope === 'chat' ? 'Chat' : 'Posts'}
                            </button>
                        ))}
                    </div>
                </div>
                <div className={styles.searchBar}>
                    <input
                        className={styles.searchInput}
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search messages, senders, captions, filenames..."
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>
            </div>

            <div className={styles.content}>
                {trimmedQuery.length === 0 ? (
                    <div className={styles.state}>
                        Start typing to search the full local archive.
                    </div>
                ) : isSearching ? (
                    <div className={styles.state}>Searching local data...</div>
                ) : (
                    <>
                        {scope !== 'posts' && (
                            <section className={styles.section}>
                                <h2 className={styles.sectionTitle}>
                                    Messages <span className={styles.sectionCount}>{messageCount}</span>
                                </h2>
                                {messageCount === 0 ? (
                                    <div className={styles.empty}>No message matches.</div>
                                ) : (
                                    <div className={styles.resultList}>
                                        {messageResults.map((result) => (
                                            <button
                                                key={result.message.id}
                                                type="button"
                                                className={styles.resultCard}
                                                onClick={() => onOpenMessage(result.message.id)}
                                            >
                                                <div className={styles.resultMeta}>
                                                    <span className={styles.badge}>Message</span>
                                                    <span>{result.message.senderId}</span>
                                                    <span>{format(result.message.timestamp, 'MMM d, yyyy • HH:mm')}</span>
                                                </div>
                                                <p className={styles.excerpt}>{result.excerpt || result.message.content}</p>
                                                <div className={styles.details}>
                                                    <span>Chat: {result.message.chatId}</span>
                                                    {result.message.source && <span>Source: {result.message.source}</span>}
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </section>
                        )}

                        {scope !== 'chat' && (
                            <section className={styles.section}>
                                <h2 className={styles.sectionTitle}>
                                    Posts <span className={styles.sectionCount}>{postCount}</span>
                                </h2>
                                {postCount === 0 ? (
                                    <div className={styles.empty}>No post matches.</div>
                                ) : (
                                    <div className={styles.resultList}>
                                        {postResults.map((result) => (
                                            <button
                                                key={result.post.id}
                                                type="button"
                                                className={styles.resultCard}
                                                onClick={() => onOpenPost(result.post.id)}
                                            >
                                                <div className={styles.resultMeta}>
                                                    <span className={styles.badge}>Post</span>
                                                    <span>{result.post.authorName ?? 'Unknown author'}</span>
                                                    <span>{format(new Date(result.post.timestamp * 1000), 'MMM d, yyyy • HH:mm')}</span>
                                                </div>
                                                <p className={styles.excerpt}>{result.excerpt || result.post.text || result.post.activity || 'Media-only post'}</p>
                                                <div className={styles.details}>
                                                    <span>Source: {result.post.source}</span>
                                                    {result.post.linkUrl && <span>{result.post.linkUrl}</span>}
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </section>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
