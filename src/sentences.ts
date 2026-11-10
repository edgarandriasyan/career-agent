// Cuts streamed text into sentences. A sentence ends at a newline, or at . ! ? …
// (plus closing quotes or brackets) followed by whitespace, unless the period
// belongs to an abbreviation or a numbered list marker ("1. "). A period inside
// a number ("1.1") is never followed by whitespace, so it never ends a sentence.

const ABBREVIATIONS = new Set([
  "vs", "e.g", "i.e", "mr", "mrs", "ms", "dr", "inc", "ltd", "approx",
  "г", "гг", "т.е", "т.д", "т.п", "напр", "см", "руб",
]);

const isSpace = (c: string) => /\s/u.test(c);

export class SentenceSegmenter {
  private buf = "";

  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (c === "\n") {
        this.emit(out, this.buf.slice(start, i));
        start = i + 1;
      } else if (".!?…".includes(c)) {
        let j = i + 1;
        while (j < this.buf.length && /[.!?…"')\]»”*_]/u.test(this.buf[j])) j++;
        if (j >= this.buf.length) break; // the next chunk decides
        if (isSpace(this.buf[j]) && !this.isNotAnEnd(this.buf.slice(start, i), c)) {
          this.emit(out, this.buf.slice(start, j));
          start = j;
        }
        i = j - 1;
      }
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  flush(): string[] {
    const out: string[] = [];
    this.emit(out, this.buf);
    this.buf = "";
    return out;
  }

  private emit(out: string[], s: string) {
    s = s.trim();
    if (s) out.push(s);
  }

  /** `before` is the current sentence up to (not including) the period. */
  private isNotAnEnd(before: string, mark: string): boolean {
    if (mark !== ".") return false;
    if (/^\s*\d+$/.test(before)) return true; // list marker "1."
    const word = before.match(/[\p{L}.]+$/u)?.[0].toLowerCase();
    return word !== undefined && ABBREVIATIONS.has(word);
  }
}
