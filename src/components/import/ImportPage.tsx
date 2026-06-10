/**
 * Import page — drag-and-drop file upload with auto-detection and cloud sync.
 *
 * Features:
 * - **Auto-detection** — Probes the uploaded file against a registry of 8
 *   import handlers, each with a `detect` function that inspects ZIP contents
 *   or file extensions. See {@link HANDLERS}.
 * - **Parse → Import → Sync pipeline** — Once the format is detected, the file
 *   is parsed by the matching handler, the results are imported into IndexedDB
 *   via {@link importMessages} or {@link importPosts}, and newly-inserted items
 *   are handed off to {@link syncNewItems} for background cloud upload.
 * - **Progress feedback** — Shows import stats (total, inserted, updated,
 *   duplicates skipped) and live cloud sync progress via
 *   {@link onSyncProgress}.
 * - **Storage info** — Renders {@link StorageInfo} to show local vs remote
 *   item counts.
 * - **Debug logs** — Parser logs are displayed in a collapsible section for
 *   troubleshooting.
 *
 * @module ImportPage
 */

import { useState, useRef, useEffect } from 'react';
import type { ChangeEvent } from 'react';
import { Upload, CheckCircle, AlertCircle, Cloud, CloudOff } from 'lucide-react';
import JSZip from 'jszip';
import { parseWhatsAppZip } from '../../importers/whatsapp/parser';
import { parseFacebookZip, parseInstagramZip } from '../../importers/facebook/parser';
import { parseFacebookPostsZip } from '../../importers/facebook/posts';
import { parseGoogleChatZip } from '../../importers/googlechat/parser';
import { parseOldGoogleChatCsv } from '../../importers/googlechat/oldCsv';
import { parseIMessageJson } from '../../importers/imessage/parser';
import { parseGmailZip } from '../../importers/gmail/parser';
import { importMessages, importPosts, type ImportStats } from '../../store/db';
import { syncNewItems, onSyncProgress, getSyncProgress, markLocalChanged, type SyncProgress } from '../../store/archiveSync';
import { StorageInfo } from './StorageInfo';
import { TARGET_CHAT_ID } from '../../constants/chat';
import styles from './ImportPage.module.css';

type ImportType =
    | 'whatsapp'
    | 'gmail'
    | 'instagram'
    | 'facebook'
    | 'facebook_posts'
    | 'googlechat'
    | 'googlechat_old'
    | 'imessage';

type DetectResult = { handler: ImportHandler; zip?: JSZip };

type ImportResult =
    | Awaited<ReturnType<typeof parseWhatsAppZip>>
    | Awaited<ReturnType<typeof parseFacebookPostsZip>>;

const isPostsResult = (result: ImportResult): result is Awaited<ReturnType<typeof parseFacebookPostsZip>> =>
    'posts' in result;

type ImportHandler = {
    type: ImportType;
    requiresZip?: boolean;
    detect: (file: File, zip?: JSZip) => Promise<boolean> | boolean;
    parse: (file: File, chatId: string, zip?: JSZip) => Promise<ImportResult>;
};

/**
 * Ordered list of import format handlers.
 *
 * Each handler provides a `detect` function (called with the file and
 * optionally a pre-loaded JSZip instance) and a `parse` function that
 * converts the file into messages or posts. Handlers are tried in order;
 * the first match wins.
 *
 * Order matters: more specific detectors (e.g., iMessage JSON structure)
 * come before broader ones (e.g., generic CSV extension match).
 */
