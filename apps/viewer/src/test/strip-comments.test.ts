/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The stripper is the load-bearing half of every source-text assertion in
 * `scripts/source-text-assertion-allowlist.txt`: if it lets PROSE through, the
 * assertion it guards can be satisfied by text that merely quotes the call it
 * exists to pin, and the real call can be deleted with the suite green.
 *
 * Each case below is a hole one of the predecessors actually had, demonstrated
 * against `useIfcLoader.ts` before it was closed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripSource } from './strip-comments.js';

/** The `code` view: comments gone, literals verbatim. */
const code = (src: string, fileName?: string): string => stripSource(src, fileName).code;

const DECOY = '...buildModelLoadedGeometryProps({ diagnostics: loadDiagnostics })';

describe('stripSource().code (comments gone, literals intact)', () => {
  it('drops a TRAILING comment on a line of real code', () => {
    // The hole in `modelLoadedGeometryProps.test.ts`'s `stripLineComments`,
    // which filtered only lines whose `trimStart()` began with `//`. Deleting
    // the real spread from `useIfcLoader.ts` and appending one trailing comment
    // quoting it kept all four argument-span assertions green (#2393 review).
    const out = code(`wasHidden: wasHidden(), // ${DECOY}`);
    assert.equal(out.trimEnd(), 'wasHidden: wasHidden(),');
    assert.ok(!out.includes('buildModelLoadedGeometryProps'));
  });

  it('drops a whole-line comment', () => {
    assert.ok(!code('a\n  // buildX(y)\nb').includes('buildX'));
    assert.ok(!code('  // buildX(y)').includes('buildX'));
  });

  it('drops a BLOCK comment, including a JSDoc one', () => {
    // `useIfcLoader.ts` has 13 block comments, one nine lines below the
    // declaration the argument-span assertion protects.
    const out = code(`before;\n/**\n * ${DECOY}\n */\nafter;`);
    assert.ok(!out.includes('buildModelLoadedGeometryProps'));
    assert.ok(out.includes('before') && out.includes('after'));
  });

  it('drops a block comment that opens mid-line, keeping the code around it', () => {
    assert.equal(
      code('const a = 1; /* buildX( */ const b = 2;').replace(/\s+/g, ' '),
      'const a = 1; const b = 2;',
    );
  });

  it('preserves the line count so line-oriented reads stay aligned', () => {
    const src = 'a;\n/* one\n   two\n   three */\nb;';
    assert.equal(code(src).split('\n').length, src.split('\n').length);
  });

  it('does NOT truncate a line at the `//` of a URL inside a string', () => {
    // The failure mode in the OTHER direction: a naive `indexOf('//')` would
    // delete the rest of a real line of code, weakening the assertion silently.
    const src = "const url = 'https://example.com/x'; buildX(url);";
    assert.equal(code(src), src);
  });

  it('handles double, single and template quotes, and escaped quotes', () => {
    assert.equal(code('const a = "a // b"; buildX();'), 'const a = "a // b"; buildX();');
    assert.equal(code('const a = `a // b`; buildX();'), 'const a = `a // b`; buildX();');
    // The escape must not be read as closing the literal — otherwise the `//`
    // that follows would be treated as a comment and eat `buildX()`.
    assert.equal(code("const a = 'it\\'s // fine'; buildX();"), "const a = 'it\\'s // fine'; buildX();");
  });

  it('leaves a division operator alone', () => {
    assert.equal(code('const ratio = a / b; buildX();'), 'const ratio = a / b; buildX();');
  });

  it('tolerates an unterminated block comment rather than throwing', () => {
    assert.equal(code('code;\n/* never closed').trimEnd(), 'code;');
  });
});

describe('stripSource().masked (the view assertions run against)', () => {
  it('blanks a decoy hidden in a STRING literal', () => {
    // The hole the lexical predecessor had, demonstrated on this branch:
    // replacing the real spread with `__decoy: '<the spread>'` in the SAME
    // argument span left every assertion in `modelLoadedGeometryProps.test.ts`
    // green while the emitted `ifc_model_loaded` carried none of the fields.
    // A string is not a comment, so comment stripping alone cannot see it.
    const { code, masked } = stripSource(`const x = { __decoy: '${DECOY}' };`);
    assert.ok(code.includes('buildModelLoadedGeometryProps'), 'code keeps literals verbatim');
    assert.ok(!masked.includes('buildModelLoadedGeometryProps'));
  });

  it('blanks a decoy hidden in a TEMPLATE literal, and keeps the expressions in one', () => {
    assert.ok(!stripSource(`const x = \`${DECOY}\`;`).masked.includes('buildModelLoaded'));
    // Only the literal parts are prose; a substitution is real code and must
    // survive, or masking would weaken assertions the way a naive `//` scan did.
    const withSubstitution = `const x = \`a \${realCall()} b\`;`;
    assert.ok(stripSource(withSubstitution).masked.includes('realCall()'));
  });

  it('blanks JSX text, which is prose in a .tsx exactly as a comment is', () => {
    const { masked } = stripSource(`const el = <p>${DECOY}</p>;`, 'x.tsx');
    assert.ok(!masked.includes('buildModelLoadedGeometryProps'));
  });

  it('keeps offsets identical to `code`, so an index found in one slices the other', () => {
    const src = "const a = 'zz'; const anchor = 1; // c\nconst b = 2;";
    const { code, masked } = stripSource(src);
    assert.equal(code.length, masked.length);
    const i = code.indexOf('const anchor');
    assert.ok(i >= 0);
    assert.equal(masked.slice(i, i + 'const anchor'.length), 'const anchor');
  });

  it('is not desynchronised by a REGEX literal containing an unbalanced quote', () => {
    // The second hole demonstrated on this branch. The lexical predecessor read
    // the `'` inside `/['"]/g` as opening a string, after which the `//` on the
    // next line was NOT a comment to it — so a plainly commented-out call
    // passed both the argument-span check and the whole-file one. A parse
    // decides regex-vs-divide the way the compiler does.
    const src = `const re = /['"]/g;\n// ${DECOY}\nconst after = 1;`;
    const { code, masked } = stripSource(src);
    assert.ok(!code.includes('buildModelLoadedGeometryProps'), 'the comment is still a comment');
    assert.ok(!masked.includes('buildModelLoadedGeometryProps'));
    assert.ok(masked.includes('const after = 1;'), 'real code after the regex survives');
  });

  it('does not let a paren inside a string unbalance a bracket scan', () => {
    // `captureArgsAround` walks parens over `masked` for this reason: an
    // argument span that closed early would silently shrink what is asserted.
    const { masked } = stripSource("call('a(b', realArg);");
    assert.equal((masked.match(/\(/g) ?? []).length, 1);
  });
});
