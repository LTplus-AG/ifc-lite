/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The swap must be IN PLACE, and the original bytes must actually become
 * collectable (#2183).
 *
 * These are the two ways this feature ships as a fake win, and neither is
 * visible to a byte-equivalence test:
 *
 *   1. **Split brain.** `attachDataStoreAccessors` captures the accessor in a
 *      `BufferEntitySource` whose `EntityExtractor` holds it for the store's
 *      lifetime, so `store.getEntity` reads through THAT object. But
 *      `store.getProperties` goes through `extractPropertiesOnDemand`, which
 *      builds a fresh extractor from `store.source` on every call. Replacing
 *      the `source` property instead of mutating the object therefore leaves
 *      entities served from the old resident buffer and properties from the
 *      compressed one -- both alive, no memory saved, and the two read paths
 *      silently disagreeing. Asserting through the ATTACHED accessors is what
 *      catches it, which is why these do not construct extractors directly.
 *
 *   2. **Retention.** Everything can read correctly while the original buffer
 *      is still reachable, in which case the model uses MORE memory than
 *      before, not less. Only a liveness probe can see that.
 */

import { describe, expect, it } from 'vitest';

import { attachDataStoreAccessors } from '../src/data-store-accessors.js';
import { contiguousSourceBytes, compressSourceInPlace } from '../src/source-bytes.js';
import { compressSource } from '../src/source-compress.js';
import { IfcParser } from '../src/index.js';
import type { IfcDataStore } from '../src/columnar-parser.js';

/** A small but real STEP file: several entities with properties attached. */
const STEP = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#1=IFCWALL('0YvCT2_$X3_xJG3rzD8L_1',$,'Wand-Süd é',$,$,$,$,$,$);",
  "#2=IFCWALL('0YvCT2_$X3_xJG3rzD8L_2',$,'Wall-North',$,$,$,$,$,$);",
  "#3=IFCSLAB('0YvCT2_$X3_xJG3rzD8L_3',$,'Floor',$,$,$,$,$,$);",
  "#4=IFCPROPERTYSINGLEVALUE('Rating',$,IFCLABEL('A+'),$);",
  "#5=IFCPROPERTYSET('0YvCT2_$X3_xJG3rzD8L_5',$,'Pset_Wall',$,(#4));",
  "#6=IFCRELDEFINESBYPROPERTIES('0YvCT2_$X3_xJG3rzD8L_6',$,$,$,(#1),#5);",
  'ENDSEC;',
  'END-ISO-10303-21;',
].join('\n');

async function parsedStore(bytes: Uint8Array): Promise<IfcDataStore> {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new IfcParser().parseColumnar(ab, { disableWorkerScan: true });
}

/** Everything the attached accessors can answer, as comparable data. */
function readEverything(store: IfcDataStore): unknown {
  const ids = [...store.entityIndex.byId.keys()].sort((a, b) => a - b);
  return ids.map((id) => ({
    id,
    entity: store.getEntity(id),
    properties: store.getProperties?.(id) ?? null,
    quantities: store.getQuantities?.(id) ?? null,
  }));
}

describe('in-place compression swap (#2183)', () => {
  it('keeps every ATTACHED accessor answering identically', async () => {
    const bytes = new TextEncoder().encode(STEP);
    const before = await parsedStore(bytes);
    const after = await parsedStore(bytes);

    const expected = readEverything(before);
    // Sanity: the fixture must actually produce entities, or comparing two
    // empty arrays would pass while asserting nothing.
    expect(Array.isArray(expected) && (expected as unknown[]).length).toBeGreaterThan(3);

    const payload = compressSource(after.source.materialize(), 64);
    expect(compressSourceInPlace(after.source, payload)).toBe(true);
    expect(after.source.isResident).toBe(false);

    // getEntity goes through the CAPTURED BufferEntitySource; getProperties
    // builds a fresh extractor from store.source per call. A replacement swap
    // makes these two disagree. Comparing the whole read surface catches it.
    expect(readEverything(after)).toEqual(expected);
  });

  it('lets a reference captured BEFORE the swap read compressed bytes', async () => {
    const bytes = new TextEncoder().encode(STEP);
    const store = await parsedStore(bytes);

    // Exactly what BufferEntitySource does: hold the accessor object.
    const captured = store.source;
    const wantHead = captured.decodeUtf8(0, 20);

    compressSourceInPlace(store.source, compressSource(store.source.materialize(), 64));

    expect(captured).toBe(store.source);
    expect(captured.isResident).toBe(false);
    expect(captured.decodeUtf8(0, 20)).toBe(wantHead);
  });

  it('keeps contentKey identical across the swap', async () => {
    const bytes = new TextEncoder().encode(STEP);
    const store = await parsedStore(bytes);
    const before = store.source.contentKey;
    compressSourceInPlace(store.source, compressSource(store.source.materialize(), 64));
    // A changed key invalidates every per-source cache downstream, which reads
    // as overlays silently re-parsing or vanishing.
    expect(store.source.contentKey).toBe(before);
  });

  it('is idempotent', async () => {
    const bytes = new TextEncoder().encode(STEP);
    const store = await parsedStore(bytes);
    const payload = compressSource(store.source.materialize(), 64);
    compressSourceInPlace(store.source, payload);
    const head = store.source.decodeUtf8(0, 30);
    // A second call must not re-compress already-compressed bytes.
    compressSourceInPlace(store.source, payload);
    expect(store.source.decodeUtf8(0, 30)).toBe(head);
  });

  it('lets a callback finish safely when the swap happens mid-materialize', async () => {
    const bytes = new TextEncoder().encode(STEP);
    const store = await parsedStore(bytes);
    const payload = compressSource(store.source.materialize(), 64);

    store.source.withMaterialized((buf) => {
      compressSourceInPlace(store.source, payload);
      // The callback holds a real Uint8Array. It stays valid and correct after
      // the switch -- it just stops being the source's storage. Reading it
      // after the swap is the case that would break if the swap detached or
      // reused the buffer.
      expect(buf.byteLength).toBe(bytes.byteLength);
      expect(new TextDecoder().decode(buf.subarray(0, 13))).toBe('ISO-10303-21;');
    });

    expect(store.source.isResident).toBe(false);
    expect(store.source.decodeUtf8(0, 13)).toBe('ISO-10303-21;');
  });

  it('shares ONE inflated buffer across nested materialization windows', async () => {
    // Two overlapping whole-file consumers must not each allocate the source.
    const bytes = new TextEncoder().encode(STEP.repeat(20));
    const store = await parsedStore(bytes);
    compressSourceInPlace(store.source, compressSource(store.source.materialize(), 64));

    let outer: Uint8Array | null = null;
    let inner: Uint8Array | null = null;
    store.source.withMaterialized((a) => {
      outer = a;
      store.source.withMaterialized((b) => { inner = b; });
    });
    expect(outer).not.toBe(null);
    expect(inner).toBe(outer);
  });
});

