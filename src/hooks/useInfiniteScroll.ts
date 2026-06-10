/**
 * Infinite scroll hook using two IntersectionObserver sentinels.
 *
 * Sets up observers on top and bottom sentinel elements within a scroll
 * container. When the top sentinel enters the viewport, `onLoadOlder` is
 * called (if `hasOlder` is true). When the bottom sentinel enters, the
 * `onLoadNewer` callback is fired (if `hasNewer` is true).
 *
 * Used by {@link ChatArea} and {@link PostsPage} — eliminates ~30 lines of
 * duplicated IntersectionObserver setup/teardown per component.
 *
 * Observers use `rootMargin: "200px 0px"` so loading begins 200px before
 * the sentinel becomes visible, providing a smooth infinite-scroll feel.
 *
 * @module useInfiniteScroll
 */

import { useEffect, type RefObject } from 'react';

interface UseInfiniteScrollOptions {
  /** The scrollable container element. */
  rootRef: RefObject<HTMLElement | null>;
  /** Sentinel element placed at the top of the list. */
  topSentinelRef: RefObject<HTMLElement | null>;
  /** Sentinel element placed at the bottom of the list. */
  bottomSentinelRef: RefObject<HTMLElement | null>;
  /** Whether older content is available to load. */
  hasOlder: boolean;
  /** Whether newer content is available to load. */
  hasNewer: boolean;
  /** Called when the top sentinel intersects (load older/previous page). */
  onLoadOlder: () => void;
  /** Called when the bottom sentinel intersects (load newer/next page). */
  onLoadNewer: () => void;
}

/**
 * Attaches IntersectionObservers to the top and bottom sentinel elements.
 *
 * Observers are re-created whenever the relevant `has*` flag or callback
 * changes. The dependency arrays intentionally include callback identities
 * so that the parent can wrap them in `useCallback` for stability.
 */
export function useInfiniteScroll({
  rootRef,
  topSentinelRef,
  bottomSentinelRef,
  hasOlder,
  hasNewer,
  onLoadOlder,
  onLoadNewer,
}: UseInfiniteScrollOptions): void {
  // Top sentinel — load older content.
  useEffect(() => {
    if (!hasOlder) return;
    const root = rootRef.current;
    if (!root || !topSentinelRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onLoadOlder();
        }
      },
      { root, rootMargin: '200px 0px', threshold: 0 },
    );

    observer.observe(topSentinelRef.current);
    return () => observer.disconnect();
  }, [hasOlder, onLoadOlder, rootRef, topSentinelRef]);

  // Bottom sentinel — load newer content.
  useEffect(() => {
    if (!hasNewer) return;
    const root = rootRef.current;
    if (!root || !bottomSentinelRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onLoadNewer();
        }
      },
      { root, rootMargin: '200px 0px', threshold: 0 },
    );

    observer.observe(bottomSentinelRef.current);
    return () => observer.disconnect();
  }, [hasNewer, onLoadNewer, rootRef, bottomSentinelRef]);
}
