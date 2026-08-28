/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3345: a `TeardownScope` kind no contribution recognises used to be
 * silent. 22 of 28 contributions opened with
 * `if (scope.kind !== 'session-reset') return {};` — as correct for a scope
 * that does not exist yet as for `session-reset` itself, so adding a fourth
 * kind compiled clean, passed every existing test, and cleared none of the
 * state those 22 slices own.
 *
 * `SliceTeardownArms` (`teardown.ts`) closes the type-level half: an object
 * literal missing one of its (now four, if a kind is ever added) required
 * keys is a compile error in all 28 contribution files at once. This test
 * proves the runtime half — the shared switch `defineSliceTeardown` compiles
 * every arms record into now THROWS for a scope kind it does not recognise,
 * rather than quietly returning `{}` — which is what a contribution reached
 * through a stale `.d.ts` or a JS caller outside the type system would still
 * hit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { viewerTeardownRegistry } from './teardown-registry.js';
import type { TeardownScope, TeardownState } from './teardown.js';

describe('an unrecognised teardown scope kind fails loudly, not silently (#3345)', () => {
  it('every one of the 28 contributions throws, none silently returns {}', () => {
    // Not a real TeardownScope member — the point is that nothing in this
    // codebase can construct one under the type checker, so the only way to
    // reach this is a caller outside it (untyped JS, a stale build). The cast
    // simulates exactly that caller.
    const unknownScope = { kind: 'workspace-closed' } as unknown as TeardownScope;
    const state = {} as TeardownState;

    let thrown = 0;
    const silent: string[] = [];
    const wrongError: string[] = [];
    for (const entry of viewerTeardownRegistry) {
      try {
        const result = entry.teardown(unknownScope, state);
        if (Object.keys(result).length === 0) silent.push(entry.slice);
      } catch (err) {
        // Matched, not counted blindly: `state` is `{}`, so an arm that merely
        // READS state can throw a TypeError, and a bare `catch` would score
        // that as "correctly rejected the unknown kind" — the test would pass
        // for the wrong reason. Only the dispatcher's own refusal counts.
        if (err instanceof Error && /no teardown arm for scope kind/.test(err.message)) {
          thrown++;
        } else {
          wrongError.push(`${entry.slice}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    assert.deepStrictEqual(
      wrongError,
      [],
      'every throw must be the dispatcher refusing the unknown scope kind, not an ' +
        'incidental error from inside an arm',
    );

    assert.strictEqual(
      thrown,
      viewerTeardownRegistry.length,
      `expected all ${viewerTeardownRegistry.length} contributions to throw for an unrecognised scope ` +
        `kind; ${silent.length} silently returned {} instead: ${silent.join(', ')}`,
    );
  });
});
