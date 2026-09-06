/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';

/** Real WASM boundary equivalence and source lifetime regression for #3989. */
export function checkPrepassSourceContract(IfcAPI, sources) {
  const api = new IfcAPI();
  try {
    for (const bytes of sources) {
      const expected = api.scanEntityIndexShard(bytes, 0, bytes.length);
      assert.ok(expected.ids.length > 0, 'fixture must contain actual IFC entities');
      api.setSourceBytes(bytes);
      const actual = api.scanEntityIndexShardFromSource(0, bytes.length);
      assert.deepEqual(actual, expected, 'owned-source shard must preserve all columns and refusals');
      api.setEntityIndex(actual.ids, actual.starts, actual.lengths);
      assert.deepEqual(actual, expected, 'owned Rust adapter must not detach or mutate JS input columns');
      assert.deepEqual(api.scanEntityIndexShardFromSource(0, bytes.length), expected,
        'installing the same load index must preserve its preinstalled source');
      const decoder = new TextDecoder();
      const spans = [];
      for (let i = 0; i < actual.ids.length; i++) {
        const start = actual.starts[i], length = actual.lengths[i];
        const record = decoder.decode(bytes.subarray(start, start + Math.min(length, 100)));
        if (/=\s*IFCSTYLEDITEM\s*\(/i.test(record)) spans.push(actual.ids[i], start, length);
      }
      const styleSpans = new Uint32Array(spans);
      const styles = api.resolveStyledItemsShard(bytes, styleSpans);
      if (styleSpans.length > 0) assert.ok(styles.geomIds.length + styles.orphanIds.length > 0,
        'styled fixture must exercise nonempty canonical style resolution');
      assert.deepEqual(api.resolveStyledItemsShardFromSource(styleSpans), styles,
        'style recursion must see the same full source and referenced entities');
      const empty = new Uint32Array();
      const args = [styles.orphanIds, styles.orphanColors, styles.geomIds, styles.geomColors,
        empty, empty, empty, empty, empty, empty, 1];
      assert.deepEqual(api.finalizePrepassStylesFromSource(...args),
        api.finalizePrepassStyles(bytes, ...args), 'same canonical style finalization');
      // Exercise replacement WITHOUT intervening cleanup on the next fixture.
    }
    api.clearPrePassCache();
    assert.equal(api.scanEntityIndexShardFromSource(0, 100000).ids.length, 0,
      'clearPrePassCache must release the installed source');
  } finally {
    api.clearPrePassCache();
    api.free();
  }
}
