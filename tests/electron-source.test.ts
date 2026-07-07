import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('electron byte conversion validates length before allocation', () => {
  const source = readFileSync(join(process.cwd(), 'electron/src/index.ts'), 'utf8');
  const methodStart = source.indexOf('private jsArrToBuf');
  assert.notEqual(methodStart, -1);

  const typedArrayBranch = source.indexOf('if (arr instanceof Uint8Array)', methodStart);
  const typedArrayGuard = source.indexOf('if (arr.length > MAX_BUFFER_BYTES) return null;', typedArrayBranch);
  const typedArrayAllocation = source.indexOf('return Buffer.from(arr);', typedArrayBranch);

  assert.ok(typedArrayBranch > methodStart);
  assert.ok(typedArrayGuard > typedArrayBranch);
  assert.ok(typedArrayGuard < typedArrayAllocation);

  const arrayGuard = source.indexOf('if (arr.length > MAX_BUFFER_BYTES) return null;', typedArrayAllocation);
  const arrayAllocation = source.indexOf('Buffer.alloc(arr.length)', methodStart);

  assert.ok(arrayGuard > typedArrayAllocation);
  assert.ok(arrayGuard < arrayAllocation);
});
