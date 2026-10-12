import { describe, expect, test } from 'vitest';
import { isInstructionLine, stripComments } from '../src/cpu/Parser';

describe('comments and quotes', () => {
  test('a ; inside a character literal or string does not start a comment', () => {
    expect(stripComments("MVI A, ';' ; comment")).toBe("MVI A, ';' ");
    expect(stripComments('X "a;b" ; c')).toBe('X "a;b" ');
    expect(stripComments('MVI A, 1 ; x\nMVI B, 2;y')).toBe('MVI A, 1 \nMVI B, 2');
  });

  test('an unmatched quote does not hide a later comment', () => {
    expect(stripComments("MVI A, ' ; c")).toBe("MVI A, ' ");
    expect(stripComments('MVI A, " ; c')).toBe('MVI A, " ');
  });

  test('breakpoint lines use the same comment rule', () => {
    expect(isInstructionLine("  MVI A, ';'")).toBe(true);
    expect(isInstructionLine('; MVI A, 1')).toBe(false);
    expect(isInstructionLine('my_label: ; only a label')).toBe(false);
  });
});
