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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  classifyFile,
  CALL_PATTERN,
  SET_ISOLATED_CALL_PATTERN,
  ROUTING_MARKERS,
  ALIAS_DESTRUCTURE_PATTERN,
  PROPERTY_ALIAS_PATTERN,
  REQUIRES_ROUTING_MARKER,
  NO_MARKER_REQUIRED,
  MIN_ALLOWLIST_REASON_LENGTH,
  isSufficientAllowlistReason,
  stripCommentsAndStrings,
  walk,
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

  // Renamed from "ROUTING_MARKERS requires the marker to be CALLED, not
  // merely mentioned in prose": that name overclaimed. The regex only
  // requires the token to be immediately followed by `(` -- it says nothing
  // about comments or strings, so a call-SHAPED fragment inside either one
  // satisfies it exactly as well as a real call. Demonstrated: `ROUTING_MARKERS
  // .test('// cameraCallbacks.resolveHighlightIds(ids)')` and
  // `ROUTING_MARKERS.test('const s = "resolveHighlightIds(ids)";')` both
  // return `true` against the bare regex. This test now scopes its claim to
  // exactly what the regex alone proves (paren-less prose is rejected); the
  // comment/string cases are covered below, against `classifyFile` (which
  // strips comments and strings before testing), not the bare regex.
  it('ROUTING_MARKERS (the bare regex) requires "(" immediately after the marker name, but does not know about comments or strings', () => {
    assert.equal(
      ROUTING_MARKERS.test('// backed by expandToGeometryBearingIds -- see #2531'),
      false,
      'a comment naming the helper without anything that looks like a call must not match',
    );
    assert.equal(ROUTING_MARKERS.test('cameraCallbacks.resolveHighlightIds?.(ids)'), true);
    // The gap this file exists to close: the bare regex does not distinguish
    // a real call from a call-shaped comment or string. `classifyFile` is
    // what closes this (see the "classifyFile scans code, not comments or
    // string literals" suite below) -- the bare regex alone still matches.
    assert.equal(
      ROUTING_MARKERS.test('// cameraCallbacks.resolveHighlightIds(ids)'),
      true,
      'the bare regex, by itself, cannot tell a commented-out call from a real one',
    );
    assert.equal(
      ROUTING_MARKERS.test('const s = "resolveHighlightIds(ids)";'),
      true,
      'the bare regex, by itself, cannot tell a quoted string from a real call',
    );
  });
});

describe('check-isolate-expansion-routing: stripCommentsAndStrings', () => {
  it('removes a line comment', () => {
    const out = stripCommentsAndStrings('const x = 1; // resolveHighlightIds(ids)\nconst y = 2;');
    assert.equal(/resolveHighlightIds/.test(out), false);
    assert.match(out, /const y = 2;/);
  });

  it('removes a block comment, including one spanning multiple lines', () => {
    const out = stripCommentsAndStrings(
      'const x = 1;\n/* backed by\n   resolveHighlightIds(ids)\n   see #2531 */\nconst y = 2;',
    );
    assert.equal(/resolveHighlightIds/.test(out), false);
    assert.match(out, /const y = 2;/);
  });

  it('removes single, double, and backtick string-literal bodies', () => {
    for (const src of [
      "const s = 'resolveHighlightIds(ids)';",
      'const s = "resolveHighlightIds(ids)";',
      'const s = `resolveHighlightIds(ids)`;',
    ]) {
      const out = stripCommentsAndStrings(src);
      assert.equal(/resolveHighlightIds/.test(out), false, src);
    }
  });

  it('leaves a real call, plain or optional-chained, intact', () => {
    assert.match(stripCommentsAndStrings('resolveHighlightIds(ids)'), /resolveHighlightIds\(ids\)/);
    assert.match(
      stripCommentsAndStrings('cameraCallbacks.resolveHighlightIds?.(ids)'),
      /cameraCallbacks\.resolveHighlightIds\?\.\(ids\)/,
    );
  });
});

