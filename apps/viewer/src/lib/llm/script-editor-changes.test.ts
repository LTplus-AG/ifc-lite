/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeSet, Text } from '@codemirror/state';
import { planScriptEditorChanges } from './script-editor-changes.js';
import { applyScriptEditOperations } from './script-edit-ops.js';
import type { ScriptEditorTextChange } from './types.js';

function docOf(content: string): Text {
  return Text.of(content.split('\n'));
}

/** The splice semantics `applyScriptEditOperations` itself uses for `changes`. */
function spliceSequentially(content: string, changes: readonly ScriptEditorTextChange[]): string {
  let out = content;
  for (const change of changes) {
    out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  }
  return out;
}

/**
 * Regression for #2300 — `RangeError: Invalid change range 8048 to 10082 (in
 * doc of length 7932)` — reproduced from the reported numbers.
 *
 * A 2150-char insert followed by a `replaceRange` that runs to the end of the
 * base snapshot: rebased, the second spec is [5898+2150, 7932+2150] =
 * [8048, 10082]. Those are coordinates in the content the FIRST spec
 * produced, but the old adapter handed the whole array to one `dispatch`,
 * where CodeMirror reads every spec against the original 7932-char document.
 */
test('#2300: a grown-past-the-document batch composes instead of throwing a RangeError', () => {
  const base = 'x'.repeat(7932);
  const changes: ScriptEditorTextChange[] = [
    { from: 100, to: 100, insert: 'y'.repeat(2150) },
    { from: 8048, to: 10082, insert: 'tail' },
  ];
  const nextContent = spliceSequentially(base, changes);
  const doc = docOf(base);

  // The pre-fix dispatch, pinned so the mechanism cannot be misremembered.
  assert.throws(
    () => ChangeSet.of(changes, doc.length),
    /Invalid change range 8048 to 10082 \(in doc of length 7932\)/,
  );

  const plan = planScriptEditorChanges(doc, changes, nextContent);
  assert.equal(plan.ok, true, 'the batch must be replayable onto the live document');
  assert.equal(plan.ok && plan.changes.apply(doc).toString(), nextContent);
});

/**
 * Regression for #2357 — `RangeError: Invalid change range 2090 to 2197 (in
 * doc of length 2159)`. Same shape, a 38-char insert ahead of a
 * replace-to-end-of-snapshot: [2052+38, 2159+38] = [2090, 2197].
 */
test('#2357: the smaller reported overflow composes instead of throwing', () => {
  const base = 'a'.repeat(2159);
  const changes: ScriptEditorTextChange[] = [
    { from: 12, to: 12, insert: 'b'.repeat(38) },
    { from: 2090, to: 2197, insert: 'const done = true;' },
  ];
  const nextContent = spliceSequentially(base, changes);
  const doc = docOf(base);

  assert.throws(
    () => ChangeSet.of(changes, doc.length),
    /Invalid change range 2090 to 2197 \(in doc of length 2159\)/,
  );

  const plan = planScriptEditorChanges(doc, changes, nextContent);
  assert.equal(plan.ok, true);
  assert.equal(plan.ok && plan.changes.apply(doc).toString(), nextContent);
});

/**
 * The silent half of #2357 / #2300: when the sequential coordinates happen to
 * fit the original document, the old dispatch did not throw — it applied a
 * DIFFERENT edit, leaving CodeMirror holding text the store never had.
 */
test('#2300: in-bounds sequential specs still apply sequentially, not as original-document specs', () => {
  const base = 'ABCDEF';
  const changes: ScriptEditorTextChange[] = [
    { from: 0, to: 0, insert: 'XX' },
    { from: 1, to: 2, insert: 'Z' },
  ];
  const nextContent = spliceSequentially(base, changes);
  const doc = docOf(base);
  assert.equal(nextContent, 'XZABCDEF');

  // Original-document semantics would give a different string entirely, with
  // no error to reveal it.
  assert.equal(ChangeSet.of(changes, doc.length).apply(doc).toString(), 'XXAZCDEF');

  const plan = planScriptEditorChanges(doc, changes, nextContent);
  assert.equal(plan.ok, true);
  assert.equal(plan.ok && plan.changes.apply(doc).toString(), 'XZABCDEF');
});

/**
 * End-to-end producer/consumer invariant: whatever `applyScriptEditOperations`
 * writes into the store, replaying its own `changes` onto the document the
 * store was in sync with must reproduce byte for byte. This is the contract
 * the crash violated.
 */
test('#2357: the applier\'s own changes replay onto the editor document exactly', () => {
  const base = [
    'const models = bim.model.list()',
    'const walls = bim.query.byType("IfcWall")',
    'console.log(walls.length)',
    '',
  ].join('\n');

  const result = applyScriptEditOperations({
    content: base,
    selection: { from: 0, to: 0 },
    revision: 4,
    operations: [
      { opId: 'add-header', type: 'insert', baseRevision: 4, at: 0, text: '// Wall audit\n'.repeat(4) },
      {
        opId: 'rewrite-tail',
        type: 'replaceRange',
        baseRevision: 4,
        from: base.indexOf('console.log'),
        to: base.length,
        text: 'console.log("walls:", walls.length)\n',
      },
    ],
  });

  assert.equal(result.ok, true);
  const produced = result.changes ?? [];
  assert.equal(produced.length, 2, 'both ops must have produced a change spec');
  const doc = docOf(base);
  // The batch grows past the base length, so the pre-fix dispatch threw here.
  assert.throws(() => ChangeSet.of(produced, doc.length), /Invalid change range/);

  const plan = planScriptEditorChanges(doc, produced, result.content);
  assert.equal(plan.ok, true);
  assert.equal(plan.ok && plan.changes.apply(doc).toString(), result.content);
});

