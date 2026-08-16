/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The stripper is the load-bearing half of every source-text assertion in
 * `scripts/source-text-assertion-allowlist.txt`: if it lets a comment through,
 * the assertion it guards can be satisfied by prose quoting the call it exists
 * to pin, and the real call can be deleted with the suite green.
 *
 * Each case below is a hole one of the two predecessors actually had.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripComments } from './strip-comments.js';

describe('stripComments', () => {
  it('drops a TRAILING comment on a line of real code', () => {
    // The hole in `modelLoadedGeometryProps.test.ts`'s `stripLineComments`,
    // which filtered only lines whose `trimStart()` began with `//`. Deleting
    // the real spread from `useIfcLoader.ts` and appending one trailing comment
    // quoting it kept all four argument-span assertions green (#2393 review).
    const out = stripComments('wasHidden: wasHidden(), // ...buildModelLoadedGeometryProps({ diagnostics: loadDiagnostics })');
    assert.equal(out, 'wasHidden: wasHidden(), ');
    assert.ok(!out.includes('buildModelLoadedGeometryProps'));
  });

  it('drops a whole-line comment', () => {
    assert.equal(stripComments('a\n  // buildX(y)\nb'), 'a\n  \nb');
    assert.ok(!stripComments('  // buildX(y)').includes('buildX'));
  });

  it('drops a BLOCK comment, including a JSDoc one', () => {
    // `useIfcLoader.ts` has 13 block comments, one nine lines below the
    // declaration the argument-span assertion protects.
    const src = 'before\n/**\n * ...buildModelLoadedGeometryProps({ diagnostics: loadDiagnostics })\n */\nafter';
    const out = stripComments(src);
    assert.ok(!out.includes('buildModelLoadedGeometryProps'));
    assert.ok(out.includes('before') && out.includes('after'));
  });

  it('drops a block comment that opens mid-line, keeping the code around it', () => {
    assert.equal(stripComments('const a = 1; /* buildX( */ const b = 2;'), 'const a = 1;  const b = 2;');
  });

  it('preserves the line count so line-oriented reads stay aligned', () => {
    const src = 'a\n/* one\n   two\n   three */\nb';
    assert.equal(stripComments(src).split('\n').length, src.split('\n').length);
  });

  it('does NOT truncate a line at the `//` of a URL inside a string', () => {
    // The failure mode in the OTHER direction: a naive `indexOf('//')` would
    // delete the rest of a real line of code, weakening the assertion silently.
    const src = "const url = 'https://example.com/x'; buildX(url);";
    assert.equal(stripComments(src), src);
  });

  it('handles double, single and template quotes, and escaped quotes', () => {
    assert.equal(stripComments('const a = "a // b"; buildX();'), 'const a = "a // b"; buildX();');
    assert.equal(stripComments('const a = `a // b`; buildX();'), 'const a = `a // b`; buildX();');
    // The escape must not be read as closing the literal — otherwise the `//`
    // that follows would be treated as a comment and eat `buildX()`.
    assert.equal(stripComments("const a = 'it\\'s // fine'; buildX();"), "const a = 'it\\'s // fine'; buildX();");
  });

  it('leaves a division operator alone', () => {
    assert.equal(stripComments('const ratio = a / b; buildX();'), 'const ratio = a / b; buildX();');
  });

  it('tolerates an unterminated block comment rather than throwing', () => {
    assert.equal(stripComments('code\n/* never closed').trimEnd(), 'code');
  });
});
