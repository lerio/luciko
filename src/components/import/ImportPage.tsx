import { useState, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { Upload, CheckCircle, AlertCircle } from 'lucide-react';
import JSZip from 'jszip';
import { parseWhatsAppZip } from '../../importers/whatsapp/parser';
import { parseFacebookZip, parseInstagramZip } from '../../importers/facebook/parser';
import { parseFacebookPostsZip } from '../../importers/facebook/posts';
import { parseGoogleChatZip } from '../../importers/googlechat/parser';
import { parseOldGoogleChatCsv } from '../../importers/googlechat/oldCsv';
import { parseIMessageJson } from '../../importers/imessage/parser';
import { parseGmailZip } from '../../importers/gmail/parser';
import { importMessages, importPosts } from '../../store/db';
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

export function ImportPage() {
    const [isDragging, setIsDragging] = useState(false);
    const [importStatus, setImportStatus] = useState<'idle' | 'processing' | 'success' | 'error'>('idle');
    const [stats, setStats] = useState<{ total: number; imported: number }>({ total: 0, imported: 0 });
    const [errorMessage, setErrorMessage] = useState<string>('');
    const [logs, setLogs] = useState<string[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

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
            let importedCount = 0;
            const totalCount = isPostsResult(result)
                ? result.posts.length
                : result.messages.length;
            const combinedLogs: string[] = result.logs || [];
            if (isPostsResult(result)) {
                importedCount = await importPosts(result.posts);
            } else {
                importedCount = await importMessages(result.messages);
            }

            setStats({
                total: totalCount,
                imported: importedCount
            });
            setLogs(combinedLogs);
            setImportStatus('success');

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
                        <p>Processed {stats.total} items. Imported {stats.imported} new items ({stats.total - stats.imported} duplicates skipped).</p>
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

            <div className={styles.instructions}>
                <h3 style={{ marginBottom: '10px' }}>Instructions</h3>
                <ul className={styles.instructionsList}>
                    <li>Download your export ZIP from the service.</li>
                    <li>Keep the media files included if available.</li>
                    <li>Upload the ZIP file here.</li>
                </ul>
            </div>

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
