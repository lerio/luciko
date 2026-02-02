import type { Message, Attachment } from '../../types/chat';
import type { ParseResult } from '../types';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';

const LUCY_NAME = 'Luciana Milella';
const VALERIO_NAME = 'Valerio Donati';

const LUCY_EXPORTS = new Set([
    '393333492571@s.whatsapp.net',
    '393667047078@s.whatsapp.net',
    '4915164054006@s.whatsapp.net'
]);

const VALERIO_EXPORTS = new Set([
    '393756573770@s.whatsapp.net',
    '393934553398@s.whatsapp.net'
]);

const SKIP_MESSAGE_TYPES = new Set(['10', '59', '66']);

type CsvRow = Record<string, string>;

function normalizeExportId(name: string) {
    return name.replace(/\.zip$/i, '').replace(/\.csv$/i, '');
}

function getExportOwner(fileName: string) {
    const exportId = normalizeExportId(fileName);
    if (LUCY_EXPORTS.has(exportId)) return 'luciana';
    if (VALERIO_EXPORTS.has(exportId)) return 'valerio';
    return null;
}

function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    while (i < text.length) {
        const char = text[i];
        const next = text[i + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                field += '"';
                i += 2;
                continue;
            }
            inQuotes = !inQuotes;
            i += 1;
            continue;
        }

        if (!inQuotes && (char === '\n' || char === '\r')) {
            if (char === '\r' && next === '\n') {
                i += 1;
            }
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            i += 1;
            continue;
        }

        if (!inQuotes && char === ',') {
            row.push(field);
            field = '';
            i += 1;
            continue;
        }

        field += char;
        i += 1;
    }

    row.push(field);
    rows.push(row);

    return rows;
}

function mapHeaderRow(rows: string[][]): { headers: string[]; data: string[][] } {
    const [headerRow, ...dataRows] = rows;
    if (!headerRow) {
        throw new Error('CSV appears to be empty.');
    }
    return { headers: headerRow, data: dataRows };
}

function toRowObject(headers: string[], row: string[]): CsvRow {
    const obj: CsvRow = {};
    headers.forEach((header, index) => {
        obj[header] = row[index] ?? '';
    });
    return obj;
}

function getAttachmentType(fileName: string): 'image' | 'video' | 'audio' | 'document' {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif'].includes(ext || '')) return 'image';
    if (['mp4', 'mov', 'm4v', '3gp'].includes(ext || '')) return 'video';
    if (['opus', 'mp3', 'wav', 'ogg', 'm4a', 'aac'].includes(ext || '')) return 'audio';
    return 'document';
}

function buildContent(row: CsvRow): string {
    const text = row.text?.trim() ?? '';
    const mediaTitle = row.media_title?.trim() ?? '';
    const mediaAuthor = row.media_author?.trim() ?? '';
    const messageType = row.message_type?.trim() ?? '';
    const vcardName =
        messageType === '4'
            ? (row.vcard_name?.trim() ?? '')
            : '';

    if (messageType === '14') {
        return 'This message was deleted';
    }

    return text || mediaTitle || vcardName || mediaAuthor;
}

function buildExternalId(row: CsvRow, senderId: string, content: string, attachmentNames: string) {
    const stanzaId = row.stanza_id?.trim();
    if (stanzaId) {
        return stanzaId;
    }

    const timestamp = row.message_date_iso || row.sent_date_iso || '';
    return `${timestamp}_${senderId}_${content}_${attachmentNames}`;
}

function resolveSender(isFromMe: boolean, exportOwner: 'luciana' | 'valerio') {
    return isFromMe
        ? (exportOwner === 'luciana' ? LUCY_NAME : VALERIO_NAME)
        : (exportOwner === 'luciana' ? VALERIO_NAME : LUCY_NAME);
}

function parseReactions(row: CsvRow): { emoji: string; count: number }[] | undefined {
    const emojisRaw = row.reaction_emojis?.trim();
    if (!emojisRaw) return undefined;

    const emojis = emojisRaw
        .split('|')
        .map((emoji) => emoji.trim())
        .filter(Boolean);

    if (!emojis.length) return undefined;

    const counts = new Map<string, number>();
    emojis.forEach((emoji) => {
        counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
    });

    return Array.from(counts.entries()).map(([emoji, count]) => ({ emoji, count }));
}