const HANDLERS: ImportHandler[] = [
    {
        type: 'imessage',
        detect: async (file) => {
            if (!file.name.toLowerCase().endsWith('.json')) return false;
            const text = await file.text();
            try {
                const parsed = JSON.parse(text);
                return Boolean(parsed && Array.isArray(parsed.messages) && parsed.messages.some((m: Record<string, unknown>) => 'is_from_me' in m));
            } catch {
                return false;
            }
        },
        parse: (file, chatId) => parseIMessageJson(file, chatId)
    },
    {
        type: 'googlechat_old',
        detect: (file) => file.name.toLowerCase().endsWith('.csv'),
        parse: (file, chatId) => parseOldGoogleChatCsv(file, chatId)
    },
    {
        type: 'whatsapp',
        requiresZip: true,
        detect: (_file, zip) => Boolean(zip?.file(/@.+\.csv$/i).length),
        parse: (file, chatId, zip) => parseWhatsAppZip(file, chatId, zip)
    },
    {
        type: 'gmail',
        requiresZip: true,
        detect: (_file, zip) => Boolean(zip?.file(/emails\.csv$/i).length),
        parse: (file, chatId, zip) => parseGmailZip(file, chatId, zip)
    },
    {
        type: 'instagram',
        requiresZip: true,
        detect: async (_file, zip) => {
            const messageFiles = zip?.file(/message_\d+\.html$/i) ?? [];
            if (!messageFiles.length) return false;
            const sample = await messageFiles[0].async('string');
            return sample.includes('Instagram-Logo') || sample.includes('instagram.com');
        },
        parse: (file, chatId, zip) => parseInstagramZip(file, chatId, zip)
    },
    {
        type: 'facebook_posts',
        requiresZip: true,
        detect: (_file, zip) => Boolean(zip?.file(/posts\/your_posts__check_ins__photos_and_videos_\d+\.json$/i).length),
        parse: (file, _chatId, zip) => parseFacebookPostsZip(file, zip)
    },
    {
        type: 'facebook',
        requiresZip: true,
        detect: (_file, zip) => Boolean(zip?.file(/message_\d+\.html$/i).length),
        parse: (file, chatId, zip) => parseFacebookZip(file, chatId, zip)
    },
    {
        type: 'googlechat',
        requiresZip: true,
        detect: (_file, zip) => Boolean(zip?.file(/messages\.json$/i).length),
        parse: (file, chatId, zip) => parseGoogleChatZip(file, chatId, zip)
    }
];

/**
 * Import page component.
 *
 * Renders a drag-and-drop upload zone, handles file detection/parsing/import,
 * triggers background cloud sync, and displays progress feedback.
 */
