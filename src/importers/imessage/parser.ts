import type { Message } from '../../types/chat';
import type { ParseResult } from '../types';
import { v4 as uuidv4 } from 'uuid';

type IMessageExport = {
    messages?: {
        message_rowid?: number;
        guid?: string;
        date?: string;
        is_from_me?: boolean;
        text?: string | null;
    }[];
};

const SENDER_MAP = {
    fromMe: 'Luciana Milella',
    other: 'Valerio Donati'
};

export async function parseIMessageJson(file: File, chatId: string): Promise<ParseResult> {
    const logs: string[] = [];
    const errors: string[] = [];
    const messages: Message[] = [];

    const raw = await file.text();
    const parsed = JSON.parse(raw) as IMessageExport;
    const records = parsed.messages ?? [];

    logs.push(`Parsed ${records.length} messages from ${file.name}`);

    for (const record of records) {
        const text = (record.text ?? '').trim();
        if (!text) continue;

        const dateRaw = record.date ?? '';
        const timestamp = new Date(dateRaw);
        if (Number.isNaN(timestamp.getTime())) {
            errors.push(`Failed to parse date: ${dateRaw}`);
            continue;
        }

        const senderId = record.is_from_me ? SENDER_MAP.fromMe : SENDER_MAP.other;
        const externalId = record.guid
            ? `imessage_${record.guid}`
            : `imessage_${record.message_rowid ?? ''}_${timestamp.toISOString()}_${senderId}_${text}`;

        messages.push({
            id: uuidv4(),
            chatId,
            senderId,
            content: text,
            timestamp,
            status: 'read',
            source: 'imessage',
            externalId
        });
    }

    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return { messages, errors, logs };
}