export async function parseWhatsAppZip(file: File, chatId: string): Promise<ParseResult> {
    const zip = await JSZip.loadAsync(file);
    const logs: string[] = [];
    const errors: string[] = [];
    const messages: Message[] = [];
    const senderByMessagePk = new Map<string, string>();
    const senderByStanzaId = new Map<string, string>();

    const csvEntry = Object.keys(zip.files).find((name) => name.endsWith('.csv') && name.includes('@'));
    if (!csvEntry) {
        throw new Error('CSV chat export not found in ZIP archive');
    }

    const exportOwner = getExportOwner(file.name) ?? getExportOwner(csvEntry);
    if (!exportOwner) {
        throw new Error(`Unknown export owner for file ${file.name}. Please add it to the mapping.`);
    }

    const text = await zip.file(csvEntry)!.async('string');
    const { headers, data } = mapHeaderRow(parseCsv(text));
    const rows = data
        .filter((row) => row.length)
        .map((row) => toRowObject(headers, row));
    const attachmentCache = new Map<string, Blob>();

    for (const row of rows) {
        const isFromMe = row.is_from_me?.trim() === '1';
        const senderId = resolveSender(isFromMe, exportOwner);
        const messagePk = row.message_pk?.trim();
        const stanzaId = row.stanza_id?.trim();
        if (messagePk) {
            senderByMessagePk.set(messagePk, senderId);
        }
        if (stanzaId) {
            senderByStanzaId.set(stanzaId, senderId);
        }
    }

    for (const row of rows) {
        const messageType = row.message_type?.trim();
        const isFromMe = row.is_from_me?.trim() === '1';
        const timestampIso = row.message_date_iso?.trim() || row.sent_date_iso?.trim();

        if (!timestampIso) {
            errors.push(`Missing timestamp for message_pk ${row.message_pk || 'unknown'}`);
            continue;
        }

        const timestamp = new Date(timestampIso);
        if (Number.isNaN(timestamp.getTime())) {
            errors.push(`Invalid timestamp "${timestampIso}" for message_pk ${row.message_pk || 'unknown'}`);
            continue;
        }

        const senderId = resolveSender(isFromMe, exportOwner);

        const content = buildContent(row);
        const mediaLocalPath = row.media_local_path?.trim() ?? '';
        const quotedText = row.quoted_text?.trim() ?? '';
        const quotedMessagePk = row.quoted_message_pk?.trim() ?? '';
        const quotedStanzaId = row.quoted_stanza_id?.trim() ?? '';
        const quotedSender =
            (quotedMessagePk && senderByMessagePk.get(quotedMessagePk)) ||
            (quotedStanzaId && senderByStanzaId.get(quotedStanzaId)) ||
            undefined;
        const reactions = parseReactions(row);

        let attachments: Attachment[] | undefined;
        if (mediaLocalPath) {
            const mediaEntry = zip.file(mediaLocalPath);
            if (!mediaEntry) {
                logs.push(`Missing media file: ${mediaLocalPath}`);
            } else {
                const cached = attachmentCache.get(mediaLocalPath);
                const blob = cached ?? (await mediaEntry.async('blob'));
                if (!cached) {
                    attachmentCache.set(mediaLocalPath, blob);
                }
                const fileName = mediaLocalPath.split('/').pop() || mediaLocalPath;
                const mimeTypeHint = row.vcard_string?.includes('/') ? row.vcard_string : undefined;
                attachments = [{
                    id: uuidv4(),
                    type: getAttachmentType(fileName),
                    url: '',
                    fileName,
                    mimeType: mimeTypeHint || blob.type,
                    size: blob.size,
                    file: blob
                }];
            }
        }

        const hasContent = content.trim().length > 0;
        const hasAttachments = Boolean(attachments && attachments.length);
        const hasReactions = Boolean(reactions && reactions.length);

        if (SKIP_MESSAGE_TYPES.has(messageType) && !hasContent && !hasAttachments && !hasReactions) {
            continue;
        }

        if (!hasContent && !hasAttachments && !hasReactions) {
            continue;
        }

        const attachmentNames = attachments?.map((att) => att.fileName).join(',') || '';
        const externalId = buildExternalId(row, senderId, content, attachmentNames);

        const message: Message = {
            id: uuidv4(),
            chatId,
            senderId,
            content,
            timestamp,
            status: 'read',
            attachments,
            quotedText: quotedText || undefined,
            quotedSender,
            reactions,
            externalId
        };

        messages.push(message);
    }

    return { messages, errors, logs };
}
