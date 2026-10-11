/** `RAMContentWindow.updateContent` format (0.9.4): 16 bytes per row, hex left, ASCII right. */
import { expect, test } from 'vitest';
import { schematic } from '../src';

test('RAM content text: %04X address, %02X bytes, printable ASCII else "."', () => {
  const memory = new Int8Array(8192);
  memory[0] = 0x41; // 'A'
  memory[1] = 0x7e; // '~'
  memory[2] = 0x1f; // control → '.'
  memory[17] = -1; // 0xFF → '.'
  const { hex, ascii } = schematic.ramContentText(memory);
  const hexRows = hex.split('\n');
  const asciiRows = ascii.split('\n');
  expect(hexRows).toHaveLength(8192 / 16 + 1); // trailing newline
  expect(hexRows[0]).toBe('0000 41 7E 1F' + ' 00'.repeat(13));
  expect(hexRows[1]).toBe('0010 00 FF' + ' 00'.repeat(14));
  expect(hexRows[511].startsWith('1FF0 ')).toBe(true);
  expect(asciiRows[0]).toBe(' A ~ .' + ' .'.repeat(13));
});
