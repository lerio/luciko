import type { Message } from '../types/chat';

export interface ParseResult {
    messages: Message[];
    errors: string[];
    logs: string[];
}
