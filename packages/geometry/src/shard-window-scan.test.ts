/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { scanShardWindowed, type ShardScanColumns } from './shard-window-scan.js';

const enc = new TextEncoder();

/** `#id=K(...);` records split on `;` outside quotes: enough of the scanner's contract to drive the window logic. */
function modelScan(bytes: Uint8Array, rangeStart: number, rangeEnd: number): ShardScanColumns {
  const text = new TextDecoder().decode(bytes);
  const ids: number[] = [], starts: number[] = [], lengths: number[] = [];
  let at = text.indexOf('#', rangeStart);
  let handoff = -1;
  while (at >= 0) {
    if (at >= rangeEnd) { handoff = at; break; }
    let end = at, quoted = false;
    for (; end < text.length; end++) {
      if (text[end] === "'") quoted = !quoted;
      else if (text[end] === ';' && !quoted) break;
    }
    if (end === text.length) break; // a record the bytes cut: dropped, as a malformed tail
    ids.push(Number(text.slice(at + 1, text.indexOf('=', at))));
    starts.push(at);
    lengths.push(end + 1 - at);
    at = text.indexOf('#', end + 1);
  }
  return { ids: Uint32Array.from(ids), starts: Uint32Array.from(starts), lengths: Uint32Array.from(lengths), classes: new Uint8Array(ids.length), handoff };
}

const plain = (s: ShardScanColumns | null) => s && { ids: [...s.ids], starts: [...s.starts], lengths: [...s.lengths], handoff: s.handoff };

describe('scanShardWindowed', () => {
  const file = enc.encode(`#1=A('x');\n#2=B('${'y'.repeat(300)}');\n#3=C();\n#4=D('a;b');\n#5=E();\n`);

  it('matches the whole-file scan for every range and margin, growing the window past a long record', () => {
    for (let from = 0; from < file.length; from += 7) {
      for (const to of [from + 5, from + 40, file.length]) {
        const end = Math.min(to, file.length);
        const whole = plain(modelScan(file, from, end));
        for (const margin of [1, 16, 1 << 20]) {
          const windows: number[] = [];
          const got = scanShardWindowed(file, from, end, (w, s, e) => { windows.push(w.length); return modelScan(w, s, e); }, margin);
          expect(plain(got), `range ${from}..${end} margin ${margin}`).toEqual(whole);
          expect(Math.max(...windows)).toBeLessThanOrEqual(file.length);
        }
      }
    }
  });

  it('copies only its range and margin when the handoff falls inside the window', () => {
    const sizes: number[] = [];
    const from = file.indexOf(0x23, 1); // `#2`: its shard starts one byte before it
    scanShardWindowed(file, from, from + 5, (w, s, e) => { sizes.push(w.length); return modelScan(w, s, e); }, 320);
    expect(sizes).toEqual([1 + 5 + 320]);
    expect(from + 5 + 320).toBeLessThan(file.length);
  });

  it('rejects a window whose tail is not whitespace before the handoff', () => {
    // A scanner that skipped a record the window cut and resumed at a later `#` reports a handoff
    // with that record's bytes before it: the window must grow rather than trust it.
    const calls: number[] = [];
    const skipping = (w: Uint8Array, s: number, e: number): ShardScanColumns => {
      calls.push(w.length);
      const r = modelScan(w, s, e);
      if (calls.length === 1) return { ...r, ids: r.ids.slice(0, 1), starts: r.starts.slice(0, 1), lengths: r.lengths.slice(0, 1) };
      return r;
    };
    const third = new TextDecoder().decode(file).indexOf('#3');
    const got = scanShardWindowed(file, 0, 30, skipping, third - 30 + 8); // the first window holds `#3`, not the end
    expect(calls[0]).toBeLessThan(file.length);
    expect(calls.length).toBe(2);
    expect(plain(got)).toEqual(plain(modelScan(file, 0, 30)));
  });

  it('accepts a closed comment between the last record and the handoff without growing the window', () => {
    const commented = enc.encode(`#1=A();\n/* exported */\n#2=B();\n${'#9=Z();\n'.repeat(40)}`);
    const sizes: number[] = [];
    const got = scanShardWindowed(commented, 0, 3, (w, s, e) => { sizes.push(w.length); return modelScan(w, s, e); }, 40);
    expect(sizes).toEqual([3 + 40]);
    expect(plain(got)).toEqual(plain(modelScan(commented, 0, 3)));
  });

  it('gives up past the largest margin instead of copying the file, for a shard inside one huge record', () => {
    // No record starts in the range: nothing can show that the window did not cut the record the shard is in.
    const huge = enc.encode(`#1=A('${'x'.repeat(4000)}');\n#2=B();\n${'#9=Z();\n'.repeat(400)}`);
    const sizes: number[] = [];
    const got = scanShardWindowed(huge, 100, 200, (w, s, e) => { sizes.push(w.length); return modelScan(w, s, e); }, 16, 1024);
    expect(got).toBeNull();
    expect(sizes).toEqual([1 + 100 + 16, 1 + 100 + 128, 1 + 100 + 1024]);
    expect(Math.max(...sizes)).toBeLessThan(huge.length);
  });
});

// Real wasm, never a mock. Skips when the runtime is not built (`bash scripts/build-wasm.sh`).
const WASM = fileURLToPath(new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const FIXTURES = [
  fileURLToPath(new URL('../../../apps/viewer/public/_fixtures/', import.meta.url)),
  fileURLToPath(new URL('../../../rust/processing/tests/fixtures/', import.meta.url)),
];

describe.skipIf(!existsSync(WASM))('scanShardWindowed over the real wasm scanner', () => {
  let scan: (bytes: Uint8Array, start: number, end: number) => ShardScanColumns;
  beforeAll(async () => {
    const wasm = await import('@ifc-lite/wasm');
    wasm.initSync({ module: readFileSync(WASM) });
    const api = new wasm.IfcAPI() as unknown as { scanEntityIndexShard: typeof scan };
    scan = (bytes, start, end) => api.scanEntityIndexShard(bytes, start, end);
  });

  const files = FIXTURES.filter(existsSync).flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.ifc')).map((f) => dir + f));

  it('gives every shard the whole-file scan\'s columns, classes and handoff', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const path of files) {
      const bytes = new Uint8Array(readFileSync(path));
      for (const shards of [2, 3, 8]) {
        for (let i = 0; i < shards; i++) {
          const from = Math.floor((i * bytes.length) / shards);
          const to = i + 1 === shards ? bytes.length : Math.floor(((i + 1) * bytes.length) / shards);
          const whole = scan(bytes, from, to);
          for (const margin of [64, 1 << 20]) {
            const got = scanShardWindowed(bytes, from, to, scan, margin);
            const label = `${path} shard ${i}/${shards} margin ${margin}`;
            expect(plain(got), label).toEqual(plain(whole));
            expect([...(got?.classes ?? [])], label).toEqual([...whole.classes]);
            expect([...(got?.oversizedIdStarts ?? [])], label).toEqual([...(whole.oversizedIdStarts ?? [])]);
          }
        }
      }
    }
  });
});
