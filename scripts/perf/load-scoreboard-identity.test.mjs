/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reopen output identity: a reopen matches only when it restored its own cold
// open's geometry and every snapshot it adopted equals one an earlier open
// wrote. Missing input is never a match.

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
const cap = (sig) => ({ kind: 'written', sig, batches: 3 });
const adopt = (sig) => ({ kind: 'adopted', sig, batches: 3 });

test('a streamed reopen with the cold pieces matches; an adopted snapshot must equal an earlier written one', async () => {
  const { reopenIdentityVerdict } = await load('./load-scoreboard-identity.mjs');
  const cold = { label: 'cold', identity: id('P', [cap('S1')]) };
  const streamed = reopenIdentityVerdict([cold, { label: 'warm1', identity: id('P') }], 1);
  assert.equal(streamed.match, true, streamed.verdict);
  assert.match(streamed.verdict, /streamed/);
  const adopted = reopenIdentityVerdict([cold, { label: 'warm1', identity: id('P') }, { label: 'warm2', identity: id('P', [adopt('S1')]) }], 2);
  assert.equal(adopted.match, true, adopted.verdict);
  assert.equal(adopted.adopted, 1);
});

test('the altered-snapshot control: an adopted snapshot no open wrote is a RESTORE MISMATCH', async () => {
  const { reopenIdentityVerdict } = await load('./load-scoreboard-identity.mjs');
  const v = reopenIdentityVerdict([{ label: 'cold', identity: id('P', [cap('S1')]) }, { label: 'warm1', identity: id('P', [adopt('S1-altered')]) }], 1);
  assert.equal(v.match, false);
  assert.match(v.verdict, /^RESTORE MISMATCH vs cold: adopted S1-altered equals no snapshot an earlier open wrote/);
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
  const { identityRowReopens, identityWanted } = await load('./load-scoreboard-identity.mjs');
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
  const cold = (side, fp = 'elements=2 sig=abc') => ({ group: 'browser', lane: 'browser-cold', fixture: 'F', round: 0, side, ok: true, interactiveMs: 100, fingerprint: fp });
  const without = summarize(plan, [timed('base'), timed('branch')]);
  assert.match(without.fixtures[0].lanes['browser-warm'].output, /^unverifiable/, 'timed rows alone stay unverifiable');
  const withId = summarize(plan, [cold('base'), cold('branch'), timed('base'), timed('branch'), idRow('base'), idRow('branch')]);
  assert.equal(withId.fixtures[0].lanes['browser-warm'].output, 'match');
  assert.equal(withId.fixtures[0].lanes['browser-warm'].outputSource, 'identity pass');
});