/**
 * Liveness. Requires `--expose-gc`, and HARD-FAILS without it rather than
 * skipping: a lane that loses the flag must turn red, not quietly green.
 */
describe('the original buffer becomes collectable', () => {
  const gc = (globalThis as { gc?: () => void }).gc;

  async function collect(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      gc!();
      await new Promise((r) => setImmediate(r));
    }
  }

  it('exposes gc, or this whole file is decorative', () => {
    expect(
      typeof gc,
      'run vitest with --expose-gc; without it the release test cannot observe anything',
    ).toBe('function');
  });

  /**
   * Built in a nested scope that RETURNS the probe but never the view.
   *
   * A local `const view = store.source.materialize()` in the test body pins
   * the buffer for the whole test, so the probe could never clear and the
   * assertion would be unfalsifiable. (It was, in the first draft of this
   * file: a leak mutation passed 9/9.) `compressSource` copies -- including on
   * the stored-verbatim path -- so the payload does not alias the view either.
   */
  async function arrange(): Promise<{
    store: IfcDataStore;
    probe: WeakRef<Uint8Array>;
    payload: ReturnType<typeof compressSource>;
  }> {
    const store = await parsedStore(new TextEncoder().encode(STEP.repeat(200)));
    const view = store.source.materialize();
    return { store, probe: new WeakRef(view), payload: compressSource(view, 1024) };
  }

  it('drops the resident buffer after the swap, while the store stays alive', async () => {
    const { store, probe, payload } = await arrange();

    // CONTROL FIRST. If the probe cannot observe retention at all, the
    // assertion below would pass for the wrong reason. Proving the detector
    // works is what stops this being a test that cannot fail.
    await collect();
    expect(probe.deref(), 'control: the source still holds the buffer before the swap')
      .not.toBe(undefined);

    compressSourceInPlace(store.source, payload);
    await collect();

    // THE assertion this whole feature rests on: nothing still reaches the
    // original bytes, so the 275 MB is genuinely returned rather than merely
    // duplicated into blocks.
    expect(probe.deref(), 'the original source buffer is still reachable after the swap')
      .toBe(undefined);

    // ...and the store, still strongly held, keeps working from blocks.
    expect(store.source.isResident).toBe(false);
    expect(store.getEntity(1), 'the store must still work after its bytes went away')
      .toBeTruthy();
    expect(store.getProperties?.(1)).toBeDefined();
  });

  it('a deliberately leaked reference SURVIVES gc (proves the probe detects retention)', async () => {
    const bytes = new TextEncoder().encode(STEP.repeat(200));
    const store = await parsedStore(bytes);
    const leaked = store.source.materialize();
    const probe = new WeakRef(leaked);

    compressSourceInPlace(store.source, compressSource(leaked, 1024));
    await collect();
    // `leaked` is deliberately still in scope here -- that is the point.

    // Held by `leaked`, so it must NOT be collected. If this ever fails, the
    // harness's gc semantics changed and the sibling test above has stopped
    // meaning anything -- this fails loudly instead of that passing quietly.
    expect(probe.deref(), 'a strongly-held buffer was collected; the probe is broken')
      .not.toBe(undefined);
    expect(leaked.byteLength).toBeGreaterThan(0);
  });
});
