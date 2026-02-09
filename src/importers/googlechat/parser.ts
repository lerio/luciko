import type { Message, Attachment } from '../../types/chat';
import type { ParseResult } from '../types';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { getAttachmentType } from '../utils';

type GoogleChatMessage = {
    creator?: { name?: string };
    created_date?: string;
    text?: string;
    attached_files?: { original_name?: string; export_name?: string }[];
    message_id?: string;
};

function parseGoogleChatDate(value: string): Date | null {
    if (!value) return null;
    const normalized = value
        .replace(/[\u202f\u00a0\u200e\u200f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const withoutWeekday = normalized.replace(/^[A-Za-zÀ-ÿ]+,\s+/i, '');
    const normalizedDate = withoutWeekday.replace(/\s+at\s+/i, ' ');
    const parts = normalizedDate.match(/^(\w+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)\s+UTC$/i);
    if (!parts) return null;

    const [, monthRaw, dayRaw, yearRaw, hourRaw, minuteRaw, secondRaw, meridiemRaw] = parts;
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const monthIndex = months.indexOf(monthRaw.toLowerCase().slice(0, 3));
    if (monthIndex === -1) return null;

    let hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const second = Number(secondRaw);
    const meridiem = meridiemRaw.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;

    return new Date(Date.UTC(Number(yearRaw), monthIndex, Number(dayRaw), hour, minute, second));
}

export async function parseGoogleChatZip(file: File, chatId: string, zipInput?: JSZip): Promise<ParseResult> {
    const zip = zipInput ?? await JSZip.loadAsync(file);
    const logs: string[] = [];
    const errors: string[] = [];
    const messages: Message[] = [];

    const jsonFile = Object.keys(zip.files).find(
        (name) => /messages\.json$/i.test(name) && !name.includes('__MACOSX')
    );
    if (!jsonFile) {
        throw new Error('messages.json not found in Google Chat export');
    }

    const raw = await zip.file(jsonFile)!.async('string');
    const parsed = JSON.parse(raw) as { messages?: GoogleChatMessage[] };
    const records = parsed.messages ?? [];
    logs.push(`Parsed ${records.length} messages from ${jsonFile}`);
    const baseDir = jsonFile.split('/').slice(0, -1).join('/');

    let failedDates = 0;
    let loggedSample = false;
    for (const record of records) {
        const sender = record.creator?.name?.trim() ?? '';
        const timestampRaw = record.created_date ?? '';
        const timestamp = parseGoogleChatDate(timestampRaw);
        if (!timestamp) {
            failedDates += 1;
            if (failedDates <= 5) {
                logs.push(`Failed to parse date: ${timestampRaw}`);
            }
            if (!loggedSample && failedDates === 1) {
                const normalized = timestampRaw
                    .replace(/[\u202f\u00a0\u200e\u200f]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .replace(/^[A-Za-zÀ-ÿ]+,\s+/i, '')
                    .replace(/\s+at\s+/i, ' ');
                logs.push(`Normalized date sample: ${normalized}`);
                logs.push(`Date.parse sample: ${Date.parse(normalized)}`);
                loggedSample = true;
            }
            continue;
        }

        const content = record.text?.trim() ?? '';
        const attachments: Attachment[] = [];

        if (record.attached_files) {
            for (const fileEntry of record.attached_files) {
                const exportName = fileEntry.export_name?.trim();
                if (!exportName) continue;
                const resolved = baseDir ? `${baseDir}/${exportName}` : exportName;
                const zipEntry = zip.file(resolved);
                if (!zipEntry) {
                    logs.push(`Missing attachment file: ${resolved}`);
                    continue;
                }
                const blob = await zipEntry.async('blob');
                const fileName = fileEntry.original_name || exportName;
                attachments.push({
                    id: uuidv4(),
                    type: getAttachmentType(fileName),
                    fileName,
                    mimeType: blob.type,
                    size: blob.size,
                    file: blob
                });
            }
        }

        if (!content && attachments.length === 0) {
            continue;
        }

        const attachmentNames = attachments.map((att) => att.fileName).join(',');
        const externalId = record.message_id
            ? `gchat_${record.message_id}`
            : `gchat_${timestamp.toISOString()}_${sender}_${content}_${attachmentNames}`;

        messages.push({
            id: uuidv4(),
            chatId,
            senderId: sender,
            content,
            timestamp,
            status: 'read',
            attachments: attachments.length ? attachments : undefined,
            source: 'googlechat',
            externalId
        });
    }

    if (failedDates > 5) {
        logs.push(`Failed to parse ${failedDates} message dates in total.`);
    }

    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return { messages, errors, logs };
}
