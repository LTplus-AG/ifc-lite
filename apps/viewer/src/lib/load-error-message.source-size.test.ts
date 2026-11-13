// SPDX-License-Identifier: MPL-2.0
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { WasmSourceSizeError } from '@ifc-lite/parser';
import { formatLoadError } from './load-error-message.js';
it('explains the hard source boundary separately from real OOM (huge-file report)', () => {
  assert.match(formatLoadError(new WasmSourceSizeError()), /smaller than 2 GiB/);
  assert.doesNotMatch(formatLoadError(new WasmSourceSizeError()), /closing other tabs/);
  assert.match(formatLoadError(new Error('out of memory')), /closing other tabs/);
});
