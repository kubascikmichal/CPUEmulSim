/**
 * Port of `App.CPUControl.DataRepresentation` - formatting of register / memory values.
 * Includes the original quirk: the 16-bit ASCII form uses `value >> 4` for the high character.
 */
export type Representation = 'Dec' | 'Hex' | 'Bin' | 'ASCII';

export const REPRESENTATIONS: readonly Representation[] = ['Dec', 'Hex', 'Bin', 'ASCII'];

/** `(char) x` - truncation to an unsigned 16-bit UTF-16 code unit. */
const javaChar = (x: number): string => String.fromCharCode(x & 0xffff);

/** Byte (Java signed) value. */
export function byteRepresentation(value: number, rep: Representation): string {
  const v = value & 0xff;
  switch (rep) {
    case 'Dec':
      return String(v);
    case 'Bin':
      return (v + 0x100).toString(2).substring(1);
    case 'Hex':
      return '0x' + (v + 0x100).toString(16).substring(1).toUpperCase();
    case 'ASCII': {
      const signed = (value << 24) >> 24;
      switch (signed) {
        case 8: return '[BACKSPACE]';
        case 9: return '[TAB]';
        case 10: return '[LF]';
        case 13: return '[CR]';
        case 27: return '[ESC]';
        case 32: return '[SPACE]';
        case 127: return '[DEL]';
        default: return javaChar(signed);
      }
    }
  }
}

/** Short (Java signed) value. */
export function shortRepresentation(value: number, rep: Representation): string {
  const v = value & 0xffff;
  switch (rep) {
    case 'Dec':
      return String(v);
    case 'Bin':
      return (v + 0x10000).toString(2).substring(1);
    case 'Hex':
      return '0x' + (v + 0x10000).toString(16).substring(1).toUpperCase();
    case 'ASCII': {
      const signed = (value << 16) >> 16;
      return javaChar(signed >> 4) + javaChar(signed);
    }
  }
}
