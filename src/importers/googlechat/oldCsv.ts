import type { Message } from '../../types/chat';
import type { ParseResult } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { parseCsv } from '../utils';

const EMAIL_TO_NAME: Record<string, string> = {
    'luci.milella@gmail.com': 'Luciana Milella',
    'valerio.donati@gmail.com': 'Valerio Donati'
};

function parseDatetime(value: string): Date | null {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match;
    return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
    );
}

export async function parseOldGoogleChatCsv(file: File, chatId: string): Promise<ParseResult> {
    const text = await file.text();
    const logs: string[] = [];
    const errors: string[] = [];
    const messages: Message[] = [];

    const rows = parseCsv(text);
    if (!rows.length) {
        throw new Error('CSV appears to be empty');
    }

    const [headerRow, ...dataRows] = rows;
    const headers = headerRow.map((value) => value.trim().toLowerCase());
    const senderIndex = headers.indexOf('sender');
    const messageIndex = headers.indexOf('message');
    const datetimeIndex = headers.indexOf('datetime');

    if (senderIndex === -1 || messageIndex === -1 || datetimeIndex === -1) {
        throw new Error('CSV missing expected columns: sender,message,datetime');
    }

    for (const row of dataRows) {
        if (!row.length) continue;
        const senderEmail = (row[senderIndex] ?? '').trim();
        const content = (row[messageIndex] ?? '').trim();
        const datetimeRaw = (row[datetimeIndex] ?? '').trim();
        const timestamp = parseDatetime(datetimeRaw);

        if (!timestamp) {
            errors.push(`Failed to parse date: ${datetimeRaw}`);
            continue;
        }

        if (!content) continue;

        const senderId = EMAIL_TO_NAME[senderEmail] ?? senderEmail;
        const externalId = `gchat_old_${timestamp.toISOString()}_${senderId}_${content}`;

        messages.push({
            id: uuidv4(),
            chatId,
            senderId,
            content,
            timestamp,
            status: 'read',
            source: 'googlechat_old',
            externalId
        });
    }

    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    logs.push(`Parsed ${messages.length} messages from ${file.name}`);

    return { messages, errors, logs };
}
