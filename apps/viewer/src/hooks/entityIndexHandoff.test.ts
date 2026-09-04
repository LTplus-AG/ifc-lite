/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3790: on the load path a large model takes in the browser, the parser
 * never scans the file -- the geometry pre-pass hands it the entity index and
 * the model is built from those columns. When that pre-pass stopped at a
 * record whose quoted string or block comment never closed, every record after
 * it is absent from the columns, and the flag saying so is the only evidence
 * that survives the hop. Drop it here and the user gets a partially loaded
 * model with the load reported as clean.
 *
 * The diagnostic itself is emitted downstream, by `scanIfcEntities` on the
 * `pre-scanned` path (pinned in
 * `packages/parser/src/entity-scanner.prescanned-malformed.test.ts`). What
 * this file pins is the hop the viewer owns: the flag reaching the parser
 * worker at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryProcessor } from '@ifc-lite/geometry';
import type { WorkerParser } from '@ifc-lite/parser/browser';
import { forwardEntityIndexTo, type EntityIndexSink } from './entityIndexHandoff.js';

/** The slot `useIfcLoader` assigns this callback to, read off `processAdaptive`
 *  itself so it cannot drift from what geometry actually accepts. */
type OnEntityIndex = NonNullable<
  NonNullable<Parameters<GeometryProcessor['processAdaptive']>[1]>['onEntityIndex']
>;

type Call = [Uint32Array, Uint32Array, Uint32Array, number | undefined, number | undefined];

function recordingSink(): { sink: EntityIndexSink; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    sink: {
      setEntityIndex(ids, starts, lengths, oversizedIdCount, malformedRecordCount) {
        calls.push([ids, starts, lengths, oversizedIdCount, malformedRecordCount]);
      },
    },
  };
}

const IDS = Uint32Array.from([1]);
const STARTS = Uint32Array.from([0]);
const LENGTHS = Uint32Array.from([10]);

describe('forwardEntityIndexTo (#3790 pre-pass handoff)', () => {
  it('forwards the malformed-record stop alongside the columns', () => {
    const { sink, calls } = recordingSink();

    forwardEntityIndexTo(sink)(IDS, STARTS, LENGTHS, 0, 1);

    assert.equal(calls.length, 1);
    assert.equal(calls[0][4], 1);
  });

  it('forwards the #3395 refusal count on the same call, not instead of it', () => {
    // Both numbers ride the same hop and are independently droppable -- a fix
    // that threads one and forgets the other is the failure this pins.
    const { sink, calls } = recordingSink();

    forwardEntityIndexTo(sink)(IDS, STARTS, LENGTHS, 3, 1);

    assert.equal(calls[0][3], 3);
    assert.equal(calls[0][4], 1);
  });

  it('passes a clean pre-pass through as 0, not as absent', () => {
    // A real zero is the statement "this producer reports, and it found none",
    // which is the only thing that makes a nonzero elsewhere mean anything.
    const { sink, calls } = recordingSink();

    forwardEntityIndexTo(sink)(IDS, STARTS, LENGTHS, 0, 0);

    assert.equal(calls[0][4], 0);
  });

  it('leaves an unreported count undefined rather than coercing it to 0', () => {
    // `undefined` means "this producer does not report", which is not the claim
    // `0` makes. The parser side decides what to do with the difference.
    const { sink, calls } = recordingSink();

    forwardEntityIndexTo(sink)(IDS, STARTS, LENGTHS);

    assert.equal(calls[0][3], undefined);
    assert.equal(calls[0][4], undefined);
  });

  it('is a no-op when the parser fell back to the main thread', () => {
    // `workerParserInstance` is null on that path; the callback still fires.
    assert.doesNotThrow(() => forwardEntityIndexTo(null)(IDS, STARTS, LENGTHS, 0, 1));
  });

  it('declares all five parameters, so a shortened forward is caught', () => {
    // The regression this guards: someone replaces the helper's body (or the
    // call site's use of it) with a four-argument forward. TypeScript cannot
    // see that -- the fifth parameter is optional on both sides, so dropping
    // it compiles -- but `Function.length` counts declared parameters before
    // the first optional one is bound, and this callback declares five.
    assert.equal(forwardEntityIndexTo(null).length, 5);
  });
});

/**
 * The two ends of the hop, pinned as types. Compile-time; `pnpm typecheck`
 * is what runs them.
 *
 * `useIfcLoader` holds its parser as `(WorkerParser & EntityIndexSink) | null`,
 * so the first is the same check the hook's own declaration makes: if
 * `WorkerParser.setEntityIndex` stops accepting the two counts, this fails to
 * compile rather than the numbers going quietly missing.
 *
 * The second is the other end, and it compares PARAMETER TUPLES rather than
 * the two function types. Plain assignability is no good here in either
 * direction: TypeScript lets a function with fewer parameters stand in for one
 * with more, so geometry could widen `onEntityIndex` with a sixth argument
 * while this handoff kept forwarding five and silently dropped it -- this
 * issue's own failure mode, one release later. Verified by mutation: an
 * optional sixth parameter added to geometry's callback leaves a both-ways
 * assignability check green, and turns this one red.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const _sinkIsTheParser: EntityIndexSink = null as unknown as WorkerParser;
const _handoffTakesExactlyTheSlotsArguments: Exactly<
  Parameters<OnEntityIndex>,
  Parameters<ReturnType<typeof forwardEntityIndexTo>>
> = true;
void _sinkIsTheParser;
void _handoffTakesExactlyTheSlotsArguments;
