/**
 * Luciko application entry point.
 *
 * Bootstraps the React app into the DOM and exposes debug helpers on
 * `window.__luciko` for manual IndexedDB deduplication from the browser console.
 *
 * @module main
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import App from './App.tsx'
import { deduplicateLocalMessages, countUniqueExternalIds, getMessagesCount } from './store/db'
import { TARGET_CHAT_ID } from './constants/chat'

// Expose debug helpers on window for manual invocation from the browser console.
// Usage: await window.__luciko.dedup()
declare global {
  interface Window {
    __luciko?: {
      dedup: () => Promise<{ before: number; unique: number; removed: number; after: number }>;
      countDups: () => Promise<{ total: number; unique: number; duplicates: number }>;
    };
  }
}

window.__luciko = {
  async dedup() {
    const before = await getMessagesCount(TARGET_CHAT_ID);
    const unique = await countUniqueExternalIds();
    const removed = await deduplicateLocalMessages(TARGET_CHAT_ID);
    const after = await getMessagesCount(TARGET_CHAT_ID);
    console.log('[__luciko.dedup] before:', before, 'unique:', unique, 'removed:', removed, 'after:', after);
    return { before, unique, removed, after };
  },
  async countDups() {
    const total = await getMessagesCount(TARGET_CHAT_ID);
    const unique = await countUniqueExternalIds();
    const duplicates = total - unique;
    console.log('[__luciko.countDups] total:', total, 'unique:', unique, 'duplicates:', duplicates);
    return { total, unique, duplicates };
  },
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
