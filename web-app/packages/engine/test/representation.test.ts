import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { byteRepresentation, REPRESENTATIONS, shortRepresentation } from '../src';

const golden = JSON.parse(readFileSync(join(__dirname, 'golden-misc/representation.json'), 'utf8'));

test.each(REPRESENTATIONS)('DataRepresentation %s matches Java for all bytes and a short sweep', (rep) => {
  const bytes: string[] = [];
  for (let v = -128; v < 128; v++) bytes.push(byteRepresentation(v, rep));
  const shorts: string[] = [];
  for (let v = -32768; v < 32768; v += 257) shorts.push(shortRepresentation(v, rep));
  expect(bytes).toEqual(golden[rep].bytes);
  expect(shorts).toEqual(golden[rep].shorts);
});
