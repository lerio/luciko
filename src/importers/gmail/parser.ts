import type { Message, Attachment } from '../../types/chat';
import type { ParseResult } from '../types';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { getAttachmentType, mapHeaderRow, parseCsv, toRowObject } from '../utils';

const LUCY_NAME = 'Luciana Milella';
const VALERIO_NAME = 'Valerio Donati';

const EMAIL_TO_NAME: Record<string, string> = {
    'luci.milella@gmail.com': LUCY_NAME,
    'luci-ko_1002@ezweb.ne.jp': LUCY_NAME,
    'valerio.donati@gmail.com': VALERIO_NAME
};

const normalizeHeader = (value: string) => value.trim().toLowerCase();

function normalizeZipPath(path: string) {
    let normalized = path.trim();
    normalized = normalized.replace(/\\/g, '/');
    normalized = normalized.replace(/^["']|["']$/g, '');
    if (normalized.startsWith('./')) normalized = normalized.slice(2);
    if (normalized.startsWith('/')) normalized = normalized.slice(1);
    normalized = normalized.replace(/^file:\/\//i, '');
    normalized = normalized.replace(/\/{2,}/g, '/');
    return normalized;
}

function splitAttachmentPaths(raw: string): string[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed
                    .map((value) => String(value).trim())
                    .map(normalizeZipPath)
                    .filter(Boolean);
            }
        } catch {
            // Fall back to string splitting below.
        }
    }

    const csvParts = parseCsv(trimmed)[0] ?? [];
    return csvParts
        .flatMap((part) => part.split(/\s*[|;\n]\s*/g))
        .map((value) => value.trim())
        .map(normalizeZipPath)
        .filter(Boolean);
}

function resolveSender(email: string) {
    const normalized = email.trim().toLowerCase();
    return EMAIL_TO_NAME[normalized] ?? email.trim();
}

function makePathCandidates(path: string, baseDir: string): string[] {
    const normalized = normalizeZipPath(path);
    if (!normalized) return [];

    const candidates = new Set<string>();
    candidates.add(normalized);

    if (baseDir) {
        candidates.add(`${baseDir}/${normalized}`.replace(/\/{2,}/g, '/'));
    }

    const segments = normalized.split('/').filter(Boolean);
    for (let i = 1; i < segments.length; i += 1) {
        const suffix = segments.slice(i).join('/');
        candidates.add(suffix);
        if (baseDir) {
            candidates.add(`${baseDir}/${suffix}`.replace(/\/{2,}/g, '/'));
        }
    }

    return Array.from(candidates);
}

function resolveAttachmentPath(
    rawPath: string,
    baseDir: string,
    lookup: Map<string, string>,
    normalizedPathKeys: string[]
): string | null {
    const candidates = makePathCandidates(rawPath, baseDir);
    for (const candidate of candidates) {
        const direct = lookup.get(candidate.toLowerCase());
        if (direct) return direct;
    }

    for (const candidate of candidates) {
        const normalizedCandidate = candidate.toLowerCase();
        const suffix = `/${normalizedCandidate}`;
        const match = normalizedPathKeys.find((path) => path === normalizedCandidate || path.endsWith(suffix));
        if (match) {
            return lookup.get(match) ?? null;
        }
    }

    return null;
}

function buildMessageKey(
    timestamp: Date,
    senderId: string,
    recipientId: string,
    subject: string,
    body: string
) {
    return `gmail_${timestamp.toISOString()}_${senderId}_${recipientId}_${subject}_${body}`;
}

function buildExternalId(
    timestamp: Date,
    senderId: string,
    recipientId: string,
    subject: string
) {
    // Keep compatibility with old imports where attachment names were empty.
    return `gmail_${timestamp.toISOString()}_${senderId}_${recipientId}_${subject}_`;
}

export async function parseGmailZip(file: File, chatId: string, zipInput?: JSZip): Promise<ParseResult> {
    const zip = zipInput ?? await JSZip.loadAsync(file);
    const logs: string[] = [];
    const errors: string[] = [];
    const messagesByKey = new Map<string, Message>();

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

    const zipEntryPaths = Object.keys(zip.files)
        .filter((name) => !zip.files[name].dir && !name.includes('__MACOSX'))
        .map(normalizeZipPath);
    const zipEntryPathKeys = zipEntryPaths.map((path) => path.toLowerCase());
    const zipPathLookup = new Map<string, string>();
    for (const zipPath of zipEntryPaths) {
        zipPathLookup.set(zipPath.toLowerCase(), zipPath);
    }

    for (const row of rows) {
        const senderEmail = row['sender email']?.trim() ?? '';
        const recipientEmail = row['recipient email']?.trim() ?? '';
        const subject = row.subject?.trim() ?? '';
        const body = (row.content?.trim() ?? '').replace(/(?<!\n)\n(?!\n)/g, ' ');
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
        const attachmentPromises = attachmentPaths
            .map(async (rawPath) => {
                const resolvedPath = resolveAttachmentPath(rawPath, baseDir, zipPathLookup, zipEntryPathKeys);
                const zipEntry = resolvedPath ? zip.file(resolvedPath) : null;
                if (!zipEntry) {
                    logs.push(`Missing attachment file: ${rawPath}`);
                    return null;
                }
                const blob = await zipEntry.async('blob');
                const fileName = resolvedPath!.split('/').pop() || resolvedPath!;
                return {
                    id: uuidv4(),
                    type: getAttachmentType(fileName),
                    fileName,
                    mimeType: blob.type,
                    size: blob.size,
                    file: blob
                } as Attachment;
            });

        const resolved = await Promise.all(attachmentPromises);
        for (const att of resolved) {
            if (att) attachments.push(att);
        }

        if (!content && attachments.length === 0) {
            continue;
        }

        const messageKey = buildMessageKey(timestamp, senderId, recipientId, subject, body);
        const existing = messagesByKey.get(messageKey);

        if (existing) {
            if (attachments.length > 0) {
                existing.attachments = [...(existing.attachments ?? []), ...attachments];
            }
            continue;
        }

        messagesByKey.set(messageKey, {
            id: uuidv4(),
            chatId,
            senderId,
            content,
            timestamp,
            status: 'read',
            attachments: attachments.length ? attachments : undefined,
            source: 'gmail',
            externalId: buildExternalId(timestamp, senderId, recipientId, subject)
        });
    }

    const messages = Array.from(messagesByKey.values());
    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return { messages, errors, logs, sourceItemCount: rows.length };
}
