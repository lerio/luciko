import type { Message, Attachment } from '../../types/chat';
import type { ParseResult } from '../types';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { getAttachmentType, mapHeaderRow, parseCsv, toRowObject } from '../utils';

const LUCY_NAME = 'Luciana Milella';
const VALERIO_NAME = 'Valerio Donati';

const EMAIL_TO_NAME: Record<string, string> = {
    'luci.milella@gmail.com': LUCY_NAME,
    'valerio.donati@gmail.com': VALERIO_NAME
};

const normalizeHeader = (value: string) => value.trim().toLowerCase();

function normalizeZipPath(path: string) {
    let normalized = path.trim();
    if (normalized.startsWith('./')) normalized = normalized.slice(2);
    if (normalized.startsWith('/')) normalized = normalized.slice(1);
    return normalized;
}

function splitAttachmentPaths(raw: string): string[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    return trimmed
        .split(/\s*[|;]\s*/g)
        .map((value) => value.trim())
        .filter(Boolean);
}

function resolveSender(email: string) {
    const normalized = email.trim().toLowerCase();
    return EMAIL_TO_NAME[normalized] ?? email.trim();
}

export async function parseGmailZip(file: File, chatId: string, zipInput?: JSZip): Promise<ParseResult> {
    const zip = zipInput ?? await JSZip.loadAsync(file);
    const logs: string[] = [];
    const errors: string[] = [];
    const messages: Message[] = [];

    const csvEntry = Object.keys(zip.files).find((name) => /emails\.csv$/i.test(name) && !name.includes('__MACOSX'));
    if (!csvEntry) {
        throw new Error('emails.csv not found in Gmail export ZIP');
    }

    const baseDir = csvEntry.split('/').slice(0, -1).join('/');
    const text = await zip.file(csvEntry)!.async('string');
    const { headers, data } = mapHeaderRow(parseCsv(text));
    const rows = data
        .filter((row) => row.length)
        .map((row) => toRowObject(headers, row, normalizeHeader));

    for (const row of rows) {
        const senderEmail = row['sender email']?.trim() ?? '';
        const recipientEmail = row['recipient email']?.trim() ?? '';
        const subject = row.subject?.trim() ?? '';
        const body = row.content?.trim() ?? '';
        const timestampRaw = row.timestamp?.trim() ?? '';
        const attachmentPathRaw = row['attachment local filepath'] ?? '';

        if (!timestampRaw) {
            errors.push(`Missing timestamp for subject "${subject}"`);
            continue;
        }

        const timestamp = new Date(timestampRaw);
        if (Number.isNaN(timestamp.getTime())) {
            errors.push(`Invalid timestamp "${timestampRaw}" for subject "${subject}"`);
            continue;
        }

        const senderId = resolveSender(senderEmail);
        const recipientId = resolveSender(recipientEmail);
        const content = subject
            ? `${subject}\n\n${body}`
            : body;

        const attachments: Attachment[] = [];
        const attachmentPaths = splitAttachmentPaths(attachmentPathRaw);
        for (const rawPath of attachmentPaths) {
            const normalized = normalizeZipPath(rawPath);
            const resolved = baseDir && !normalized.startsWith(baseDir)
                ? `${baseDir}/${normalized}`
                : normalized;
            const zipEntry = zip.file(resolved);
            if (!zipEntry) {
                logs.push(`Missing attachment file: ${resolved}`);
                continue;
            }
            const blob = await zipEntry.async('blob');
            const fileName = normalized.split('/').pop() || normalized;
            attachments.push({
                id: uuidv4(),
                type: getAttachmentType(fileName),
                fileName,
                mimeType: blob.type,
                size: blob.size,
                file: blob
            });
        }

        if (!content && attachments.length === 0) {
            continue;
        }

        const attachmentNames = attachments.map((att) => att.fileName).join(',');
        const externalId = `gmail_${timestamp.toISOString()}_${senderId}_${recipientId}_${subject}_${attachmentNames}`;

        messages.push({
            id: uuidv4(),
            chatId,
            senderId,
            content,
            timestamp,
            status: 'read',
            attachments: attachments.length ? attachments : undefined,
            source: 'gmail',
            externalId
        });
    }

    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return { messages, errors, logs };
}
