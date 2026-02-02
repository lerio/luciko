import { useState, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { Upload, CheckCircle, AlertCircle } from 'lucide-react';
import { parseWhatsAppZip } from '../../importers/whatsapp/parser';
import { importMessages, saveChat } from '../../store/db';
import styles from './ImportPage.module.css';

const TARGET_CHAT_ID = 'c1';
const TARGET_CHAT = {
    id: TARGET_CHAT_ID,
    name: 'Luciana Milella',
    isGroup: false,
    participants: [
        { id: 'Valerio Donati', name: 'Valerio Donati' },
        { id: 'Luciana Milella', name: 'Luciana Milella' }
    ]
};

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

    const handleFile = async (file: File) => {
        setImportStatus('processing');
        setErrorMessage('');

        try {
            // Create/Ensure chat record exists
            await saveChat(TARGET_CHAT);

            const result = await parseWhatsAppZip(file, TARGET_CHAT_ID);
            const importedCount = await importMessages(result.messages);

            setStats({
                total: result.messages.length,
                imported: importedCount
            });
            setLogs(result.logs || []);
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
            <h1 className={styles.title}>Import Chat</h1>

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
                    Click or drag WhatsApp export (.zip) here
                </p>
                <p className={styles.dropzoneSubtext}>
                    Supports text and media attachments
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
                        <p>Processed {stats.total} messages. Imported {stats.imported} new messages ({stats.total - stats.imported} duplicates skipped).</p>
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
                    <li>Open WhatsApp on your phone.</li>
                    <li>Go to the chat you want to export.</li>
                    <li>Tap on the contact info &gt; Export Chat.</li>
                    <li>Select "Attach Media".</li>
                    <li>Save the ZIP file and upload it here.</li>
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
