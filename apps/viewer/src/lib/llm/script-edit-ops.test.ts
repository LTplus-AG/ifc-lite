/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyScriptEditOperations, extractScriptEditOps, filterUnappliedScriptOps } from './script-edit-ops.js';

test('extractScriptEditOps parses ops from ifc-script-edits block', () => {
  const text = `
Hello
\`\`\`ifc-script-edits
{"scriptEdits":[
  {"opId":"op-1","type":"replaceSelection","baseRevision":3,"text":"const x = 1;"},
  {"opId":"op-2","type":"append","baseRevision":3,"text":"\\nconsole.log(x)"}
]}
\`\`\`
`;
  const result = extractScriptEditOps(text);
  assert.equal(result.parseErrors.length, 0);
  assert.equal(result.operations.length, 2);
  assert.equal(result.operations[0].opId, 'op-1');
  assert.equal(result.operations[1].type, 'append');
});

test('extractScriptEditOps parses SEARCH/REPLACE blocks into replaceRange ops', () => {
  const baseContent = 'const width = 30;\nconst depth = 40;\n';
  const result = extractScriptEditOps(`
\`\`\`ifc-script-edits
<<<<<<< SEARCH
const width = 30;
=======
const width = 36;
>>>>>>> REPLACE
\`\`\`
`, {
    baseRevision: 7,
    baseContent,
    intent: 'repair',
    requestedRepairScope: 'local',
    targetRootCause: 'api_contract_mismatch',
  });

  assert.equal(result.parseErrors.length, 0);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].type, 'replaceRange');
  assert.equal(result.operations[0].baseRevision, 7);
  assert.equal(result.operations[0].expectedText, 'const width = 30;');
  assert.equal(result.operations[0].text, 'const width = 36;');
});

test('extractScriptEditOps reports no-match SEARCH blocks with targeted diagnostics', () => {
  const result = extractScriptEditOps(`
\`\`\`ifc-script-edits
<<<<<<< SEARCH
const missing = true;
=======
const present = true;
>>>>>>> REPLACE
\`\`\`
`, {
    baseRevision: 4,
    baseContent: 'const width = 30;\n',
    intent: 'repair',
  });

  assert.equal(result.operations.length, 0);
  assert.match(result.parseErrors[0] ?? '', /does not match the current script/);
  assert.equal(result.parseDiagnostics[0]?.data?.failureKind, 'no_unique_match');
});

test('extractScriptEditOps reports ambiguous SEARCH blocks with targeted diagnostics', () => {
  const result = extractScriptEditOps(`
\`\`\`ifc-script-edits
<<<<<<< SEARCH
const value = 1;
=======
const value = 2;
>>>>>>> REPLACE
\`\`\`
`, {
    baseRevision: 4,
    baseContent: 'const value = 1;\nconst value = 1;\n',
    intent: 'repair',
  });

  assert.equal(result.operations.length, 0);
  assert.match(result.parseErrors[0] ?? '', /matches multiple locations/);
  assert.equal(result.parseDiagnostics[0]?.data?.failureKind, 'multiple_matches');
});

test('filterUnappliedScriptOps drops already applied op ids', () => {
  const result = extractScriptEditOps(`
\`\`\`ifc-script-edits
{"scriptEdits":[
  {"opId":"op-1","type":"append","baseRevision":1,"text":"a"},
  {"opId":"op-2","type":"append","baseRevision":1,"text":"b"}
]}
\`\`\`
`);
  const filtered = filterUnappliedScriptOps(result.operations, new Set(['op-1']));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].opId, 'op-2');
});

