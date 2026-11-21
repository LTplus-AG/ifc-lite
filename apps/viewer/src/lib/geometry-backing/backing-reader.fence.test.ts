/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10876: shard reads are fenced after the final yield, as mesh reads are: an
 * abort (or a stale generation) after the last shard was handed out rejects
 * the read instead of completing it as if every shard had been read.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { GeometryBackingRegistry } from './geometry-backing-registry';
import { instancedShard } from './geometry-backing.test-fixtures';

let names = 0;

for (const change of ['abort', 'stale'] as const) {
  it(`#10876 an ${change === 'abort' ? 'abort' : 'invalidation'} after the only shard was yielded rejects the read, never completes it`, async () => {
    const registry = await GeometryBackingRegistry.open({ name: `reader-fence-${process.pid}-${names++}`, locks: null });
    try {
      const backing = await registry.begin('m');
      await backing.writer.appendInstancedShard(instancedShard());
      await backing.writer.close();
      const controller = new AbortController();
      const shards = backing.reader.instancedShards({ signal: controller.signal });
      const first = await shards.next();
      assert.equal(first.done, false, 'the one shard is read');
      if (change === 'abort') controller.abort(new Error('superseded read'));
      else await registry.invalidate('m');
      await assert.rejects(shards.next(), 'the transition after the last yield is fenced');
    } finally { await registry.close(); }
  });
}
