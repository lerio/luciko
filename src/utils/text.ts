const mojibakeScore = (value: string): number => {
    const controlMatches = value.match(/[\u0080-\u00bf]/g);
    const sequenceMatches = value.match(/[ÃÂâå][\u0080-\u00bf]/g);
    return (
        (controlMatches?.length ?? 0) +
        (sequenceMatches?.length ?? 0) +
        (value.includes('�') ? 1 : 0)
    );
};

const decodeLatin1AsUtf8 = (value: string): string => {
    const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
};

const applyReplacementFixes = (value: string): string => (
    value
        .replace('mi faccio il caffè, v�', 'mi faccio il caffè, và')
);

export function normalizeMojibakeText(value?: string): string | undefined {
    if (!value) return value;

    const needsFix =
        /[\u0080-\u00bf]/.test(value) ||
        /[ÃÂâå][\u0080-\u00bf]/.test(value) ||
        value.includes('�');
    if (!needsFix) return value;

    try {
        let best = value;
        let bestScore = mojibakeScore(value);
        let current = value;

        for (let i = 0; i < 2; i += 1) {
            current = decodeLatin1AsUtf8(current);
            const score = mojibakeScore(current);
            if (score < bestScore) {
                best = current;
                bestScore = score;
            }
            if (score === 0) break;
        }

        return applyReplacementFixes(best);
    } catch {
        return applyReplacementFixes(value);
    }
}
