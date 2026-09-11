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
import { captureVisibility, describeVisibilityNotice } from './visibility-capture.js';

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

  it('an isolate with SOME viewer-only members records the nameable ones and counts the rest (#4529)', () => {
    // A viewer-only entity does not exist in the recipient's model: "hiding"
    // it is vacuous, while omitting the whole component would turn a focused
    // topic into "show the whole model". Record what can be named, say the rest.
    const out = captureVisibility(new Set([1, 4]), new Set(), resolve);
    assert.deepStrictEqual(out.visibleGuids, ['GUID-1']);
    assert.deepStrictEqual(out.notice, { unnameable: 1, total: 2, kind: 'isolated', omitted: false, pending: false, ids: [4] });
    assert.equal(
      describeVisibilityNotice(out.notice!),
      'Viewpoint visibility is partial: 1 of 2 isolated element has no IFC GlobalId and will appear hidden to recipients.',
    );
  });

  it('pluralises the partial notice', () => {
    const out = captureVisibility(new Set([1, 4, 5]), new Set(), resolve);
    assert.match(describeVisibilityNotice(out.notice!)!, /2 of 3 isolated elements have no IFC GlobalId/);
  });

  it('an isolate with a member from a model still loading its metadata is refused, not recorded wrongly', () => {
    // Entity 4 is real IFC whose GlobalId will resolve once the model
    // hydrates; an allowlist written now would tell the recipient it was hidden.
    const out = captureVisibility(new Set([1, 4]), new Set(), resolve, (id) => id === 4);
    assert.equal(out.visibleGuids, undefined, 'the component is omitted for now');
    assert.deepStrictEqual(out.notice, { unnameable: 1, total: 2, kind: 'isolated', omitted: true, pending: true, ids: [4] });
    assert.match(describeVisibilityNotice(out.notice!)!, /still loading — try again/);
  });

  it('an isolate with NO nameable member is omitted, not written as "nothing visible" (#4509)', () => {
    const out = captureVisibility(new Set([4, 5]), new Set(), resolve);
    assert.equal(out.visibleGuids, undefined);
    assert.deepStrictEqual(out.notice, { unnameable: 2, total: 2, kind: 'isolated', omitted: true, pending: false, ids: [4, 5] });
    assert.equal(
      describeVisibilityNotice(out.notice!),
      'Viewpoint saved without its visibility: the isolated elements have no IFC GlobalId to record.',
      'the pre-#4529 wording, unchanged',
    );
  });

  it('a genuinely empty isolate (active, matches nothing) records an empty allowlist', () => {
    const out = captureVisibility(new Set(), new Set([3]), resolve);
    assert.deepStrictEqual(out.visibleGuids, []);
    assert.equal(out.hiddenGuids, undefined, 'the hide-list is not consulted while an isolation channel is active');
    assert.equal(out.notice, null);
  });

  it('a hide-list with un-nameable members records the nameable ones and only logs the rest', () => {
    // Under-hiding is the safe direction for a recipient: the entities it
    // cannot name it does not have. No author interruption for that.
    const out = captureVisibility(null, new Set([2, 4]), resolve);
    assert.deepStrictEqual(out.hiddenGuids, ['GUID-2']);
    assert.deepStrictEqual(out.notice, { unnameable: 1, total: 2, kind: 'hidden', omitted: false, pending: false, ids: [4] });
    assert.equal(describeVisibilityNotice(out.notice!), null, 'console only, no toast');
  });

  it('a hide-list with no nameable member records no Visibility at all', () => {
    const out = captureVisibility(null, new Set([4]), resolve);
    assert.equal(out.hiddenGuids, undefined);
    assert.deepStrictEqual(out.notice, { unnameable: 1, total: 1, kind: 'hidden', omitted: true, pending: false, ids: [4] });
    assert.equal(describeVisibilityNotice(out.notice!), null);
  });
});