test('review #9863: the cold lane links the sides, timed RESTORE MISMATCH wins, failed samples never match', async () => {
  const { reopenOutputVerdict, laneIdentityVerdict, identityRowReopens } = await load('./load-scoreboard-identity.mjs');
  assert.equal(reopenOutputVerdict('match', 'unverifiable (x)', 'match'), 'match');
  assert.match(reopenOutputVerdict('match', 'unverifiable (x)', 'CHANGED'), /^CHANGED \(cold output CHANGED across sides/, 'different builds never read as matching');
  assert.match(reopenOutputVerdict('match', 'unverifiable (x)', 'unverifiable (a sample has no output identity)'), /^unverifiable \(each reopen restored its own cold open, but the cold lane/);
  assert.match(reopenOutputVerdict('match', 'RESTORE MISMATCH vs cold: flat 1/2', 'match'), /^RESTORE MISMATCH vs cold/, 'a timed restore failure is never hidden');
  assert.equal(reopenOutputVerdict('match', 'CHANGED', 'match'), 'CHANGED', 'a timed CHANGED is never hidden (review #9863)');
  assert.equal(reopenOutputVerdict('match', 'VARIED within a side', 'match'), 'VARIED within a side', 'nor a timed VARIED');
  assert.equal(reopenOutputVerdict(null, 'unverifiable (x)', 'match'), null, 'no identity row: the timed verdict stands');
  const opens = [{ label: 'cold', identity: id('P', [cap('S1')]) }, { label: 'warm1', identity: id('P') }, { label: 'warm2', identity: id('P', [adopt('S1')]) }];
  const reopens = identityRowReopens({ meta: { identityOpens: opens }, lanes: { 'browser-warm1': { ok: true }, 'browser-warm': { ok: false, error: 'warm1: renderer crashed' } } }, 2);
  assert.equal(reopens['browser-warm1'].match, true, 'an earlier clean reopen keeps its verdict');
  assert.match(reopens['browser-warm'].verdict, /^UNVERIFIABLE \(identity sample failed: warm1: renderer crashed/);
});

test('review #9863: a reopen lane whose cold output differs across sides reads CHANGED in the report', async () => {
  const { identityRowReopens } = await load('./load-scoreboard-identity.mjs');
  const { summarize } = await load('./load-scoreboard-report.mjs');
  const opens = [{ label: 'cold', identity: id('P', [cap('S1')]) }, { label: 'warm1', identity: id('P') }, { label: 'warm2', identity: id('P', [adopt('S1')]) }];
  const reopens = identityRowReopens({ meta: { identityOpens: opens } }, 2);
  const plan = { name: 'id', kind: 'compare', lanes: ['browser-cold', 'browser-warm'], rounds: 1, warmOpens: 2, fixtures: [{ name: 'F', set: 'tuning', bytes: 2 ** 25 }],
    sides: { base: { label: 'a' }, branch: { label: 'b' } } };
  const row = (lane, side, fingerprint) => ({ group: 'browser', lane, fixture: 'F', round: 0, side, ok: true, interactiveMs: 100, fingerprint });
  const rows = [row('browser-cold', 'base', 'elements=2 sig=aaa'), row('browser-cold', 'branch', 'elements=2 sig=bbb'),
    row('browser-warm', 'base', 'UNVERIFIABLE (cache hit)'), row('browser-warm', 'branch', 'UNVERIFIABLE (cache hit)'),
    { group: 'browser', lane: 'identity', fixture: 'F', round: 0, side: 'base', ok: true, reopens }, { group: 'browser', lane: 'identity', fixture: 'F', round: 0, side: 'branch', ok: true, reopens }];
  const out = summarize(plan, rows).fixtures[0].lanes;
  assert.equal(out['browser-cold'].output, 'CHANGED');
  assert.match(out['browser-warm'].output, /^CHANGED \(cold output CHANGED across sides/);
});

test('review #9863: a clean earlier reopen keeps its match through identityRow when a later reopen failed', async () => {
  const { identityRow, laneIdentityVerdict } = await load('./load-scoreboard-identity.mjs');
  const opens = [{ label: 'cold', identity: id('P', [cap('S1')]) }, { label: 'warm1', identity: id('P', [adopt('S1')]) }, { label: 'warm2', identity: id('P', [adopt('S1')]) }];
  const sample = (side) => ({ meta: { identityOpens: opens }, lanes: { 'browser-cold': { ok: true }, 'browser-warm1': { ok: true }, 'browser-warm': { ok: false, error: 'warm2: GPU device lost' } } });
  const rows = ['base', 'branch'].map((side) => identityRow({ fixture: 'F', side, round: 0, group: 'browser' }, sample(side), 2, () => {}));
  assert.equal(rows[0].ok, false, 'the row records the failed sample');
  assert.equal(laneIdentityVerdict(rows, 'browser-warm1'), 'match', 'warm1 was clean on both sides');
  assert.match(laneIdentityVerdict(rows, 'browser-warm'), /^unverifiable \(identity pass: UNVERIFIABLE \(identity sample failed: warm2: GPU device lost/);
});

test('review #9863: -early and -settled reopen lanes use the default-arm identity rows; the pass runs for them', async () => {
  const { identityLaneFor, identityWanted } = await load('./load-scoreboard-identity.mjs');
  assert.equal(identityLaneFor('browser-warm-early'), 'browser-warm');
  assert.equal(identityLaneFor('browser-warm1-settled'), 'browser-warm1');
  assert.equal(identityLaneFor('browser-cold-settled'), null);
  assert.equal(identityWanted({ warmOpens: 2, lanes: ['browser-cold', 'browser-warm-settled'] }, 0), true, 'a plan with only a suffixed reopen lane gets the pass');
});
