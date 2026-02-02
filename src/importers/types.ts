import type { Message } from '../types/chat';

export interface ParseResult {
    messages: Message[];
    errors: string[];
    logs: string[];
}

export interface Importer {
    name: string;
    accepts: (file: File) => boolean;
    parse: (file: File, chatId: string) => Promise<ParseResult>;
}
