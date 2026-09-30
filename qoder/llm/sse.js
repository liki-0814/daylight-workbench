export class SseParser {
    buffer = "";
    push(chunk) {
        this.buffer += chunk;
        const frames = [];
        for(;;){
            const sep = this.nextSeparator();
            if (!sep) break;
            const raw = this.buffer.slice(0, sep.end);
            this.buffer = this.buffer.slice(sep.end + sep.skip);
            const frame = this.parseBlock(raw);
            if (frame) frames.push(frame);
        }
        return frames;
    }
    flush() {
        const rest = this.buffer.trim();
        this.buffer = "";
        if (!rest) return [];
        const frame = this.parseBlock(rest);
        return frame ? [
            frame
        ] : [];
    }
    nextSeparator() {
        const lf = this.buffer.indexOf("\n\n");
        const crlf = this.buffer.indexOf("\r\n\r\n");
        if (lf === -1 && crlf === -1) return undefined;
        if (crlf !== -1 && (lf === -1 || crlf < lf)) return {
            end: crlf,
            skip: 4
        };
        return {
            end: lf,
            skip: 2
        };
    }
    parseBlock(block) {
        let event;
        const dataLines = [];
        for (const rawLine of block.split(/\r?\n/)){
            const line = rawLine;
            if (line === "" || line.startsWith(":")) continue;
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            let value = colon === -1 ? "" : line.slice(colon + 1);
            if (value.startsWith(" ")) value = value.slice(1);
            if (field === "event") event = value;
            else if (field === "data") dataLines.push(value);
        }
        if (event === undefined && dataLines.length === 0) return undefined;
        return {
            event,
            data: dataLines.join("\n")
        };
    }
}
