/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for `check-isolate-expansion-routing.mjs`'s pure `classifyFile`,
 * exercised against synthetic fixture strings (never the repo's own source
 * text -- `scripts/*.test.mjs` is explicitly out of
 * `check-source-text-assertions.mjs`'s scope for exactly this reason: this
 * file tests the GATE's classification logic on fabricated inputs, not an
 * application's behaviour through its own source).
 *
 * Both directions, per #3338's mechanism requirement:
 *   1. RED — a planted violation (an unlisted file calling isolateEntities(,
 *      and a listed-but-regressed file that lost its resolver call) is
 *      reported as a failure.
 *   2. GREEN — a compliant call site (routed, or allowlist-exempt with a
 *      reason) is not.
 *
 * A live, on-disk RED/GREEN proof (planting `PlantedIsolateViolation.tsx`,
 * and stripping `LensPanel.tsx`'s `resolveHighlightIds` call, restored by
 * SHA) was additionally run by hand against the real repo before this PR —
 * see the PR description for the transcript. This file is what keeps that
 * proof from rotting: it runs on every CI run, not once by hand.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFile,
  CALL_PATTERN,
  ROUTING_MARKERS,
  REQUIRES_ROUTING_MARKER,
  NO_MARKER_REQUIRED,
} from './check-isolate-expansion-routing.mjs';

describe('check-isolate-expansion-routing: classifyFile', () => {
  it('a file with no isolateEntities( call is not a candidate at all', () => {
    const verdict = classifyFile('apps/viewer/src/components/viewer/Unrelated.tsx', 'export const x = 1;');
    assert.equal(verdict.isCandidate, false);
    assert.equal(verdict.ok, true);
  });

  it('RED: an unlisted file calling isolateEntities( is a new/unknown channel', () => {
    const relPath = 'apps/viewer/src/components/viewer/BrandNewIsolatePanel.tsx';
    assert.equal(REQUIRES_ROUTING_MARKER.has(relPath), false, 'fixture must not already be allowlisted');
    assert.equal(NO_MARKER_REQUIRED.has(relPath), false, 'fixture must not already be allowlisted');
    const content = `
      export function handleIsolate(state, ids) {
        state.isolateEntities(ids); // raw ids, no resolver -- the #2531/#2532 shape
      }
    `;
    const verdict = classifyFile(relPath, content);
    assert.equal(verdict.isCandidate, true);
    assert.equal(verdict.ok, false, 'an unlisted channel must fail');
    assert.match(verdict.reason, /not in either allowlist/);
  });

  it('RED: a REQUIRES_ROUTING_MARKER file that lost its resolver call fails', () => {
    // Take the first routed file from the gate's own allowlist and simulate
    // the LensPanel.tsx regression tested by hand: the resolver call
    // replaced by a bare pass-through, `isolateEntities(` left intact.
    const relPath = [...REQUIRES_ROUTING_MARKER][0];
    const regressed = `
      const resolved = matchingIds; // resolver call dropped
      const isolationIds = [...new Set([...resolved, ...matchingIds])];
      isolateEntities(isolationIds);
    `;
    assert.equal(CALL_PATTERN.test(regressed), true, 'fixture must still call isolateEntities(');
    assert.equal(ROUTING_MARKERS.test(regressed), false, 'fixture must not contain a routing marker call');
    const verdict = classifyFile(relPath, regressed);
    assert.equal(verdict.isCandidate, true);
    assert.equal(verdict.ok, false, 'a regressed known channel must fail');
    assert.match(verdict.reason, /lost its assembly-expansion routing/);
  });

  it('GREEN: a REQUIRES_ROUTING_MARKER file that calls resolveHighlightIds passes', () => {
    const relPath = [...REQUIRES_ROUTING_MARKER][0];
    const compliant = `
      const resolved = cameraCallbacks.resolveHighlightIds?.(matchingIds) ?? [];
      const isolationIds = [...new Set([...resolved, ...matchingIds])];
      isolateEntities(isolationIds);
    `;
    const verdict = classifyFile(relPath, compliant);
    assert.equal(verdict.isCandidate, true);
    assert.equal(verdict.ok, true);
  });

  it('GREEN: a REQUIRES_ROUTING_MARKER file may route via expandToGeometryBearingIds directly', () => {
    const relPath = [...REQUIRES_ROUTING_MARKER][0];
    const compliant = `
      const isolationIds = expandToGeometryBearingIds(ids, hasGeometry, access);
      isolateEntities(isolationIds);
    `;
    const verdict = classifyFile(relPath, compliant);
    assert.equal(verdict.ok, true);
  });

  it('GREEN: the embed bridge routes via the optional-call form (state.isolateEntities(resolved))', () => {
    const relPath = 'apps/viewer-embed/src/bridge/handler.ts';
    assert.equal(REQUIRES_ROUTING_MARKER.has(relPath), true, 'this fix depends on the embed bridge staying routed');
    const compliant = `
      const resolved = state.cameraCallbacks.resolveHighlightIds?.(payload.ids) ?? payload.ids;
      state.isolateEntities(resolved);
    `;
    const verdict = classifyFile(relPath, compliant);
    assert.equal(verdict.ok, true);
  });

  it('GREEN: a NO_MARKER_REQUIRED file (HierarchyPanel) passes without any routing marker', () => {
    const relPath = [...NO_MARKER_REQUIRED.keys()][0];
    const content = `
      const elements = getNodeElements(node);
      isolateEntities(elements); // pre-expanded by treeDataBuilder.ts, not a raw ref
    `;
    const verdict = classifyFile(relPath, content);
    assert.equal(verdict.isCandidate, true);
    assert.equal(verdict.ok, true);
    assert.equal(typeof verdict.reason, 'string', 'exempt entries still carry a reviewable reason');
  });

  it('every NO_MARKER_REQUIRED entry carries a non-empty reason string', () => {
    for (const [relPath, reason] of NO_MARKER_REQUIRED) {
      assert.equal(typeof reason, 'string', relPath);
      assert.ok(reason.length > 20, `${relPath}: reason reads as a real justification, not a stub`);
    }
  });

  it('CALL_PATTERN matches every call shape used by the real allowlisted channels', () => {
    assert.equal(CALL_PATTERN.test('isolateEntities(ids)'), true);
    assert.equal(CALL_PATTERN.test('state.isolateEntities(ids)'), true);
    assert.equal(CALL_PATTERN.test('state.isolateEntities?.(ids)'), true);
    assert.equal(CALL_PATTERN.test('isolateEntity(id)'), false, 'must not match the singular sibling action');
  });

  it('ROUTING_MARKERS requires the marker to be CALLED, not merely mentioned in prose', () => {
    assert.equal(
      ROUTING_MARKERS.test('// backed by expandToGeometryBearingIds -- see #2531'),
      false,
      'a comment naming the helper without calling it must not satisfy the gate',
    );
    assert.equal(ROUTING_MARKERS.test('cameraCallbacks.resolveHighlightIds?.(ids)'), true);
  });
});
