/**
 * Console model replacing the RichTextFX `InlineCssTextArea` used as the CPU window console,
 * plus ports of `ConsoleOutputStream` and `CPUController.writeConsoleLn`.
 *
 * RichTextFX semantics kept: every replace/append moves the caret to the end of the inserted
 * text; `setStyle(paragraph, css)` styles the whole paragraph; new paragraphs created by an
 * inserted "\n" inherit the style of the paragraph they were split from.
 */
import type { ConsoleStream } from '../cpu/Cpu';

export interface ParagraphStyle {
  /** CSS colour name or value (`-fx-fill`). */
  color: string;
  /** `-fx-font-family: monospace` (CPU output) */
  monospace: boolean;
}

const DEFAULT_STYLE: ParagraphStyle = { color: 'black', monospace: false };

export class ConsoleModel {
  private text = '';
  private styles: ParagraphStyle[] = [DEFAULT_STYLE];
  private caret = 0;
  private readonly listeners: (() => void)[] = [];
  /** Incremented on every change (for cheap UI change detection). */
  version = 0;

  getText(): string {
    return this.text;
  }

  getLength(): number {
    return this.text.length;
  }

  getCaretPosition(): number {
    return this.caret;
  }

  paragraphs(): { text: string; style: ParagraphStyle }[] {
    return this.text.split('\n').map((text, i) => ({ text, style: this.styles[i] ?? DEFAULT_STYLE }));
  }

  getParagraphText(index: number): string {
    return this.text.split('\n')[index] ?? '';
  }

  getCurrentParagraph(): number {
    return countNewlines(this.text, 0, this.caret);
  }

  getCaretColumn(): number {
    const lineStart = this.text.lastIndexOf('\n', this.caret - 1) + 1;
    return this.caret - lineStart;
  }

  appendText(s: string): void {
    this.replaceText(this.text.length, this.text.length, s);
  }

  replaceText(start: number, end: number, s: string): void {
    const startPar = countNewlines(this.text, 0, start);
    const removedNewlines = countNewlines(this.text, start, end);
    const insertedNewlines = countNewlines(s, 0, s.length);
    const base = this.styles[startPar] ?? DEFAULT_STYLE;
    this.styles.splice(startPar + 1, removedNewlines, ...Array<ParagraphStyle>(insertedNewlines).fill(base));
    this.text = this.text.substring(0, start) + s + this.text.substring(end);
    this.caret = start + s.length;
    this.changed();
  }

  /** `moveTo(paragraph, column)` */
  moveToParagraph(paragraph: number, column: number): void {
    let pos = 0;
    for (let p = 0; p < paragraph; p++) pos = this.text.indexOf('\n', pos) + 1;
    this.caret = pos + column;
    this.changed();
  }

  moveTo(position: number): void {
    this.caret = position;
    this.changed();
  }

  /** `setStyle(paragraph, css)` */
  setStyle(paragraph: number, style: ParagraphStyle): void {
    if (paragraph >= 0 && paragraph < this.styles.length) {
      this.styles[paragraph] = style;
      this.changed();
    }
  }

  clear(): void {
    this.text = '';
    this.styles = [DEFAULT_STYLE];
    this.caret = 0;
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private changed(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }
}

function countNewlines(s: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** `CPUController.writeConsoleLn(text, color)` */
export function writeConsoleLn(console: ConsoleModel, text: string, color: string): void {
  let paragraph = console.getCurrentParagraph();
  if (console.getParagraphText(paragraph).length > 0) {
    console.appendText('\n');
    paragraph = console.getCurrentParagraph();
  }
  console.setStyle(paragraph, { color, monospace: false });
  console.appendText(text + '\n');
  console.moveTo(console.getLength());
}

/**
 * Port of `ConsoleOutputStream`: the CPU writes characters into a queue; the UI drains the queue
 * in throttled bursts ({@link flush}, at most 15 ms per call - the original `fxWriteThrottle`).
 */
export class ConsoleOutputStream implements ConsoleStream {
  private isUsed = false;
  private readonly charsQueue: number[] = [];
  /** Requests a UI-side flush (Platform.runLater(fxWriteThrottle) equivalent). */
  onPending: (() => void) | null = null;

  constructor(
    private readonly console: ConsoleModel,
    private readonly color = 'black',
    private readonly now: () => number = () => performance.now(),
  ) {}

  getIsUsed(): boolean {
    return this.isUsed;
  }

  /** Before each program start: the next character prints the `[CPU KONZOLA]` header again. */
  setUnused(): void {
    this.isUsed = false;
  }

  /** Stop [F10]: discard characters not printed yet. */
  clearBuffer(): void {
    this.charsQueue.length = 0;
  }

  hasPending(): boolean {
    return this.charsQueue.length > 0;
  }

  write(b: number): void {
    this.charsQueue.push(b);
    this.onPending?.();
  }

  /** `write(byte[])` - the original loop stops at `length - 1`: the last byte is dropped. */
  writeBytes(bytes: number[]): void {
    for (let i = 0; i < bytes.length - 1; i++) this.write(bytes[i]);
  }

  /** `fxWriteThrottle`: write queued characters for at most 15 ms. Returns true if more remain. */
  flush(): boolean {
    const start = this.now();
    while (this.now() - start < 15 && this.charsQueue.length > 0) {
      this.writeToConsole(this.charsQueue.shift()!);
    }
    return this.charsQueue.length > 0;
  }

  private writeToConsole(b: number): void {
    const c = this.console;
    if (!this.isUsed) {
      if (c.getParagraphText(c.getCurrentParagraph()).length > 0) c.appendText('\n');
      c.setStyle(c.getCurrentParagraph(), { color: 'red', monospace: false });
      c.appendText('[CPU KONZOLA]\n');
      this.isUsed = true;
    }

    const paragraph = c.getCurrentParagraph();
    if (b === 10) {
      // LF - new line, same column
      const caretCol = c.getCaretColumn();
      c.appendText('\n');
      if (caretCol > 0) c.appendText(' '.repeat(caretCol));
    } else if (b === 13) {
      // CR - back to the start of the line
      c.moveToParagraph(c.getCurrentParagraph(), 0);
    } else {
      const pos = c.getCaretPosition();
      const ch = String.fromCharCode(b & 0xffff); // (char) b
      if (pos === c.getLength()) c.replaceText(pos, pos, ch);
      else c.replaceText(pos, pos + 1, ch);
    }

    c.setStyle(paragraph, { color: this.color, monospace: true });
  }
}
