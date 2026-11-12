/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reopen output identity: a reopen matches only when it restored its own cold
// open's geometry and every snapshot it adopted equals one an earlier open
// captured. Missing input is never a match.

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function load(path) {
  let failure = null;
  const mod = await import(path).catch((error) => { failure = error; return null; });
  assert.ok(mod, `${path} did not load (${failure?.name ?? 'unknown'})`);
  return mod;
}

const id = (sig, snapshots = [], perElement = { 1: 'a', 2: 'b' }) => ({ tap: true, pending: 0, hydrating: false, finalizing: false,
  pieces: { pieces: 2, elements: Object.keys(perElement).length, sig, perElement }, snapshots });
const cap = (sig) => ({ kind: 'captured', sig, batches: 3 });
const adopt = (sig) => ({ kind: 'adopted', sig, batches: 3 });

test('a streamed reopen with the cold pieces matches; an adopted snapshot must equal an earlier capture', async () => {
  const { reopenIdentityVerdict } = await load('./load-scoreboard-identity.mjs');
  const cold = { label: 'cold', identity: id('P', [cap('S1')]) };
  const streamed = reopenIdentityVerdict([cold, { label: 'warm1', identity: id('P') }], 1);
  assert.equal(streamed.match, true, streamed.verdict);
  assert.match(streamed.verdict, /streamed/);
  const adopted = reopenIdentityVerdict([cold, { label: 'warm1', identity: id('P') }, { label: 'warm2', identity: id('P', [adopt('S1')]) }], 2);
  assert.equal(adopted.match, true, adopted.verdict);
  assert.equal(adopted.adopted, 1);
});

test('the altered-snapshot control: an adopted snapshot no open captured is a RESTORE MISMATCH', async () => {
  const { reopenIdentityVerdict } = await load('./load-scoreboard-identity.mjs');
  const v = reopenIdentityVerdict([{ label: 'cold', identity: id('P', [cap('S1')]) }, { label: 'warm1', identity: id('P', [adopt('S1-altered')]) }], 1);
  assert.equal(v.match, false);
  assert.match(v.verdict, /^RESTORE MISMATCH vs cold: adopted S1-altered equals no snapshot/);
  const unhashed = reopenIdentityVerdict([{ label: 'cold', identity: id('P', [cap('S1')]) }, { label: 'warm1', identity: id('P', [{ kind: 'adopted', sig: null, error: 'x' }]) }], 1);
  assert.match(unhashed.verdict, /^RESTORE MISMATCH/, 'an adopted snapshot that was not hashed is not a match');
});

test('changed, missing or extra elements are a RESTORE MISMATCH naming them', async () => {
  const { reopenIdentityVerdict } = await load('./load-scoreboard-identity.mjs');
  const v = reopenIdentityVerdict([{ label: 'cold', identity: id('P') }, { label: 'warm1', identity: id('Q', [], { 1: 'a', 2: 'CHANGED', 3: 'new' }) }], 1);
  assert.equal(v.match, false);
  assert.match(v.verdict, /1 changed, 0 missing, 1 extra \(e\.g\. 2, 3\)/);
});

test('no tap, an unsettled read or no pieces is UNVERIFIABLE, never a match', async () => {
  const { reopenIdentityVerdict } = await load('./load-scoreboard-identity.mjs');
  const cold = { label: 'cold', identity: id('P') };
  assert.match(reopenIdentityVerdict([cold, { label: 'warm1', identity: { tap: false, error: 'no hook' } }], 1).verdict, /^UNVERIFIABLE \(no identity tap/);
  assert.match(reopenIdentityVerdict([cold, { label: 'warm1', identity: { ...id('P'), error: 'not settled' } }], 1).verdict, /^UNVERIFIABLE \(not settled/);
  assert.match(reopenIdentityVerdict([{ label: 'cold', identity: id('P', [], {}) }, { label: 'warm1', identity: id('P', [], {}) }], 1).verdict, /^UNVERIFIABLE \(no geometry pieces/);
  assert.equal(reopenIdentityVerdict([], 1).match, false, 'nothing recorded');
});

test('a lane matches only when both sides match; any mismatch wins; a missing side is unverifiable', async () => {
  const { laneIdentityVerdict } = await load('./load-scoreboard-identity.mjs');
  const row = (side, verdict, match) => ({ lane: 'identity', side, reopens: { 'browser-warm': { verdict, match } } });
  assert.equal(laneIdentityVerdict([row('base', 'match (x)', true), row('branch', 'match (x)', true)], 'browser-warm'), 'match');
  assert.match(laneIdentityVerdict([row('base', 'match (x)', true), row('branch', 'RESTORE MISMATCH vs cold: y', false)], 'browser-warm'), /^RESTORE MISMATCH/);
  assert.match(laneIdentityVerdict([row('branch', 'match (x)', true)], 'browser-warm'), /^unverifiable \(identity pass missing on a side/);
  assert.match(laneIdentityVerdict([row('base', 'UNVERIFIABLE (no identity tap in this build)', false), row('branch', 'match (x)', true)], 'browser-warm'), /^unverifiable \(identity pass: UNVERIFIABLE/);
  assert.equal(laneIdentityVerdict([row('base', 'match', true)], 'browser-warm1'), null, 'no row for the lane: the timed verdict stands');
});

test('identity rows map reopen i to its lane, and the report takes the reopen output from them', async () => {
  const { identityRowReopens, identityWanted } = await load('./load-scoreboard.mjs');
  const { summarize } = await load('./load-scoreboard-report.mjs');
  const opens = [{ label: 'cold', identity: id('P', [cap('S1')]) }, { label: 'warm1', identity: id('P') }, { label: 'warm2', identity: id('P', [adopt('S1')]) }];
  const reopens = identityRowReopens({ meta: { identityOpens: opens } }, 2);
  assert.deepEqual(Object.keys(reopens).sort(), ['browser-warm', 'browser-warm1']);
  assert.equal(reopens['browser-warm'].adopted, 1, 'open 2 of 2 is browser-warm');
  assert.equal(identityWanted({ warmOpens: 2, lanes: ['browser-warm'] }, 0), true);
  assert.equal(identityWanted({ warmOpens: 2, lanes: ['browser-warm'] }, 1), false, 'round 0 only');
  assert.equal(identityWanted({ warmOpens: 2, lanes: ['browser-warm'], identityPass: false }, 0), false, 'a plan can turn it off');
  const plan = { name: 'id', kind: 'compare', lanes: ['browser-warm'], rounds: 1, warmOpens: 2, fixtures: [{ name: 'F', set: 'tuning', bytes: 2 ** 25 }],
    sides: { base: { label: 'a' }, branch: { label: 'b' } } };
  const timed = (side) => ({ group: 'browser', lane: 'browser-warm', fixture: 'F', round: 0, side, ok: true, interactiveMs: 100,
    fingerprint: 'UNVERIFIABLE (cache hit: no element hashes, instanced output not readable; flat output restored exactly)' });
  const idRow = (side) => ({ group: 'browser', lane: 'identity', fixture: 'F', round: 0, side, ok: true, reopens });
  const without = summarize(plan, [timed('base'), timed('branch')]);
  assert.match(without.fixtures[0].lanes['browser-warm'].output, /^unverifiable/, 'timed rows alone stay unverifiable');
  const withId = summarize(plan, [timed('base'), timed('branch'), idRow('base'), idRow('branch')]);
  assert.equal(withId.fixtures[0].lanes['browser-warm'].output, 'match');
  assert.equal(withId.fixtures[0].lanes['browser-warm'].outputSource, 'identity pass');
});
