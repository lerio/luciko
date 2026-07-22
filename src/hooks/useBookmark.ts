/**
 * Bookmark persistence hook — loads a bookmark from IndexedDB on mount and
 * persists changes automatically.
 *
 * Used by {@link ChatArea} (scope = chat ID) and {@link PostsPage}
 * (scope = `"posts"`) to eliminate duplicated load/persist logic.
 *
 * Includes a race-condition guard: if a manual toggle happens while an async
 * load is in-flight, the load result is discarded so it doesn't overwrite
 * the user's explicit action.
 *
 * @module useBookmark
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getBookmark, setBookmark } from '../store/db';
import { markLocalChanged, syncBookmarks } from '../store/archiveSync';

/**
 * Manages a bookmark for a given scope.
 *
 * @param scope - The bookmark key (a chat ID or `"posts"`).
 * @returns The current bookmark state, a toggle setter, and a ready flag.
 */
export function useBookmark(scope: string): {
  bookmarkedId: string | null;
  toggleBookmark: (id: string) => void;
  isReady: boolean;
} {
  const [bookmarkedId, setBookmarkedId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const loadTokenRef = useRef(0);

  // Load bookmark from IndexedDB on mount (or when scope changes).
  useEffect(() => {
    let isActive = true;
    const loadToken = loadTokenRef.current + 1;
    loadTokenRef.current = loadToken;

    const load = async () => {
      try {
        const stored = await getBookmark(scope);
        if (!isActive || loadTokenRef.current !== loadToken) return;
        setBookmarkedId(stored);
      } catch (error) {
        if (!isActive || loadTokenRef.current !== loadToken) return;
        console.warn('Failed to read bookmark from storage:', error);
        setBookmarkedId(null);
      } finally {
        if (isActive && loadTokenRef.current === loadToken) {
          setIsReady(true);
        }
      }
    };

    load();
    return () => {
      isActive = false;
    };
  }, [scope]);

  // Persist bookmark to IndexedDB on change (gated by isReady so initial
  // load doesn't trigger a spurious write).
  useEffect(() => {
    if (!isReady) return;

    const persist = async () => {
      try {
        await setBookmark(scope, bookmarkedId);
        markLocalChanged();
        void syncBookmarks(); // push bookmark change to server immediately
      } catch (error) {
        console.warn('Failed to persist bookmark to storage:', error);
      }
    };

    persist();
  }, [scope, bookmarkedId, isReady]);

  /**
   * Toggles the bookmark for the given id.
   * If already bookmarked, removes it; otherwise sets it.
   */
  const toggleBookmark = useCallback((id: string) => {
    // Invalidate any in-flight load so it won't overwrite this toggle.
    loadTokenRef.current += 1;
    setBookmarkedId((current) => (current === id ? null : id));
  }, []);

  return { bookmarkedId, toggleBookmark, isReady };
}
