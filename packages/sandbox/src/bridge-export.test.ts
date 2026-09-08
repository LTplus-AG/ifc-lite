/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.export` had zero behavioural coverage. `csv`, `json`, and `ifc` are
 * pure passthroughs to `sdk.export.*` with no independent logic — not
 * tested here beyond what `download`'s default shares with them, since a
 * passthrough test would only assert "a call happened," which this
 * project's calibration explicitly treats as padding.
 *
 * `download` has one real branch: `mimeType` defaults to `'text/plain'`
 * when falsy. That default is pinned here, including that it also fires
 * for an explicit empty string (the fallback is `||`, not `??`).
 */

import { describe, expect, it, vi } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { buildExportNamespace } from './bridge-export.js';
import type { BridgeCallContext } from './bridge-schema.js';

/** Bridge calls take a per-call context; these unit tests invoke `call:` directly. */
const CTX: BridgeCallContext = { sandboxSessionId: 'test' };

function findMethod(name: string) {
  const method = buildExportNamespace().methods.find((m) => m.name === name);
  if (!method) throw new Error(`no such method: ${name}`);
  return method;
}

function mockSdk() {
  return {
    export: {
      csv: vi.fn(),
      json: vi.fn(),
      ifc: vi.fn(),
      download: vi.fn(),
    },
  } as unknown as BimContext;
}

describe('bim.export.download — mimeType default', () => {
  it('passes an explicit mimeType through unchanged', () => {
    const sdk = mockSdk();
    findMethod('download').call(sdk, ['hello', 'a.txt', 'application/json'], CTX);
    expect(sdk.export.download).toHaveBeenCalledWith('hello', 'a.txt', 'application/json');
  });

  it('defaults to text/plain when mimeType is undefined', () => {
    const sdk = mockSdk();
    findMethod('download').call(sdk, ['hello', 'a.txt', undefined], CTX);
    expect(sdk.export.download).toHaveBeenCalledWith('hello', 'a.txt', 'text/plain');
  });

  it('also defaults to text/plain for an explicit empty string (|| , not ??)', () => {
    const sdk = mockSdk();
    findMethod('download').call(sdk, ['hello', 'a.txt', ''], CTX);
    expect(sdk.export.download).toHaveBeenCalledWith('hello', 'a.txt', 'text/plain');
  });
});
