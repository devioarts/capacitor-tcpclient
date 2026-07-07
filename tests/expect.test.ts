import assert from 'node:assert/strict';
import test from 'node:test';

import { parseExpectBytes } from '../src/utils/expect';

function bytes(value: Uint8Array | null): number[] | null {
  return value == null ? null : Array.from(value);
}

test('parseExpectBytes treats empty expect values as absent', () => {
  assert.equal(parseExpectBytes(''), null);
  assert.equal(parseExpectBytes([]), null);
  assert.equal(parseExpectBytes(new Uint8Array()), null);
  assert.equal(parseExpectBytes(null), null);
  assert.equal(parseExpectBytes(undefined), null);
});

test('parseExpectBytes accepts supported hex spellings', () => {
  assert.deepEqual(bytes(parseExpectBytes('1b40')), [0x1b, 0x40]);
  assert.deepEqual(bytes(parseExpectBytes('0x1b 0x40')), [0x1b, 0x40]);
  assert.deepEqual(bytes(parseExpectBytes('1B 40')), [0x1b, 0x40]);
});

test('parseExpectBytes rejects invalid byte and hex inputs', () => {
  assert.equal(parseExpectBytes([1, 256]), null);
  assert.equal(parseExpectBytes([1, -1]), null);
  assert.equal(parseExpectBytes([1, 1.5]), null);
  assert.equal(parseExpectBytes('abc'), null);
  assert.equal(parseExpectBytes('zz'), null);
});

test('parseExpectBytes defensively copies mutable inputs', () => {
  const input = new Uint8Array([1, 2, 3]);
  const parsed = parseExpectBytes(input);
  input[0] = 9;
  assert.deepEqual(bytes(parsed), [1, 2, 3]);
});
