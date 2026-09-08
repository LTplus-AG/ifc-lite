/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source preparation for the handful of tests that still assert on SOURCE TEXT
 * (`scripts/source-text-assertion-allowlist.txt`).
 *
 * Every such test has the same hazard: the string it looks for can be
 * satisfied by PROSE that merely *quotes* the call it is supposed to be
 * pinning, so the real call can be deleted while the assertion stays green.
 * `SearchModal.filter.wiring.test.ts` caught exactly that.
 *
 * Prose hides in three places, not one — a comment, a string/template literal,
 * and (in `.tsx`) JSX text — so this returns two views of the file:
 *
 *  - `code`: comments removed, literals intact. Use it to LOCATE things, so an
 *    anchor may still be a string (`load_path: 'server'`).
 *  - `masked`: same length and the same offsets as `code`, with every
 *    string/template/regex/JSX-text body masked out. Use it for the
 *    ASSERTIONS, and for any bracket matching — a `(` inside `'https://a(b'`
 *    would otherwise unbalance the scan.
 *
 * Because the two views share offsets, an index found in `code` slices `masked`
 * directly.
 *
 * ## Why this is a TypeScript parse and not a lexical scan
 *
 * The predecessor was a hand-rolled scanner, and it was defeated on this branch
 * in two ways that a parse closes by construction:
 *
 *  - a string literal is not a comment, so quoting the protected call inside
 *    one satisfied every assertion with the real call deleted. Verified: with
 *    `...buildModelLoadedGeometryProps({…})` replaced by
 *    `__decoy: '...buildModelLoadedGeometryProps({…})'`, all of
 *    `modelLoadedGeometryProps.test.ts` stayed green;
 *  - a regex literal containing an unbalanced quote (`/['"]/g`) desynchronised
 *    the scanner's string tracker, after which a `//` comment was NOT stripped
 *    — so a plain commented-out call passed. The old header called this out as
 *    "NOT handled, deliberately"; it turned out to be exploitable in exactly
 *    the way the guard exists to prevent, in both the argument-span check and
 *    the whole-file one.
 *
 * The parser decides regex-vs-divide, template nesting, JSX and escapes the way
 * the compiler does, so none of those categories is a judgement call here.
 *
 * ## Why this does not read the file for you
 *
 * A `readStrippedSource(url)` convenience was written and removed. It made
 * `scripts/check-source-text-assertions.mjs` stop seeing both callers: that
 * detector is lexical and requires a `readFileSync` AND a `.ts` literal in the
 * TEST file, so hiding the read behind a helper silently exempted every future
 * source-text assertion written through it — the #2434 ratchet reporting a
 * shrinking list while the pattern spread. The `readFileSync` stays at the call
 * site on purpose. Verified by running that script both ways.
 *
 * Do NOT reach for this to make a NEW source-text assertion possible. The
 * allowlist only ratchets down; a behavioural test is the answer.
 */
import ts from 'typescript';

export interface StrippedSource {
  /** Comments removed. String/template/regex/JSX-text bodies left intact. */
  code: string;
  /** Same length and offsets as `code`, literal bodies masked out. */
  masked: string;
}

/**
 * A middle dot, not a space and not NUL: no assertion string in the repo
 * contains one, so a masked literal cannot accidentally spell part of what is
 * being asserted; it is one UTF-16 unit, so offsets still line up with `code`;
 * and it is printable, so a failure message stays readable text rather than
 * turning the whole TAP log binary.
 */
const MASK_CHAR = '\u00b7';
const COMMENT = 1;
const LITERAL = 2;

function isLiteralKind(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === ts.SyntaxKind.TemplateHead ||
    kind === ts.SyntaxKind.TemplateMiddle ||
    kind === ts.SyntaxKind.TemplateTail ||
    kind === ts.SyntaxKind.RegularExpressionLiteral ||
    kind === ts.SyntaxKind.JsxText
  );
}

/**
 * Everything between two tokens is trivia — whitespace and comments, nothing
 * else — so a comment is simply a non-whitespace character in a gap. Deriving
 * it that way rather than re-scanning for `//` means the parser's own idea of
 * where a token starts is what decides, including inside JSX and after a regex
 * literal.
 */
function classify(sourceFile: ts.SourceFile, source: string): Uint8Array {
  const cls = new Uint8Array(source.length);
  let prevEnd = 0;

  const markGap = (until: number): void => {
    for (let i = prevEnd; i < until; i++) {
      if (!/\s/.test(source[i])) cls[i] = COMMENT;
    }
  };

  const walk = (node: ts.Node): void => {
    if (ts.isJSDoc(node)) {
      // A JSDoc block is trivia, but the parser also hangs it off the node it
      // documents, so `getChildren` walks into it. Left to the leaf pass its
      // prose would survive as "code" — and `useIfcLoader.ts` documents the
      // protected declaration with one.
      markGap(node.end);
      prevEnd = Math.max(prevEnd, node.end);
      return;
    }
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      markGap(node.getStart(sourceFile, /* includeJsDocComment */ false));
      prevEnd = Math.max(prevEnd, node.end);
      if (isLiteralKind(node.kind)) {
        for (let i = node.getStart(sourceFile); i < node.end; i++) cls[i] = LITERAL;
      }
      return;
    }
    for (const child of children) walk(child);
  };

  walk(sourceFile);
  markGap(source.length);
  return cls;
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  return fileName.endsWith('.tsx') || fileName.endsWith('.jsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
}

export function stripSource(source: string, fileName = 'source.ts'): StrippedSource {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(fileName),
  );
  const cls = classify(sourceFile, source);

  let code = '';
  let masked = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (cls[i] === COMMENT) {
      // Keep the newlines a comment spanned so line-oriented reads and error
      // messages stay aligned with the real file.
      if (ch === '\n') {
        code += '\n';
        masked += '\n';
      }
      continue;
    }
    code += ch;
    masked += cls[i] === LITERAL && ch !== '\n' ? MASK_CHAR : ch;
  }

  return { code, masked };
}
