export type CsvRow = Record<string, string>;

export function parseCsv(text: string): string[][] {
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

export function mapHeaderRow(rows: string[][]): { headers: string[]; data: string[][] } {
    const [headerRow, ...dataRows] = rows;
    if (!headerRow) {
        throw new Error('CSV appears to be empty.');
    }
    return { headers: headerRow, data: dataRows };
}

export function toRowObject(
    headers: string[],
    row: string[],
    normalizeHeader: (value: string) => string = (value) => value
): CsvRow {
    const obj: CsvRow = {};
    headers.forEach((header, index) => {
        const key = normalizeHeader(header);
        obj[key] = row[index] ?? '';
    });
    return obj;
}

export function getAttachmentType(fileName: string): 'image' | 'video' | 'audio' | 'document' {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'thumb'].includes(ext || '')) return 'image';
    if (['mp4', 'mov', 'm4v', '3gp'].includes(ext || '')) return 'video';
    if (['opus', 'mp3', 'wav', 'ogg', 'm4a', 'aac'].includes(ext || '')) return 'audio';
    return 'document';
}
