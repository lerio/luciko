import type { Message, Attachment } from '../../types/chat';
import type { ParseResult } from '../types';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { getAttachmentType } from '../utils';

const MONTHS: Record<string, number> = {
    gen: 0,
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    mag: 4,
    may: 4,
    giu: 5,
    jun: 5,
    lug: 6,
    jul: 6,
    ago: 7,
    aug: 7,
    set: 8,
    sep: 8,
    ott: 9,
    oct: 9,
    nov: 10,
    dic: 11,
    dec: 11
};

function parseFacebookTimestamp(value: string): Date | null {
    const match = value.trim().match(/^([A-Za-zÀ-ÿ]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (!match) return null;
    const [, monthRaw, dayRaw, yearRaw, hourRaw, minuteRaw, secondRaw = '0', meridiemRaw] = match;
    const monthKey = monthRaw.toLowerCase().slice(0, 3);
    const month = MONTHS[monthKey];
    if (month === undefined) return null;
    const day = Number(dayRaw);
    const year = Number(yearRaw);
    let hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const second = Number(secondRaw);
    const meridiem = meridiemRaw.toLowerCase();

    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;

    return new Date(year, month, day, hour, minute, second);
}

function extractTextContent(node: Element | null): string {
    if (!node) return '';
    const clone = node.cloneNode(true) as Element;
    clone.querySelectorAll('img').forEach((img) => img.remove());

    const walk = (current: Node): string => {
        if (current.nodeType === Node.TEXT_NODE) {
            return current.textContent ?? '';
        }
        if (current.nodeType !== Node.ELEMENT_NODE) return '';
        const element = current as HTMLElement;
        if (element.tagName === 'BR') return '\n';

        const isBlock = ['DIV', 'P'].includes(element.tagName);
        const pieces = Array.from(element.childNodes).map(walk).join('');
        return isBlock ? `${pieces}\n` : pieces;
    };

    const text = walk(clone);
    return text.replace(/\n{3,}/g, '\n\n').trim();
}

function resolveAttachmentPath(baseDir: string, path: string) {
    if (path.startsWith('data:')) return null;
    if (path.startsWith('http')) return null;
    if (path.startsWith('/')) return path.slice(1);
    if (path.startsWith(baseDir)) return path;
    return `${baseDir}/${path}`.replace(/\/{2,}/g, '/');
}

async function parseMetaZip(file: File, chatId: string, zipInput?: JSZip): Promise<ParseResult> {
    const zip = zipInput ?? await JSZip.loadAsync(file);
    const logs: string[] = [];
    const errors: string[] = [];
    const messages: Message[] = [];

    const messageFiles = Object.keys(zip.files)
        .filter((name) => /message_\d+\.html$/i.test(name))
        .sort();

    if (messageFiles.length === 0) {
        throw new Error('No message_*.html files found in Facebook export');
    }

    for (const messageFile of messageFiles) {
        const html = await zip.file(messageFile)!.async('string');
        const baseDir = messageFile.split('/').slice(0, -1).join('/');
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const messageBlocks = Array.from(doc.querySelectorAll('div._a6-g'));

        for (const block of messageBlocks) {
            const sender = block.querySelector('div._a6-h')?.textContent?.trim() ?? '';
            const timestampRaw =
                block.querySelector('div._a72d')?.textContent?.trim()
                ?? block.querySelector('div._a6-o')?.textContent?.trim()
                ?? '';
            const timestamp = parseFacebookTimestamp(timestampRaw);
            if (!timestamp) {
                errors.push(`Failed to parse timestamp "${timestampRaw}"`);
                continue;
            }

            const contentNode = block.querySelector('div._a6-p');
            const content = extractTextContent(contentNode);
            const attachments: Attachment[] = [];

            if (contentNode) {
                const elements = Array.from(contentNode.querySelectorAll('a, img'));
                for (const element of elements) {
                    const href = element instanceof HTMLAnchorElement ? element.getAttribute('href') : null;
                    const src = element instanceof HTMLImageElement ? element.getAttribute('src') : null;
                    const candidate = href || src;
                    if (!candidate) continue;
                    const resolved = resolveAttachmentPath(baseDir, candidate);
                    if (!resolved) continue;

                    const fileEntry = zip.file(resolved);
                    if (!fileEntry) {
                        logs.push(`Missing attachment file: ${resolved}`);
                        continue;
                    }

                    const blob = await fileEntry.async('blob');
                    const fileName = resolved.split('/').pop() || resolved;

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
            const externalId = `fb_${timestamp.toISOString()}_${sender}_${content}_${attachmentNames}`;

            messages.push({
                id: uuidv4(),
                chatId,
                senderId: sender,
                content,
                timestamp,
                status: 'read',
                attachments: attachments.length ? attachments : undefined,
                source: 'facebook',
                externalId
            });
        }
    }

    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return { messages, errors, logs };
}

export async function parseFacebookZip(file: File, chatId: string, zipInput?: JSZip): Promise<ParseResult> {
    return parseMetaZip(file, chatId, zipInput);
}

export async function parseInstagramZip(file: File, chatId: string, zipInput?: JSZip): Promise<ParseResult> {
    const result = await parseMetaZip(file, chatId, zipInput);
    result.messages = result.messages.map((message) => ({ ...message, source: 'instagram' }));
    return result;
}