describe('check-isolate-expansion-routing: classifyFile scans code, not comments or string literals', () => {
  it('RED (demonstrated against the unmodified script): a call-shaped LINE COMMENT satisfies ROUTING_MARKERS on raw content', () => {
    // This is the exact false GREEN found by hand: a routing call commented
    // out during a refactor still reads as "routed". Documented here as a
    // fact about the raw regex (matches classifyFile's pre-fix behaviour,
    // which tested ROUTING_MARKERS against raw `content`); the suites below
    // prove classifyFile itself no longer has this gap.
    assert.equal(ROUTING_MARKERS.test('// cameraCallbacks.resolveHighlightIds(ids)'), true);
  });

  it('a call-shaped line comment does NOT satisfy classifyFile for a REQUIRES_ROUTING_MARKER file', () => {
    const relPath = [...REQUIRES_ROUTING_MARKER][0];
    const content = `
      const isolationIds = matchingIds; // cameraCallbacks.resolveHighlightIds(matchingIds)
      isolateEntities(isolationIds);
    `;
    const verdict = classifyFile(relPath, content);
    assert.equal(verdict.ok, false, 'a commented-out routing call must not satisfy the gate');
    assert.match(verdict.reason, /lost its assembly-expansion routing/);
  });

  it('a call-shaped BLOCK COMMENT spanning multiple lines does NOT satisfy classifyFile', () => {
    const relPath = [...REQUIRES_ROUTING_MARKER][0];
    const content = `
      /*
       * TODO: restore routing here, it used to say:
       * cameraCallbacks.resolveHighlightIds(matchingIds)
       */
      const isolationIds = matchingIds;
      isolateEntities(isolationIds);
    `;
    const verdict = classifyFile(relPath, content);
    assert.equal(verdict.ok, false, 'a call-shaped fragment inside a block comment must not satisfy the gate');
    assert.match(verdict.reason, /lost its assembly-expansion routing/);
  });

  it('the same call-shaped text inside a STRING LITERAL does NOT satisfy classifyFile', () => {
    const relPath = [...REQUIRES_ROUTING_MARKER][0];
    const content = `
      const isolationIds = matchingIds;
      const debugLabel = "resolveHighlightIds(ids)"; // just a label, not a call
      isolateEntities(isolationIds);
    `;
    const verdict = classifyFile(relPath, content);
    assert.equal(verdict.ok, false, 'a call-shaped string literal must not satisfy the gate');
    assert.match(verdict.reason, /lost its assembly-expansion routing/);
  });

  it('a REAL call still satisfies classifyFile -- plain form', () => {
    const relPath = [...REQUIRES_ROUTING_MARKER][0];
    const content = `
      const resolved = resolveHighlightIds(matchingIds);
      isolateEntities(resolved);
    `;
    assert.equal(classifyFile(relPath, content).ok, true);
  });

  it('a REAL call still satisfies classifyFile -- optional-chaining form', () => {
    const relPath = [...REQUIRES_ROUTING_MARKER][0];
    const content = `
      const resolved = cameraCallbacks.resolveHighlightIds?.(matchingIds) ?? matchingIds;
      isolateEntities(resolved);
    `;
    assert.equal(classifyFile(relPath, content).ok, true);
  });
});

