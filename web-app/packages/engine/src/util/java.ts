/**
 * Java language semantics needed for a faithful port of the original engine.
 * Every helper documents the Java construct it replaces.
 */

/** Java `(byte) x` */
export const toByte = (x: number): number => (x << 24) >> 24;
/** Java `(short) x` */
export const toShort = (x: number): number => (x << 16) >> 16;
/** Java `Byte.toUnsignedInt(b)` / `x & 0xFF` */
export const u8 = (x: number): number => x & 0xff;
/** Java `Short.toUnsignedInt(s)` / `x & 0xFFFF` */
export const u16 = (x: number): number => x & 0xffff;

/** Java regex `\s` (without UNICODE_CHARACTER_CLASS). */
export const J_WS = '[ \\t\\n\\x0B\\f\\r]';
/** Java regex `.` (without DOTALL/UNIX_LINES) - any code point except line terminators. */
export const J_DOT = '[^\\n\\r\\u0085\\u2028\\u2029]';

/** Java `String.trim()` - strips every char <= U+0020 at both ends. */
export function javaTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.substring(start, end);
}

export class IllegalArgumentException extends Error {
  override name = 'IllegalArgumentException';
}

export class NumberFormatException extends IllegalArgumentException {
  override name = 'NumberFormatException';
  constructor(input: string) {
    super(`For input string: "${input}"`);
  }
}

export class InvalidParameterException extends IllegalArgumentException {
  override name = 'InvalidParameterException';
}

export class IndexOutOfBoundsException extends Error {
  override name = 'IndexOutOfBoundsException';
}

export class InterruptedException extends Error {
  override name = 'InterruptedException';
}

/** Java `Integer.parseInt(s, radix)` for ASCII digits. */
export function parseIntJava(s: string, radix = 10): number {
  if (s.length === 0) throw new NumberFormatException(s);
  let i = 0;
  let negative = false;
  if (s[0] === '-' || s[0] === '+') {
    negative = s[0] === '-';
    i = 1;
    if (s.length === 1) throw new NumberFormatException(s);
  }
  let result = 0;
  for (; i < s.length; i++) {
    const d = digit(s.charCodeAt(i), radix);
    if (d < 0) throw new NumberFormatException(s);
    result = result * radix + d;
    if (result > (negative ? 2147483648 : 2147483647)) throw new NumberFormatException(s);
  }
  return negative ? -result : result;
}

/** Java `Integer.parseUnsignedInt(s)` (radix 10). */
export function parseUnsignedIntJava(s: string): number {
  if (s.length === 0 || s[0] === '-') throw new NumberFormatException(s);
  let i = s[0] === '+' ? 1 : 0;
  if (i === s.length) throw new NumberFormatException(s);
  let result = 0;
  for (; i < s.length; i++) {
    const d = digit(s.charCodeAt(i), 10);
    if (d < 0) throw new NumberFormatException(s);
    result = result * 10 + d;
    if (result > 0xffffffff) throw new NumberFormatException(s);
  }
  return result | 0;
}

function digit(c: number, radix: number): number {
  let d = -1;
  if (c >= 48 && c <= 57) d = c - 48;
  else if (c >= 97 && c <= 122) d = c - 87;
  else if (c >= 65 && c <= 90) d = c - 55;
  return d >= 0 && d < radix ? d : -1;
}

/** Java `BufferedReader.readLine()` splitting (\n, \r, \r\n). */
export function readLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n' || c === '\r') {
      lines.push(text.substring(start, i));
      if (c === '\r' && text[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.substring(start));
  return lines;
}
