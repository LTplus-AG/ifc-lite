/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * The visibility half of a BCF viewpoint capture (#4509, #4529): what the
 * viewer's isolate / hide sets become in the viewpoint, and what the author is
 * told about entities that have no IfcGuid to record.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { captureVisibility, describeVisibilityNotice } from './visibility-capture';

/** Entities 1..3 are nameable; 4 and 5 are viewer-only (no GlobalId). */
const NAMED: Record<number, string> = { 1: 'GUID-1', 2: 'GUID-2', 3: 'GUID-3' };
const resolve = (id: number) => NAMED[id] ?? null;

describe('captureVisibility', () => {
  it('no isolation channel and nothing hidden: nothing to record', () => {
    assert.deepStrictEqual(captureVisibility(null, new Set(), resolve), {
      visibleGuids: undefined,
      hiddenGuids: undefined,
      notice: null,
    });
  });

  it('an isolate whose members are all nameable records the full allowlist', () => {
    const out = captureVisibility(new Set([1, 2]), new Set([3]), resolve);
    assert.deepStrictEqual(out.visibleGuids, ['GUID-1', 'GUID-2']);
    assert.equal(out.hiddenGuids, undefined, 'isolation wins: BCF Visibility expresses one mode');
    assert.equal(out.notice, null);
  });

  it('an isolate with SOME un-nameable members records the nameable ones and counts the rest (#4529)', () => {
    // A viewer-only entity does not exist in the recipient's model: "hiding"
    // it is vacuous, while omitting the whole component would turn a focused
    // topic into "show the whole model". Record what can be named, say the rest.
    const out = captureVisibility(new Set([1, 4]), new Set(), resolve);
    assert.deepStrictEqual(out.visibleGuids, ['GUID-1']);
    assert.deepStrictEqual(out.notice, { unnameable: 1, total: 2, kind: 'isolated', omitted: false });
    assert.match(describeVisibilityNotice(out.notice!), /1 of 2 isolated elements/);
  });

  it('an isolate with NO nameable member is omitted, not written as "nothing visible" (#4509)', () => {
    const out = captureVisibility(new Set([4, 5]), new Set(), resolve);
    assert.equal(out.visibleGuids, undefined);
    assert.deepStrictEqual(out.notice, { unnameable: 2, total: 2, kind: 'isolated', omitted: true });
    assert.match(describeVisibilityNotice(out.notice!), /without its visibility/);
    assert.doesNotMatch(describeVisibilityNotice(out.notice!), /\d+ of \d+/, 'the omission message is distinct from the partial one');
  });

  it('a genuinely empty isolate (active, matches nothing) records an empty allowlist', () => {
    const out = captureVisibility(new Set(), new Set([3]), resolve);
    assert.deepStrictEqual(out.visibleGuids, []);
    assert.equal(out.hiddenGuids, undefined, 'the hide-list is not consulted while an isolation channel is active');
    assert.equal(out.notice, null);
  });

  it('a hide-list with un-nameable members records the nameable ones and counts the rest', () => {
    const out = captureVisibility(null, new Set([2, 4]), resolve);
    assert.deepStrictEqual(out.hiddenGuids, ['GUID-2']);
    assert.deepStrictEqual(out.notice, { unnameable: 1, total: 2, kind: 'hidden', omitted: false });
    assert.match(describeVisibilityNotice(out.notice!), /1 of 2 hidden elements/);
  });

  it('a hide-list with no nameable member records nothing and says so', () => {
    const out = captureVisibility(null, new Set([4]), resolve);
    assert.equal(out.hiddenGuids, undefined);
    assert.deepStrictEqual(out.notice, { unnameable: 1, total: 1, kind: 'hidden', omitted: true });
  });
});
