
const lines = [
    "[09/07/20, 08:46:54] Luciana Milella: leriooo, ma che fai?",
    "[09/07/20, 14:19:29] Valerio Donati: dai che ce la facciamo a trovarne uno"
];

// The regex currently in parser.ts
// const MESSAGE_REGEX = /^\[(\d{2}\/\d{2}\/\d{2,4}), (\d{2}:\d{2}:\d{2})\] (.+?): (.*)/;
const regex1 = /\[(\d{2}\/\d{2}\/\d{2,4}), (\d{2}:\d{2}:\d{2})\] (.+?): (.*)/;

console.log("Testing Regex:", regex1);

lines.forEach(line => {
    // Clean like we do in parser
    const cleanLine = line.replace(/[\u200e\u200f\u202a\u202c\u202d\u202e]/g, '');
    const match = cleanLine.match(regex1);
    console.log(`Line: "${line}"`);
    console.log(`Match:`, match ? "YES" : "NO");
    if (match) {
        console.log("Groups:", match.slice(1));
    }
    console.log("---");
});