describe('check-isolate-expansion-routing: end-to-end -- a commented-out routing call fails the whole gate (exit code)', () => {
  it('RED/GREEN: the gate exits non-zero on a fixture tree where the real resolver call is commented out, and 0 when it is a real call', () => {
    const root = mkdtempSync(join(tmpdir(), 'isolate-gate-e2e-'));
    try {
      const viewerSrc = join(root, 'apps/viewer/src/components/viewer');
      const embedSrc = join(root, 'apps/viewer-embed/src');
      mkdirSync(viewerSrc, { recursive: true });
      mkdirSync(embedSrc, { recursive: true });

      // Filler so CANDIDATE_FLOOR doesn't fire for unrelated reasons -- one
      // real fixture file per REQUIRES_ROUTING_MARKER path is enough to prove
      // the exit-code contract without depending on the real repo tree.
      let fillerIndex = 0;
      const writeRouted = (relPath) => {
        const abs = join(root, relPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(
          abs,
          `export function h${fillerIndex++}(state, ids) {\n` +
            '  const resolved = cameraCallbacks.resolveHighlightIds?.(ids) ?? ids;\n' +
            '  state.isolateEntities(resolved);\n' +
            '}\n',
        );
      };
      for (const relPath of REQUIRES_ROUTING_MARKER) writeRouted(relPath);

      // Also materialize the NO_MARKER_REQUIRED (exempt) channels as bare
      // raw-id calls -- CANDIDATE_FLOOR counts every classified candidate,
      // routed or exempt, so without these the fixture tree undercounts
      // relative to the real repo and the floor check itself fires first,
      // masking the routing assertion this test exists to make.
      const writeExempt = (relPath) => {
        const abs = join(root, relPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, `export function e${fillerIndex++}(state, ids) {\n  state.isolateEntities(ids);\n}\n`);
      };
      for (const relPath of NO_MARKER_REQUIRED.keys()) writeExempt(relPath);

      const scriptPath = join(process.cwd(), 'scripts', 'check-isolate-expansion-routing.mjs');
      const runGate = () =>
        execFileSync(process.execPath, [scriptPath, '--root', root], { encoding: 'utf8', stdio: 'pipe' });

      // GREEN: every routed fixture calls the resolver for real -- clean exit.
      assert.doesNotThrow(runGate, 'a fully routed fixture tree must exit 0');

      // RED: comment out the real call on ONE known channel, leaving the
      // call-shaped text sitting in a comment (the demonstrated defect).
      const target = [...REQUIRES_ROUTING_MARKER][0];
      const targetAbs = join(root, target);
      writeFileSync(
        targetAbs,
        'export function h(state, ids) {\n' +
          '  // cameraCallbacks.resolveHighlightIds?.(ids) -- disabled during refactor, TODO restore\n' +
          '  state.isolateEntities(ids);\n' +
          '}\n',
      );

      let threw = false;
      let output = '';
      try {
        runGate();
      } catch (err) {
        threw = true;
        output = `${err.stdout || ''}${err.stderr || ''}`;
      }
      assert.equal(threw, true, 'a real routing call commented out must make the gate exit non-zero');
      assert.match(output, /lost its assembly-expansion routing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ROUTING_MARKERS recognises resolveIsolationIds( (#3338: the shared expansion wrapper)', () => {
    assert.equal(
      ROUTING_MARKERS.test('const isolateIds = resolveIsolationIds(state.cameraCallbacks.resolveHighlightIds, ids);'),
      true,
      'a channel that switched to the shared wrapper no longer contains a literal resolveHighlightIds( call',
    );
    assert.equal(
      ROUTING_MARKERS.test('setIsolatedEntities(new Set(resolveIsolationIds(resolver, rawIds)));'),
      true,
      'the assigning channels (useBCF, usePreviewIsolation) route through the same wrapper',
    );
    assert.equal(
      ROUTING_MARKERS.test('// resolveIsolationIds handles this -- see #3338'),
      false,
      'naming the wrapper in prose without calling it must not satisfy the gate',
    );
  });

  it('GREEN: a REQUIRES_ROUTING_MARKER file routed via resolveIsolationIds passes', () => {
    const relPath = [...REQUIRES_ROUTING_MARKER][0];
    const compliant = `
      const isolationIds = resolveIsolationIds(cameraCallbacks.resolveHighlightIds, matchingIds);
      isolateEntities(isolationIds);
    `;
    const verdict = classifyFile(relPath, compliant);
    assert.equal(verdict.isCandidate, true);
    assert.equal(verdict.ok, true);
  });
});

describe('check-isolate-expansion-routing: Finding 1 -- destructure-and-rename bypass', () => {
  it('RED: a destructured, aliased isolateEntities binding is invisible to CALL_PATTERN alone', () => {
    // The exact adversarial-review shape: a Zustand destructure that renames
    // the action, then calls the alias with raw ids -- never the literal
    // token `isolateEntities(`.
    const content = `
      const { isolateEntities: applyIsolation } = useViewerStore();
      const handleClick = () => applyIsolation(ids); // raw ids, never routed
    `;
    assert.equal(CALL_PATTERN.test(content), false, 'CALL_PATTERN alone must not see the alias call');
    assert.equal(ALIAS_DESTRUCTURE_PATTERN.test(content), true, 'the destructure itself must be caught');
  });

  it('RED: an unlisted file using the destructure-and-rename bypass is flagged, not silently skipped', () => {
    const relPath = 'apps/viewer/src/components/viewer/BrandNewIsolatePanelAlias.tsx';
    assert.equal(REQUIRES_ROUTING_MARKER.has(relPath), false, 'fixture must not already be allowlisted');
    assert.equal(NO_MARKER_REQUIRED.has(relPath), false, 'fixture must not already be allowlisted');
    const content = `
      const { isolateEntities: applyIsolation } = useViewerStore();
      const handleClick = () => applyIsolation(ids); // raw ids, never routed
    `;
    const verdict = classifyFile(relPath, content);
    assert.equal(verdict.isCandidate, true, 'must count toward candidateCount, not vanish like before the fix');
    assert.equal(verdict.ok, false, 'an unrouted aliased binding must fail');
    assert.match(verdict.reason, /not in either allowlist/);
  });

  it('RED: the alias bypass on a REQUIRES_ROUTING_MARKER file with no routing marker still fails', () => {
    const relPath = [...REQUIRES_ROUTING_MARKER][0];
    const regressed = `
      const { isolateEntities: applyIsolation } = useViewerStore();
      applyIsolation(matchingIds); // resolver dropped, alias used instead
    `;
    const verdict = classifyFile(relPath, regressed);
    assert.equal(verdict.isCandidate, true);
    assert.equal(verdict.ok, false, 'a known channel that lost routing must fail even via an alias');
  });

  it('GREEN: a destructured isolateEntities binding that IS routed still passes', () => {
    const relPath = [...REQUIRES_ROUTING_MARKER][0];
    const compliant = `
      const { isolateEntities } = useViewerStore();
      const resolved = cameraCallbacks.resolveHighlightIds?.(matchingIds) ?? [];
      isolateEntities(resolved);
    `;
    const verdict = classifyFile(relPath, compliant);
    assert.equal(verdict.ok, true);
  });

  it('GREEN: plain (non-destructuring) real-world bindings are unaffected by the alias pattern', () => {
    // `const isolateEntities = useViewerStore((s) => s.isolateEntities);` is
    // the shape every real allowlisted channel actually uses today -- not a
    // destructure at all, so ALIAS_DESTRUCTURE_PATTERN must not fire on it
    // (CALL_PATTERN already covers it via the later `isolateEntities(...)` call).
    const content = 'const isolateEntities = useViewerStore((s) => s.isolateEntities);';
    assert.equal(ALIAS_DESTRUCTURE_PATTERN.test(content), false);
  });
});

describe('check-isolate-expansion-routing: widened alias detection -- param destructure, reassignment, and plain member-access rebinding', () => {
  it('RED: function-parameter destructure-and-rename is caught (was invisible to the const-only anchor)', () => {
    const content = `
      function onIsolate({ isolateEntities: apply }) {
        apply(rawIds); // never routed, and never calls the action by its own name
      }
    `;
    assert.equal(CALL_PATTERN.test(content), false);
    assert.equal(ALIAS_DESTRUCTURE_PATTERN.test(content), true, 'a param destructure must be caught, not just `const { ... } =`');
  });

  it('RED: a destructuring REASSIGNMENT with no declaration keyword is caught', () => {
    const content = `
      let apply;
      ({ isolateEntities: apply } = useViewerStore.getState());
      apply(rawIds);
    `;
    assert.equal(ALIAS_DESTRUCTURE_PATTERN.test(content), true, 'a keyword-less destructuring assignment must be caught');
  });

  it('RED: a plain member-access rebinding (no braces at all) is caught by PROPERTY_ALIAS_PATTERN', () => {
    // The gap ALIAS_DESTRUCTURE_PATTERN cannot close: no `{ }` syntax
    // appears anywhere, so the destructure regex cannot match, yet the
    // action is still rebound to a local name and never called by its
    // literal name.
    const content = `
      const apply = useViewerStore.getState().isolateEntities;
      apply(rawIds);
    `;
    assert.equal(CALL_PATTERN.test(content), false);
    assert.equal(ALIAS_DESTRUCTURE_PATTERN.test(content), false, 'no braces here -- this is exactly the gap PROPERTY_ALIAS_PATTERN closes');
    assert.equal(PROPERTY_ALIAS_PATTERN.test(content), true);
  });

  it('RED: an unlisted file using the plain member-access rebinding is flagged, not silently skipped', () => {
    const relPath = 'apps/viewer/src/components/viewer/BrandNewIsolatePanelPropertyAlias.tsx';
    assert.equal(REQUIRES_ROUTING_MARKER.has(relPath), false, 'fixture must not already be allowlisted');
    assert.equal(NO_MARKER_REQUIRED.has(relPath), false, 'fixture must not already be allowlisted');
    const content = `
      const apply = useViewerStore.getState().setIsolatedEntities;
      const handleClick = () => apply(new Set(rawIds)); // raw ids, never routed
    `;
    const verdict = classifyFile(relPath, content);
    assert.equal(verdict.isCandidate, true, 'must count toward candidateCount, not vanish');
    assert.equal(verdict.ok, false, 'an unrouted property-alias binding must fail');
    assert.match(verdict.reason, /not in either allowlist/);
  });

  it('GREEN: real allowlisted channels are unaffected -- the widened patterns still do not fire on their real source', () => {
    // The shape every real allowlisted channel actually uses:
    // `useViewerStore((s) => s.isolateEntities)` inside a selector callback.
    // Neither widened pattern should treat this as a rebind: there is no
    // `{ }` destructure, and the member access is not the RHS of a bare
    // assignment to a local variable (it is passed straight into a call).
    const content = 'const isolateEntities = useViewerStore((s) => s.isolateEntities);';
    assert.equal(ALIAS_DESTRUCTURE_PATTERN.test(content), false);
    assert.equal(PROPERTY_ALIAS_PATTERN.test(content), false);
  });
});

describe('check-isolate-expansion-routing: Finding 2 -- allowlist reasons are enforced, not just tested', () => {
  it('isSufficientAllowlistReason rejects a stub reason and accepts a real one', () => {
    assert.equal(isSufficientAllowlistReason('x'), false);
    assert.equal(isSufficientAllowlistReason(''), false);
    assert.equal(isSufficientAllowlistReason(undefined), false);
    assert.equal(
      isSufficientAllowlistReason('a'.repeat(MIN_ALLOWLIST_REASON_LENGTH)),
      false,
      'exactly at the floor is still insufficient -- the check is strictly greater-than',
    );
    assert.equal(isSufficientAllowlistReason('a'.repeat(MIN_ALLOWLIST_REASON_LENGTH + 1)), true);
  });

  it('RED: a NO_MARKER_REQUIRED entry with a junk reason fails the gate on its own, unconditionally', () => {
    const relPath = 'apps/viewer/src/components/viewer/NewPanel.tsx';
    assert.equal(NO_MARKER_REQUIRED.has(relPath), false, 'fixture path must not already be allowlisted');
    // Simulate exactly the bypass the review demonstrated:
    // ['apps/viewer/src/components/viewer/NewPanel.tsx', 'x'] added to the map.
    NO_MARKER_REQUIRED.set(relPath, 'x');
    try {
      const content = 'isolateEntities(rawIds); // no resolver, allowlisted with a junk reason';
      const verdict = classifyFile(relPath, content);
      assert.equal(verdict.isCandidate, true);
      assert.equal(verdict.ok, false, 'a junk reason must fail the gate even though the path is allowlisted');
      assert.match(verdict.reason, /no reviewable reason/);
    } finally {
      NO_MARKER_REQUIRED.delete(relPath);
    }
  });

  it('GREEN: the real NO_MARKER_REQUIRED entries all satisfy isSufficientAllowlistReason', () => {
    for (const [relPath, reason] of NO_MARKER_REQUIRED) {
      assert.equal(isSufficientAllowlistReason(reason), true, relPath);
    }
  });
});

describe('check-isolate-expansion-routing: Finding 4 -- walk() records unreadable subtrees instead of swallowing them', () => {
  it('RED (pre-fix behaviour would be silent): an unreadable subtree is reported, and its readable sibling is still scanned', () => {
    if (process.getuid && process.getuid() === 0) {
      // root ignores directory permission bits, so this fixture cannot
      // reproduce an EACCES under a root-run test process (e.g. some CI
      // containers). Skip rather than false-fail.
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'isolate-gate-walk-'));
    try {
      const blocked = join(root, 'blocked');
      const readable = join(root, 'readable');
      mkdirSync(blocked);
      mkdirSync(readable);
      writeFileSync(join(readable, 'Ok.tsx'), 'export const x = 1;');
      chmodSync(blocked, 0o000);
      const out = [];
      const errors = [];
      walk(root, out, errors);
      assert.equal(errors.length, 1, 'the unreadable subtree must be recorded, not swallowed');
      assert.match(errors[0], /could not read directory/);
      assert.match(errors[0], /blocked/);
      assert.equal(out.length, 1, 'the readable sibling must still be scanned');
      assert.match(out[0], /Ok\.tsx$/);
    } finally {
      chmodSync(join(root, 'blocked'), 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('GREEN: a fully readable tree produces no walk errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'isolate-gate-walk-clean-'));
    try {
      mkdirSync(join(root, 'nested'));
      writeFileSync(join(root, 'nested', 'Ok.tsx'), 'export const x = 1;');
      const out = [];
      const errors = [];
      walk(root, out, errors);
      assert.equal(errors.length, 0);
      assert.equal(out.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('check-isolate-expansion-routing: seventh channel -- setIsolatedEntities is a sibling raw-isolation action', () => {
  it('RED: SET_ISOLATED_CALL_PATTERN matches the exact shape useEmbedUrlParams.ts had before its fix', () => {
    const content = 'state.setIsolatedEntities(new Set(urlParams.isolate));';
    assert.equal(CALL_PATTERN.test(content), false, 'CALL_PATTERN alone must not see setIsolatedEntities');
    assert.equal(SET_ISOLATED_CALL_PATTERN.test(content), true);
  });

  it('RED: an unlisted file calling ONLY setIsolatedEntities( is a new/unknown channel', () => {
    const relPath = 'apps/viewer-embed/src/components/BrandNewIsolateUrlHandler.ts';
    assert.equal(REQUIRES_ROUTING_MARKER.has(relPath), false, 'fixture must not already be allowlisted');
    assert.equal(NO_MARKER_REQUIRED.has(relPath), false, 'fixture must not already be allowlisted');
    const content = `
      export function applyIsolateParam(state, ids) {
        state.setIsolatedEntities(new Set(ids)); // raw ids, no resolver
      }
    `;
    assert.equal(CALL_PATTERN.test(content), false, 'must be invisible to the isolateEntities-only pattern');
    const verdict = classifyFile(relPath, content);
    assert.equal(verdict.isCandidate, true, 'must count toward candidateCount via SET_ISOLATED_CALL_PATTERN');
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /not in either allowlist/);
  });

  it('RED: a REQUIRES_ROUTING_MARKER file that calls setIsolatedEntities( with no resolver still fails', () => {
    // useEmbedUrlParams.ts and useBCF.ts route through setIsolatedEntities,
    // not isolateEntities -- the "lost routing" check has to fire for them too.
    const relPath = 'apps/viewer-embed/src/components/useEmbedUrlParams.ts';
    assert.equal(REQUIRES_ROUTING_MARKER.has(relPath), true, 'this fix depends on the seventh channel staying routed');
    const regressed = 'state.setIsolatedEntities(new Set(urlParams.isolate)); // resolver dropped';
    assert.equal(ROUTING_MARKERS.test(regressed), false);
    const verdict = classifyFile(relPath, regressed);
    assert.equal(verdict.ok, false, 'a regressed known channel must fail even via setIsolatedEntities');
    assert.match(verdict.reason, /lost its assembly-expansion routing/);
  });

  it('GREEN: useEmbedUrlParams.ts routed through resolveHighlightIds before assigning passes', () => {
    const relPath = 'apps/viewer-embed/src/components/useEmbedUrlParams.ts';
    const compliant = `
      const resolved = state.cameraCallbacks.resolveHighlightIds?.(urlParams.isolate) ?? urlParams.isolate;
      state.setIsolatedEntities(new Set(resolved));
    `;
    const verdict = classifyFile(relPath, compliant);
    assert.equal(verdict.ok, true);
  });

  it('GREEN: useBCF.ts and useIDS.ts are allowlisted as REQUIRES_ROUTING_MARKER', () => {
    for (const relPath of [
      'apps/viewer/src/hooks/useBCF.ts',
      'apps/viewer/src/hooks/useIDS.ts',
    ]) {
      assert.equal(REQUIRES_ROUTING_MARKER.has(relPath), true, relPath);
    }
  });

  it('GREEN: useClash.ts, tours/ids.ts and usePreviewIsolation.ts are allowlisted as NO_MARKER_REQUIRED with a real reason', () => {
    for (const relPath of [
      'apps/viewer/src/hooks/useClash.ts',
      'apps/viewer/src/lib/tours/tours/ids.ts',
      'apps/viewer/src/components/viewer/anonymized-export/usePreviewIsolation.ts',
    ]) {
      assert.equal(NO_MARKER_REQUIRED.has(relPath), true, relPath);
      assert.equal(isSufficientAllowlistReason(NO_MARKER_REQUIRED.get(relPath)), true, relPath);
    }
  });

  it('GREEN: setIsolatedEntities(null) alone (a pure clear, no ids) is still flagged as a candidate needing triage', () => {
    // classifyFile does not special-case null -- a file calling
    // setIsolatedEntities(null) IS a candidate, and has to be allowlisted
    // (tours/ids.ts) rather than silently passing just because the argument
    // happens to be a literal null in this one text sample.
    const relPath = 'apps/viewer/src/lib/tours/tours/ids.ts';
    const content = "s.setIsolatedEntities(null);";
    const verdict = classifyFile(relPath, content);
    assert.equal(verdict.isCandidate, true);
    assert.equal(verdict.ok, true, 'allowlisted with a reason, not exempt by pattern-matching the argument');
  });
});
