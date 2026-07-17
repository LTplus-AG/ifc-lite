/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The inline scan worker caches decoded type names by a compound
 * `length:hash` key. A 32-bit rolling hash can collide, so a cache hit must
 * verify the actual bytes before reusing the cached name — otherwise two
 * distinct type tokens sharing a hash + length silently alias. This exercises
 * the WORKER_CODE scanner directly by running it inside a mock `self`.
 */

import { describe, it, expect } from 'vitest';
import { WORKER_CODE } from '../src/scan-worker-inline.js';

function runWorkerScan(ifc: string): string[] {
    const buffer = new TextEncoder().encode(ifc).buffer;
    const mockSelf: Record<string, unknown> & {
        onmessage?: (e: { data: ArrayBuffer }) => void;
    } = {};
    let result: { types: string[] } | undefined;
    mockSelf.postMessage = (msg: { types: string[] }) => { result = msg; };
    // WORKER_CODE assigns `self.onmessage`; execute it with our mock as `self`.
    // eslint-disable-next-line no-new-func
    const install = new Function('self', WORKER_CODE) as (s: unknown) => void;
    install(mockSelf);
    mockSelf.onmessage!({ data: buffer });
    if (!result) throw new Error('worker did not postMessage a result');
    return result.types;
}

describe('scan-worker-inline type-name cache (hash-collision safety)', () => {
    it('does not alias two type names sharing a 32-bit hash + length', () => {
        // "Aa" and "BB" both have length 2 and the same rolling hash (4034), so
        // they map to the identical type-cache key. Without the byte-verify on a
        // cache hit, the second type ("BB") would be misread as the first ("Aa").
        const types = runWorkerScan('#1=Aa();\n#2=BB();\n');
        expect(types).toEqual(['Aa', 'BB']);
    });

    it('still reuses the cache for genuinely repeated type names', () => {
        const types = runWorkerScan('#1=IFCWALL();\n#2=IFCWALL();\n#3=IFCDOOR();\n');
        expect(types).toEqual(['IFCWALL', 'IFCWALL', 'IFCDOOR']);
    });
});