/**
 * The divergence case the adapter must catch rather than dispatch: the live
 * document is not what the store thinks it is (shorter here), so the batch
 * cannot be replayed. Rejecting lets the caller fall back to a whole-document
 * set, which keeps the two copies equal.
 */
test('#2300: a batch that does not fit the live document is rejected, not dispatched', () => {
  const storeContent = 'a'.repeat(400);
  const changes: ScriptEditorTextChange[] = [{ from: 380, to: 400, insert: 'end' }];
  const nextContent = spliceSequentially(storeContent, changes);

  const drifted = docOf('a'.repeat(120));
  const plan = planScriptEditorChanges(drifted, changes, nextContent);
  assert.equal(plan.ok, false);
  assert.equal(plan.ok === false && plan.reason, 'out_of_bounds');
  assert.equal(plan.ok === false && plan.docLength, 120);
  assert.equal(plan.ok === false && plan.rangeTo, 400);
});

/**
 * The exact boundary of the bounds guard. `to === length` is the accept side
 * (a replace running to the very end of the document, which is what both
 * reported crashes ended on), so the reject side has to be pinned at
 * `length + 1` or an off-by-one in the guard is invisible: relaxing it to
 * `change.to <= length + 1` reintroduces the uncaught throw, because
 * `ChangeSet.of({from: 0, to: 6, insert: 'x'}, 5)` raises
 * `Invalid change range 0 to 6 (in doc of length 5)`.
 */
test('#2357: a one-past-the-end range is rejected rather than thrown', () => {
  const doc = docOf('a'.repeat(100));
  const changes: ScriptEditorTextChange[] = [{ from: 0, to: 101, insert: '' }];

  const plan = planScriptEditorChanges(doc, changes, '');
  assert.equal(plan.ok, false, 'to === length + 1 must not be treated as applicable');
  assert.equal(plan.ok === false && plan.reason, 'out_of_bounds');
  assert.equal(plan.ok === false && plan.docLength, 100);
  assert.equal(plan.ok === false && plan.rangeTo, 101);

  // The accept side of the same boundary, so the guard cannot be "fixed" by
  // rejecting everything that reaches the end of the document.
  const atEnd = planScriptEditorChanges(doc, [{ from: 0, to: 100, insert: '' }], '');
  assert.equal(atEnd.ok, true, 'to === length is a legal replace-to-end-of-document');
});

/**
 * In-bounds but wrong: the document drifted in CONTENT, not length. Applying
 * would leave CodeMirror and `scriptEditorContent` holding different text, so
 * this must be rejected too.
 */
test('#2357: a batch that applies cleanly but misses the expected content is rejected', () => {
  const storeContent = 'const total = 1\nconst other = 2\n';
  const changes: ScriptEditorTextChange[] = [{ from: 14, to: 15, insert: '9' }];
  const nextContent = spliceSequentially(storeContent, changes);

  // Same length, so every range still fits — but the user changed a line the
  // batch does not touch, so the batch cannot land on `nextContent`.
  const drifted = docOf('const total = 1\nconst other = 7\n');
  const plan = planScriptEditorChanges(drifted, changes, nextContent);
  assert.equal(plan.ok, false);
  assert.equal(plan.ok === false && plan.reason, 'content_mismatch');
});

/**
 * Line endings are a real second source of store/document drift, not a
 * hypothetical one. CodeMirror splits on `/\r\n?|\n/` when it builds a
 * document AND when it applies an insert, so a `\r\n` script that reached
 * `scriptEditorContent` without passing through the editor (see the PR body)
 * leaves the store's copy longer than the document by one char per CRLF, and
 * every range measured against the store then overshoots.
 *
 * This pins what the fix guarantees in that case: a rejection the adapter can
 * degrade from, never the uncaught RangeError.
 */
test('#2300: CRLF drift between the store and the document is rejected, not thrown', () => {
  const storeContent = 'const a = 1\r\nconst b = 2\r\n';
  // What CodeMirror actually holds after being handed that text.
  const doc = docOf(storeContent.replace(/\r\n/g, '\n'));
  assert.equal(storeContent.length - doc.length, 2, 'the store copy is longer by one char per CRLF');

  const changes: ScriptEditorTextChange[] = [
    { from: 12, to: storeContent.length, insert: 'const b = 3\r\n' },
  ];
  const plan = planScriptEditorChanges(doc, changes, spliceSequentially(storeContent, changes));
  assert.equal(plan.ok, false);
  assert.equal(plan.ok === false && plan.reason, 'out_of_bounds');
  assert.equal(plan.ok === false && plan.rangeTo, storeContent.length);
});

/** A batch that does fit and does reproduce the content is accepted as-is. */
test('#2300: an in-sync single-op batch is still applied incrementally', () => {
  const storeContent = 'const total = 1\nconst other = 2\n';
  const changes: ScriptEditorTextChange[] = [{ from: 14, to: 15, insert: '9' }];
  const nextContent = spliceSequentially(storeContent, changes);
  const doc = docOf(storeContent);

  const plan = planScriptEditorChanges(doc, changes, nextContent);
  assert.equal(plan.ok, true);
  assert.equal(plan.ok && plan.changes.apply(doc).toString(), nextContent);
  // Incremental, not a whole-document replace: only the one touched range may
  // be reported as changed, so CodeMirror's undo history and cursor mapping
  // still see a one-character edit.
  const touched: Array<[number, number]> = [];
  if (plan.ok) plan.changes.iterChangedRanges((fromA, toA) => { touched.push([fromA, toA]); });
  assert.deepEqual(touched, [[14, 15]]);
});