export function ImportPage() {
    const [isDragging, setIsDragging] = useState(false);
    const [importStatus, setImportStatus] = useState<'idle' | 'processing' | 'success' | 'error'>('idle');
    const [stats, setStats] = useState<{ total: number; sourceTotal?: number; inserted: number; updated: number }>({
        total: 0,
        inserted: 0,
        updated: 0
    });
    const [errorMessage, setErrorMessage] = useState<string>('');
    const [logs, setLogs] = useState<string[]>([]);
    const [syncProgress, setSyncProgress] = useState<SyncProgress>(() => getSyncProgress());
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Subscribe to sync progress — initial state is already set via useState initializer
    useEffect(() => {
        return onSyncProgress(setSyncProgress);
    }, []);

    const setDragging = (value: boolean) => (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(value);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) {
            handleFile(file);
        }
    };

    const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            handleFile(file);
        }
    };

    const detectImportType = async (file: File): Promise<DetectResult | null> => {
        const isZip = file.name.toLowerCase().endsWith('.zip');
        let zip: JSZip | undefined;

        for (const handler of HANDLERS) {
            if (handler.requiresZip && !isZip) {
                continue;
            }
            if (handler.requiresZip && !zip) {
                try {
                    zip = await JSZip.loadAsync(file);
                } catch {
                    return null;
                }
            }
            const matched = await handler.detect(file, zip);
            if (matched) {
                return { handler, zip };
            }
        }

        return null;
    };

    const handleFile = async (file: File) => {
        setImportStatus('processing');
        setErrorMessage('');

        try {
            const detected = await detectImportType(file);
            if (!detected) {
                if (file.name.toLowerCase().endsWith('.zip')) {
                    const zip = await JSZip.loadAsync(file);
                    const names = Object.keys(zip.files).slice(0, 20).join(', ');
                    throw new Error(`Unsupported import file format. Zip entries: ${names}`);
                }
                throw new Error('Unsupported import file format.');
            }
            const { handler, zip } = detected;
            const result = await handler.parse(file, TARGET_CHAT_ID, zip);
            let importStats: ImportStats = { inserted: 0, updated: 0 };
            const totalCount = isPostsResult(result)
                ? result.posts.length
                : result.messages.length;
            const combinedLogs: string[] = result.logs || [];
            if (isPostsResult(result)) {
                importStats = await importPosts(result.posts);
            } else {
                importStats = await importMessages(result.messages);
            }

            setStats({
                total: totalCount,
                sourceTotal: 'sourceItemCount' in result ? result.sourceItemCount : undefined,
                inserted: importStats.inserted,
                updated: importStats.updated
            });
            setLogs(combinedLogs);
            setImportStatus('success');
            markLocalChanged();

            // Start remote sync in background (fire-and-forget)
            console.log('[ImportPage] importStats:', { inserted: importStats.inserted, updated: importStats.updated, insertedIdsLen: importStats.insertedIds?.length });
            if (importStats.inserted > 0 && importStats.insertedIds && importStats.insertedIds.length > 0) {
                const isPosts = isPostsResult(result);
                const allItems: Array<{ id: string; externalId?: string; [key: string]: unknown }> =
                    isPosts
                        ? result.posts as unknown as Array<{ id: string; externalId?: string; [key: string]: unknown }>
                        : result.messages as unknown as Array<{ id: string; externalId?: string; [key: string]: unknown }>;

                const insertedIdSet = new Set(importStats.insertedIds);
                const insertedItems = allItems.filter(item => insertedIdSet.has(item.id));

                console.log('[ImportPage] Starting sync:', { entity: isPosts ? 'posts' : 'messages', insertedItems: insertedItems.length });
                if (insertedItems.length > 0) {
                    void syncNewItems(isPosts ? 'posts' : 'messages', insertedItems);
                }
            } else {
                console.log('[ImportPage] Sync skipped — no inserted items');
            }

        } catch (error: unknown) {
            console.error('Import failed:', error);
            const message = error instanceof Error ? error.message : 'Unknown error occurred';
            setErrorMessage(message);
            setImportStatus('error');
        }
    };

    return (
        <div className={styles.page}>
            <h1 className={styles.title}>Import</h1>

            <div
                onDragOver={setDragging(true)}
                onDragLeave={setDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`${styles.dropzone} ${isDragging ? styles.dropzoneDragging : ''}`}
            >
                <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    accept=".zip"
                    style={{ display: 'none' }}
                />

                <Upload size={48} color="var(--color-text-secondary)" style={{ marginBottom: '16px' }} />
                <p className={styles.dropzoneText}>
                    Click or drag an export (.zip) here
                </p>
                <p className={styles.dropzoneSubtext}>
                    Supports chats, posts, and media attachments
                </p>
            </div>

            {importStatus === 'processing' && (
                <div style={{ marginTop: '30px', textAlign: 'center' }}>
                    <p>Processing import...</p>
                </div>
            )}

            {importStatus === 'success' && (
                <div className={`${styles.statusBase} ${styles.statusSuccess}`}>
                    <CheckCircle size={24} color="var(--color-primary)" className={styles.statusIcon} />
                    <div>
                        <h3 style={{ marginBottom: '4px' }}>Import Successful</h3>
                        <p>
                            Processed {stats.total} items
                            {stats.sourceTotal && stats.sourceTotal !== stats.total ? ` from ${stats.sourceTotal} source rows` : ''}.
                            {' '}Imported {stats.inserted} new items.
                            {stats.updated > 0 ? ` Updated ${stats.updated} existing items.` : ''}
                            {' '}{stats.total - stats.inserted - stats.updated} duplicates skipped.
                        </p>
                    </div>
                </div>
            )}

            {importStatus === 'error' && (
                <div className={`${styles.statusBase} ${styles.statusError}`}>
                    <AlertCircle size={24} color="#d32f2f" className={styles.statusIcon} />
                    <div>
                        <h3 style={{ marginBottom: '4px', color: '#d32f2f' }}>Import Failed</h3>
                        <p>{errorMessage}</p>
                    </div>
                </div>
            )}

            {/* Debug: always show sync state */}
            <div style={{ marginTop: '10px', fontSize: '11px', color: '#999', textAlign: 'center' }}>
                [sync: {syncProgress.phase} | items: {syncProgress.totalItems} | chunks: {syncProgress.uploadedChunks}/{syncProgress.totalChunks}]
            </div>

            {/* Sync progress — visible during background upload */}
            {syncProgress.phase !== 'idle' && (
                <div className={`${styles.syncStatus} ${syncProgress.phase === 'done' ? styles.syncDone : syncProgress.phase === 'error' || syncProgress.phase === 'skipped_offline' ? styles.syncWarning : ''}`}>
                    {syncProgress.phase === 'checking' && (
                        <div className={styles.syncContent}>
                            <Cloud size={20} className={styles.syncIcon} />
                            <div>
                                <h3 className={styles.syncTitle}>Checking cloud storage...</h3>
                                <p className={styles.syncDetail}>
                                    Verifying {syncProgress.totalItems} items against remote database
                                </p>
                            </div>
                        </div>
                    )}

                    {syncProgress.phase === 'uploading' && (
                        <div className={styles.syncContent}>
                            <Cloud size={20} className={styles.syncIcon} />
                            <div className={styles.syncBody}>
                                <h3 className={styles.syncTitle}>Uploading to cloud...</h3>
                                <p className={styles.syncDetail}>
                                    Chunk {syncProgress.uploadedChunks} of {syncProgress.totalChunks}
                                    {syncProgress.insertedRemote > 0 && ` (${syncProgress.insertedRemote} items uploaded)`}
                                </p>
                                {syncProgress.totalChunks > 0 && (
                                    <div className={styles.progressBar}>
                                        <div
                                            className={styles.progressFill}
                                            style={{
                                                width: `${(syncProgress.uploadedChunks / syncProgress.totalChunks) * 100}%`
                                            }}
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {syncProgress.phase === 'done' && (
                        <div className={styles.syncContent}>
                            <CheckCircle size={20} color="var(--color-primary)" className={styles.syncIcon} />
                            <div>
                                <h3 className={styles.syncTitle}>Cloud Sync Complete</h3>
                                <p className={styles.syncDetail}>
                                    Uploaded {syncProgress.insertedRemote} items to cloud storage
                                </p>
                            </div>
                        </div>
                    )}

                    {syncProgress.phase === 'skipped_offline' && (
                        <div className={styles.syncContent}>
                            <CloudOff size={20} color="#856404" className={styles.syncIcon} />
                            <div>
                                <h3 className={styles.syncTitle} style={{ color: '#856404' }}>Cloud Sync Skipped</h3>
                                <p className={styles.syncDetail}>
                                    Cloud storage is not available. Your data is saved locally.
                                </p>
                                <p className={styles.syncHint}>
                                    Items will be synced automatically when the server becomes available.
                                </p>
                            </div>
                        </div>
                    )}

                    {syncProgress.phase === 'error' && (
                        <div className={styles.syncContent}>
                            <AlertCircle size={20} color="#d32f2f" className={styles.syncIcon} />
                            <div>
                                <h3 className={styles.syncTitle} style={{ color: '#d32f2f' }}>Cloud Sync Failed</h3>
                                <p className={styles.syncDetail}>{syncProgress.error || 'Unknown error'}</p>
                                <p className={styles.syncHint}>
                                    Your data is saved locally. You can retry by importing again.
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            )}

            <StorageInfo />

            {logs.length > 0 && (
                <div className={styles.logsWrapper}>
                    <h3>Debug Logs</h3>
                    <div className={styles.logsBody}>
                        {logs.map((log, i) => <div key={i}>{log}</div>)}
                    </div>
                </div>
            )}
        </div>
    );
}
