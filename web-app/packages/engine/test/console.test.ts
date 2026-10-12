import { describe, expect, test } from 'vitest';
import { ConsoleModel, ConsoleOutputStream, writeConsoleLn } from '../src';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function cpuWrite(text: string) {
  const model = new ConsoleModel();
  const out = new ConsoleOutputStream(model);
  for (const b of ascii(text)) out.write(b);
  while (out.flush());
  return { model, out };
}

describe('ConsoleOutputStream (port semantics)', () => {
  test('first character prints the red [CPU KONZOLA] header, then monospace text', () => {
    const { model } = cpuWrite('Hi');
    expect(model.getText()).toBe('[CPU KONZOLA]\nHi');
    const pars = model.paragraphs();
    expect(pars[0].style).toEqual({ color: 'red', monospace: false });
    expect(pars[1].style).toEqual({ color: 'black', monospace: true });
  });

  test('LF starts a new line keeping the caret column', () => {
    const { model } = cpuWrite('abc\nd');
    expect(model.getText()).toBe('[CPU KONZOLA]\nabc\n   d');
  });

  test('CR returns to the line start and further characters overwrite', () => {
    const { model } = cpuWrite('hello\rJ');
    expect(model.getText()).toBe('[CPU KONZOLA]\nJello');
  });

  test('header is printed once per run (setUnused) and on a new line', () => {
    const model = new ConsoleModel();
    const out = new ConsoleOutputStream(model);
    out.write(65);
    out.flush();
    out.write(66);
    out.flush();
    out.setUnused();
    out.write(67);
    out.flush();
    expect(model.getText()).toBe('[CPU KONZOLA]\nAB\n[CPU KONZOLA]\nC');
  });

  test('write(byte[]) writes every byte, including the last one', () => {
    const model = new ConsoleModel();
    const out = new ConsoleOutputStream(model);
    out.writeBytes(ascii('abc!'));
    out.flush();
    expect(model.getText()).toBe('[CPU KONZOLA]\nabc!');
  });

  test('negative byte values become (char) b', () => {
    const { model } = cpuWrite('');
    const out = new ConsoleOutputStream(model);
    out.write(-56);
    out.flush();
    expect(model.getText().endsWith(String.fromCharCode(0xffc8))).toBe(true);
  });

  test('clearBuffer discards pending characters (Stop)', () => {
    const model = new ConsoleModel();
    const out = new ConsoleOutputStream(model);
    out.write(65);
    out.clearBuffer();
    out.flush();
    expect(model.getText()).toBe('');
  });

  test('flush is throttled to 15 ms per call', () => {
    let t = 0;
    const model = new ConsoleModel();
    const out = new ConsoleOutputStream(model, 'black', () => (t += 4));
    for (let i = 0; i < 100; i++) out.write(65);
    expect(out.flush()).toBe(true);
    expect(model.getText().length).toBeLessThan(30);
  });
});

describe('writeConsoleLn', () => {
  test('starts on a new line when the current one is not empty and colours the paragraph', () => {
    const model = new ConsoleModel();
    writeConsoleLn(model, 'Program úspešne zavedený!', 'green');
    writeConsoleLn(model, '[Parser] [1] chyba', 'red');
    expect(model.getText()).toBe('Program úspešne zavedený!\n[Parser] [1] chyba\n');
    expect(model.paragraphs().map((p) => p.style.color)).toEqual(['green', 'red', 'red']);
  });
});