test('applyScriptEditOperations applies replaceSelection and append in one revision', () => {
  const applied = applyScriptEditOperations({
    content: 'const a = 1;',
    selection: { from: 6, to: 7 },
    revision: 5,
    operations: [
      { opId: 'op-1', type: 'replaceSelection', baseRevision: 5, text: 'b' },
      { opId: 'op-2', type: 'append', baseRevision: 5, text: '\nconsole.log(b)' },
    ],
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.status, 'ok');
  assert.equal(applied.revision, 6);
  assert.equal(applied.content, 'const b = 1;\nconsole.log(b)');
  assert.deepEqual(applied.appliedOpIds, ['op-1', 'op-2']);
});

test('applyScriptEditOperations rejects stale revision', () => {
  const applied = applyScriptEditOperations({
    content: 'const a = 1;',
    selection: { from: 0, to: 0 },
    revision: 2,
    operations: [
      { opId: 'op-1', type: 'append', baseRevision: 1, text: '\nconsole.log(a)' },
    ],
  });
  assert.equal(applied.ok, false);
  assert.equal(applied.status, 'revision_conflict');
  assert.match(applied.error ?? '', /expected base revision is 2/);
  assert.equal(applied.diagnostic?.code, 'patch_revision_conflict');
});

test('applyScriptEditOperations accepts fixed base revision across stream batches', () => {
  const baseContent = 'if (f > 0) {\n  facade();\n}';
  const first = applyScriptEditOperations({
    content: baseContent,
    selection: { from: 0, to: 0 },
    revision: 1,
    acceptedBaseRevision: 1,
    baseContentSnapshot: baseContent,
    operations: [
      {
        opId: 'remove-ground-skip',
        type: 'replaceRange',
        baseRevision: 1,
        from: 0,
        to: 11,
        text: '',
      },
    ],
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'ok');
  assert.equal(first.revision, 2);

  const second = applyScriptEditOperations({
    content: first.content,
    selection: first.selection,
    revision: first.revision,
    priorAcceptedOps: [
      { opId: 'prefix', type: 'insert', baseRevision: 1, at: 0, text: '12' },
    ],
    acceptedBaseRevision: 1,
    baseContentSnapshot: baseContent,
    operations: [
      {
        opId: 'normalize-indent',
        type: 'replaceRange',
        baseRevision: 1,
        from: 0,
        to: 0,
        text: '// edited\n',
      },
    ],
  });
  assert.equal(second.ok, true);
  assert.equal(second.status, 'ok');
  assert.equal(second.revision, 3);
});

test('applyScriptEditOperations rebases positional ops against the original base snapshot', () => {
  const baseContent = 'abcdef';
  const first = applyScriptEditOperations({
    content: baseContent,
    selection: { from: 0, to: 0 },
    revision: 1,
    acceptedBaseRevision: 1,
    baseContentSnapshot: baseContent,
    operations: [
      { opId: 'prefix', type: 'insert', baseRevision: 1, at: 0, text: '12' },
    ],
  });
  assert.equal(first.ok, true);
  assert.equal(first.content, '12abcdef');

  const second = applyScriptEditOperations({
    content: first.content,
    selection: first.selection,
    revision: first.revision,
    priorAcceptedOps: [
      { opId: 'prefix', type: 'insert', baseRevision: 1, at: 0, text: '12' },
    ],
    acceptedBaseRevision: 1,
    baseContentSnapshot: baseContent,
    operations: [
      { opId: 'replace-cd', type: 'replaceRange', baseRevision: 1, from: 2, to: 4, text: 'ZZ' },
    ],
  });
  assert.equal(second.ok, true);
  assert.equal(second.content, '12abZZef');
});

test('applyScriptEditOperations rejects overlapping stale range ops before mutating content', () => {
  const baseContent = 'const width = 30;\nconst depth = 40;\n';
  const applied = applyScriptEditOperations({
    content: baseContent,
    selection: { from: 0, to: 0 },
    revision: 3,
    acceptedBaseRevision: 3,
    baseContentSnapshot: baseContent,
    operations: [
      { opId: 'rename-width', type: 'replaceRange', baseRevision: 3, from: 6, to: 11, text: 'span' },
      { opId: 'rename-width-again', type: 'replaceRange', baseRevision: 3, from: 8, to: 13, text: 'measure' },
    ],
  });

  assert.equal(applied.ok, false);
  assert.equal(applied.status, 'revision_conflict');
  assert.equal(applied.content, baseContent);
  assert.equal(applied.diagnostic?.code, 'patch_revision_conflict');
});

test('applyScriptEditOperations blocks replaceAll during repair turns', () => {
  const applied = applyScriptEditOperations({
    content: 'const h = bim.create.project({ Name: "Tower" });\nconst result = bim.create.toIfc(h);\n',
    selection: { from: 0, to: 0 },
    revision: 4,
    intent: 'repair',
    operations: [
      {
        opId: 'rewrite-fragment',
        type: 'replaceAll',
        baseRevision: 4,
        text: 'for (let x = 0; x < width; x += 3) {\n  facade(x);\n}\n',
      },
    ],
  });

  assert.equal(applied.ok, false);
  assert.equal(applied.status, 'semantic_error');
  assert.equal(applied.diagnostic?.code, 'unsafe_full_replacement');
});

test('applyScriptEditOperations rejects replaceSelection during repair turns', () => {
  const applied = applyScriptEditOperations({
    content: 'bim.create.addIfcDoor(h, ground, { Name: "Front Door" });',
    selection: { from: 0, to: 10 },
    revision: 6,
    intent: 'repair',
    operations: [
      {
        opId: 'repair-via-selection',
        type: 'replaceSelection',
        baseRevision: 6,
        text: '',
      },
    ],
  });

  assert.equal(applied.ok, false);
  assert.equal(applied.status, 'semantic_error');
  assert.match(applied.error ?? '', /not allowed for automated repair turns/);
});

test('applyScriptEditOperations rejects repair range ops when expectedText does not match', () => {
  const content = 'bim.create.addIfcDoor(h, ground, { Name: "Front Door" });';
  const applied = applyScriptEditOperations({
    content,
    selection: { from: 0, to: 0 },
    revision: 8,
    intent: 'repair',
    acceptedBaseRevision: 8,
    baseContentSnapshot: content,
    operations: [
      {
        opId: 'remove-door',
        type: 'replaceRange',
        baseRevision: 8,
        from: 0,
        to: content.length,
        expectedText: 'bim.create.addIfcDoor(h, ground, { Name: "Wrong" });',
        text: '// removed',
      },
    ],
  });

  assert.equal(applied.ok, false);
  assert.equal(applied.status, 'revision_conflict');
  assert.match(applied.error ?? '', /no longer matches the expected text/);
});

test('applyScriptEditOperations accepts coordinated structural repair ops with shared metadata', () => {
  const content = [
    'const width = 30;',
    'const depth = 40;',
    'bim.create.addIfcMember(h, storey, {',
    '  Start: [0, 0, 0],',
    '  End: [0, 0, 3],',
    '  Width: 0.2,',
    '  Height: 0.2,',
    '});',
  ].join('\n');
  const startLine = '  Start: [0, 0, 0],';
  const endLine = '  End: [0, 0, 3],';
  const startFrom = content.indexOf(startLine);
  const endFrom = content.indexOf(endLine);

  const applied = applyScriptEditOperations({
    content,
    selection: { from: 0, to: 0 },
    revision: 10,
    intent: 'repair',
    acceptedBaseRevision: 10,
    baseContentSnapshot: content,
    operations: [
      {
        opId: 'fix-start',
        type: 'replaceRange',
        baseRevision: 10,
        groupId: 'placement-fix',
        scope: 'structural',
        targetRootCause: 'placement_context_mismatch',
        from: startFrom,
        to: startFrom + startLine.length,
        expectedText: startLine,
        text: '  Start: [0, 0, elevation],',
      },
      {
        opId: 'fix-end',
        type: 'replaceRange',
        baseRevision: 10,
        groupId: 'placement-fix',
        scope: 'structural',
        targetRootCause: 'placement_context_mismatch',
        from: endFrom,
        to: endFrom + endLine.length,
        expectedText: endLine,
        text: '  End: [0, 0, elevation + 3],',
      },
    ],
  });

  assert.equal(applied.ok, true);
  assert.match(applied.content, /Start: \[0, 0, elevation\]/);
  assert.match(applied.content, /End: \[0, 0, elevation \+ 3\]/);
});

test('applyScriptEditOperations rejects grouped structural repair ops without shared metadata', () => {
  const content = 'const width = 30;\nconst depth = 40;\n';
  const applied = applyScriptEditOperations({
    content,
    selection: { from: 0, to: 0 },
    revision: 11,
    intent: 'repair',
    acceptedBaseRevision: 11,
    baseContentSnapshot: content,
    operations: [
      {
        opId: 'fix-width',
        type: 'replaceRange',
        baseRevision: 11,
        scope: 'structural',
        from: 0,
        to: 5,
        expectedText: 'const',
        text: 'let',
      },
      {
        opId: 'fix-depth',
        type: 'replaceRange',
        baseRevision: 11,
        scope: 'structural',
        from: 17,
        to: 22,
        expectedText: 'const',
        text: 'let',
      },
    ],
  });

  assert.equal(applied.ok, false);
  assert.equal(applied.status, 'semantic_error');
  assert.match(applied.error ?? '', /must declare `targetRootCause`/);
});


/**
 * A `replaceAll` in one streaming fence followed by an `insert` in the next.
 *
 * The intra-batch invariant ("replaceAll must be the only op") is enforced as
 * `operations.length > 1`, but the batch is the STREAMING DELTA, not the whole
 * response: ChatPanel re-parses on every chunk and `filterUnappliedScriptOps`
 * strips already-applied ops, so the two arrive as two batches of ONE each and
 * that guard never fires.
 *
 * `buildBaseMutations` returns [] for `replaceAll` (its `default` arm), so the
 * later `insert` rebased through an EMPTY mutation list and applied a
 * base-snapshot offset to the post-replaceAll text -- landing at an arbitrary
 * point, or clamped to EOF, with `ok: true` and no diagnostic.
 *
 * `replaceSelection` already had this protection via `priorAcceptedOps`;
 * `replaceAll` did not, though it invalidates positional offsets just as
 * thoroughly.
 */
test('an insert cannot follow a replaceAll accepted in an earlier streaming batch', () => {
  const baseContent = 'AAA';

  const first = applyScriptEditOperations({
    content: baseContent,
    selection: { from: 0, to: 0 },
    revision: 1,
    baseContentSnapshot: baseContent,
    operations: [
      { opId: 'rewrite', type: 'replaceAll', baseRevision: 1, text: 'ZZZZZZZZZZ' },
    ],
  });
  assert.equal(first.ok, true);
  assert.equal(first.content, 'ZZZZZZZZZZ');

  const second = applyScriptEditOperations({
    content: first.content,
    selection: first.selection,
    revision: first.revision,
    priorAcceptedOps: [
      { opId: 'rewrite', type: 'replaceAll', baseRevision: 1, text: 'ZZZZZZZZZZ' },
    ],
    acceptedBaseRevision: 1,
    baseContentSnapshot: baseContent,
    operations: [
      { opId: 'late-insert', type: 'insert', baseRevision: 1, at: 1, text: 'X' },
    ],
  });

  assert.equal(second.ok, false, 'a positional op after a replaceAll must be rejected');
  // Assert the REASON, not just the rejection: an unrelated failure (a revision
  // conflict, a range error) would satisfy `ok === false` while leaving the
  // actual gap open.
  assert.match(
    JSON.stringify(second),
    /cannot follow a whole-content edit/,
    'must be rejected for following a whole-content edit, not for some other reason',
  );
  // And the content must be untouched by the rejected batch.
  assert.equal(second.content, 'ZZZZZZZZZZ');
});

test('a replaceRange is rejected the same way after a cross-batch replaceAll', () => {
  const baseContent = 'AAA';
  const result = applyScriptEditOperations({
    content: 'ZZZZZZZZZZ',
    selection: { from: 0, to: 0 },
    revision: 2,
    priorAcceptedOps: [
      { opId: 'rewrite', type: 'replaceAll', baseRevision: 1, text: 'ZZZZZZZZZZ' },
    ],
    acceptedBaseRevision: 1,
    baseContentSnapshot: baseContent,
    operations: [
      { opId: 'late-range', type: 'replaceRange', baseRevision: 1, from: 0, to: 2, text: 'Q' },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /cannot follow a whole-content edit/);
});

test('an append after a cross-batch replaceAll is still allowed', () => {
  // Control: `append` keys off `content.length`, not a base-snapshot offset,
  // so it is unaffected by the rewrite and must NOT be swept up by the guard.
  const baseContent = 'AAA';
  const result = applyScriptEditOperations({
    content: 'ZZZZZZZZZZ',
    selection: { from: 0, to: 0 },
    revision: 2,
    priorAcceptedOps: [
      { opId: 'rewrite', type: 'replaceAll', baseRevision: 1, text: 'ZZZZZZZZZZ' },
    ],
    acceptedBaseRevision: 1,
    baseContentSnapshot: baseContent,
    operations: [
      { opId: 'tail', type: 'append', baseRevision: 1, text: '!' },
    ],
  });
  assert.equal(result.ok, true, 'append is offset-free and must remain permitted');
  assert.equal(result.content, 'ZZZZZZZZZZ!');
});
