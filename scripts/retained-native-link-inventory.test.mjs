// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkedPaths } from './retained-native-link-inventory.mjs';

test('Refs #7955 native inventory includes loader and resolved libraries, refusing missing or static closure', () => {
  assert.deepEqual(linkedPaths(`linux-vdso.so.1 (0x1234)
    libstdc++.so.6 => /lib/x86_64-linux-gnu/libstdc++.so.6 (0xabcd)
    libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0xefab)
    /lib64/ld-linux-x86-64.so.2 (0x1234)`), [
    '/lib/x86_64-linux-gnu/libc.so.6', '/lib/x86_64-linux-gnu/libstdc++.so.6', '/lib64/ld-linux-x86-64.so.2']);
  assert.throws(() => linkedPaths('libstdc++.so.6 => not found'), /Unresolved/);
  assert.throws(() => linkedPaths('statically linked'), /static linkage/);
});
