/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser } from '@ifc-lite/parser';
import { BinaryCacheReader, BinaryCacheWriter, SectionType, toCacheDataStore } from '@ifc-lite/cache';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { useIfcCache } from './useIfcCache.js';

const original = readFileSync(new URL('../../../../tests/fixtures/step-apostrophe-pair.ifc', import.meta.url), 'utf8');
let root: Root | null = null;
let container: HTMLElement | null = null;
let cache: ReturnType<typeof useIfcCache> | null = null;
function Probe() { cache = useIfcCache(); return null; }
beforeEach(async () => {
  useViewerStore.setState({ ifcDataStore: null, geometryResult: null });
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
  assert.ok(cache);
});
afterEach(async () => {
  const current = root; root = null;
  if (current) await act(async () => { current.unmount(); });
  container?.remove(); container = null; cache = null;
  useViewerStore.setState({ ifcDataStore: null, geometryResult: null, geometryStreamingActive: false });
});

describe('#7541 cache fallback scanner omission remains known at runtime export', () => {
  for (const clean of [false, true]) {
    it(`${clean ? 'valid' : 'malformed'} source index rebuild preserves its actual scanner verdict`, async () => {
      const text = clean ? original.replace("it's", "it''s").replace("Bob's", "Bob''s") : original;
      const source = new TextEncoder().encode(text).buffer;
      const parsed = await new IfcParser().parseColumnar(source, { disableWorkerScan: true });
      assert.equal(parsed.malformedRecordCount, clean ? 0 : 1);
      // Explicit older cache shape: actual parsed tables but no source index or
      // scan-provenance field. Production CURRENT admission does not erase them.
      const { entityIndex: oldIndex, malformedRecordCount: priorFlag, ...legacy } = toCacheDataStore(parsed);
      assert.ok(oldIndex && Array.from(oldIndex.byId).some(([id]) => id === 22));
      assert.equal(priorFlag, clean ? 0 : 1);
      const buffer = await new BinaryCacheWriter().write(legacy, undefined, source, { includeGeometry: false });
      const header = new BinaryCacheReader().readHeader(buffer);
      assert.equal(header.sections.some(section => section.type === SectionType.EntityIndex), false);
      await act(async () => {
        const result = await cache!.loadFromCache({ buffer, sourceBuffer: source }, 'legacy.ifc', 'legacy', undefined, undefined, () => false);
        assert.equal(result.success, true, 'actual hook must hydrate before testing the propagated verdict');
      });
      const store = useViewerStore.getState().ifcDataStore;
      assert.ok(store);
      assert.equal(store.entityIndex.byId.has(22), true);
      assert.equal(store.entityIndex.byId.has(20), clean);
      assert.equal(store.malformedRecordCount, clean ? 0 : 1);
      if (!clean) assert.throws(() => new StepExporter(store), /source index incomplete/);
      else assert.ok(new TextDecoder().decode(new StepExporter(store).export({ schema: 'IFC4' }).content).includes('#20=IFCWALL'));
    });
  }
});
