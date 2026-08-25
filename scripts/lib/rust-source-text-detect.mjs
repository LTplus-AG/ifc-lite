/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Detection half of scripts/check-rust-source-text-assertions.mjs (#3195),
 * split out so it can be unit-tested against hand-written Rust instead of only
 * against whatever `rust/` happens to contain today.
 *
 * THE RULE is AGENTS.md's, the same one the TypeScript gate enforces: "Never
 * assert on a source file's text. A test that reads `Thing.tsx` and greps it
 * certifies a string exists, not that the code works." `rust/` was outside that
 * gate's scan scope entirely -- `grep -c rust scripts/check-source-text-assertions.mjs`
 * returned 0 -- so the maintainer demonstrated the hole by planting
 * `fs::read_to_string("src/api/space_plate_input.rs")` plus a `contains` in a
 * real Rust test and watching CI stay green (#3129, then #3195).
 *
 * ═══ SOURCE READ vs FIXTURE READ ═══
 *
 * This is the whole design, so it is stated as a rule rather than a heuristic:
 *
 *   A read is flagged when, and only when, the path it reads is spelled by a
 *   STRING LITERAL whose extension is a SOURCE extension.
 *
 * Fixtures are not excluded by a denylist of fixture formats -- `.ifc`,
 * `.ifcx`, `.json`, `.txt`, `.glb`, a golden manifest -- they are out of scope
 * by construction, because their extension is not in SOURCE_EXTENSIONS. That
 * matters because the fixture side is the side with the long tail: this tree
 * reads at least nine distinct fixture formats, and a denylist would have to
 * grow with every new one, failing OPEN each time someone forgot. An
 * extension allowlist fails CLOSED on an unknown format -- a new fixture type
 * is simply not flagged, and a new source type has to be added here
 * deliberately.
 *
 * The literal may be written at the read site or bound once and named:
 *
 *   std::fs::read_to_string("../src/lib.rs")           // direct
 *   const SUBJECT: &str = "../src/lib.rs";             // named, resolved here
 *   let text = std::fs::read_to_string(SUBJECT);       //   because this spelling
 *                                                      //   is the tree's norm
 *   include_str!("fixtures/vectors.json")              // NOT a source extension
 *
 * ═══ PROSE IS NOT CODE ═══
 *
 * Inherited, deliberately, from the TypeScript gate's docblock, where it is
 * load-bearing rather than tidy: three unrelated tests there mention a `.ts`
 * filename in a COMMENT while reading a wasm binary or a JSON manifest, and
 * matching those flagged all three falsely. The same trap is live in `rust/`,
 * where doc comments routinely name `.rs` paths -- `styling_parity.rs` and
 * `module_size_ratchet.rs` each name several in prose.
 *
 * So this module lexes Rust rather than grepping it. Comments and string
 * literals are MASKED out of the code plane, and:
 *
 *   - a path is read only from a STRING LITERAL token, so a comment naming
 *     `space_plate_input.rs` can never stand in for one;
 *   - a suppression marker is read only from COMMENT trivia, so a string
 *     containing `@source-text-assertion-ok` can never forge one;
 *   - a marker's reach is a CHARACTER range (the enclosing statement, found by
 *     scanning the masked text back to the previous `;`/`{`/`}`), not a run of
 *     lines that look unfinished, so a comment INSIDE the statement does not
 *     break the range logic. That break is #3174, which cost the TypeScript
 *     gate a double failure -- the assertion AND the marker it said excused
 *     nothing -- and printed a remedy it would not itself accept.
 *
 * The lexer handles the Rust-specific shapes that defeat a naive scan: raw
 * strings (`r"..."`, `r#"..."#` with any hash count), byte and byte-raw strings
 * (`b"..."`, `br#"..."#`), NESTED block comments (legal in Rust, unlike C), and
 * the `'` ambiguity between a char literal and a lifetime. Each of those, left
 * unhandled, is a fail-OPEN: an unterminated string swallows the rest of the
 * file and the gate goes quiet, which is how every one of the TypeScript
 * detector's pre-#3174 bugs presented.
 *
 * ═══ WHY NO TAINT PAIRING ═══
 *
 * The TypeScript detector pairs the read with the predicate: a `.includes()`
 * counts only when applied to a value a read produced. It has to, because
 * reading a fixture is ubiquitous there and the extension carries no signal
 * (`generate-ifc-schema.test.ts` reads `.ts` fixtures to copy them, and was
 * falsely flagged until the pairing landed).
 *
 * Here the extension IS the signal, and it already separates the two
 * populations, so the pairing would only be able to make the gate LOOSER.
 * Reading a source file inside a test and not asserting on it is not a shape
 * this tree contains -- measured: zero such sites -- and "stricter is the safe
 * direction for a ratchet" is the same call the TypeScript detector's docblock
 * makes about its own over-tainting. If a legitimate one appears, the marker is
 * the answer, and it stays a named line in the gate's output.
 *
 * ═══ LIMITATIONS -- read before assuming coverage ═══
 *
 *  - NOT CAUGHT: a source read whose path is computed rather than spelled --
 *    a directory walk that filters on `extension() == Some("rs")` and reads
 *    what it finds. That is the shape the two legitimate repo-wide ratchets in
 *    `rust/processing/tests/` use (`styling_parity.rs`,
 *    `module_size_ratchet.rs`), and it is also a hole a violation could be
 *    written into. Closing it by flagging every `read_to_string` under such a
 *    walk was measured and rejected: it flags both ratchets, which are the
 *    exact tests the repo wants, and a gate whose first act is to demand
 *    markers on correct code gets suppressed wholesale.
 *  - NOT CAUGHT: a path assembled by `format!`/`join`/`PathBuf::push` from
 *    fragments, since no single literal carries the extension.
 *  - NOT CAUGHT: a read through a helper that takes the literal at ITS call
 *    site and passes it on -- resolution is one hop, from a file-level `const`
 *    or `static` or a `let` binding to a literal, not a dataflow.
 *  - WEAK: test scope is `#[cfg(test)]` blocks, `tests/` directories and
 *    `*_test.rs` / `*_tests.rs` / `tests.rs` files. A source read from
 *    NON-test code (a build script, a CLI that legitimately reads Rust) is out
 *    of scope on purpose -- the rule is about tests.
 */

/** Extensions that make a read target a SOURCE file rather than a fixture. */
export const SOURCE_EXTENSIONS = ['.rs', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** The marker, shared with the TypeScript gate so the repo has one vocabulary. */
export const MARKER = '@source-text-assertion-ok';

/**
 * Read calls whose first argument names a file. `read_dir` is absent on
 * purpose: it names a directory, and the reads it leads to are the computed
 * paths the limitations note as out of reach.
 */
const READ_CALLS = ['read_to_string', 'read', 'open'];
const READ_MACROS = ['include_str', 'include_bytes'];

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isIdentChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Offset -> 1-based line number, precomputed so the scan stays linear.
 *
 * @param {string} text
 * @returns {(offset: number) => number}
 */
function makeLineIndex(text) {
  const starts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') starts.push(k + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Lex Rust into a masked code plane plus the trivia the gate needs.
 *
 * `masked` is character-for-character the same length as `text`, with every
 * comment and every string/char literal replaced by spaces (newlines kept, so
 * offsets and line numbers survive). Everything structural -- parens, braces,
 * semicolons, identifiers -- is read from `masked`, which is what makes a brace
 * inside a string or a `;` inside a comment inert.
 *
 * @param {string} text
 * @returns {{ masked: string, strings: Array<{start:number,end:number,value:string}>, comments: Array<{start:number,line:number,text:string}> }}
 */
export function lex(text) {
  const masked = new Array(text.length);
  for (let k = 0; k < text.length; k++) masked[k] = text[k];
  const blank = (from, to) => {
    for (let k = from; k < to && k < text.length; k++) if (text[k] !== '\n') masked[k] = ' ';
  };
  /** @type {Array<{start:number,end:number,value:string}>} */
  const strings = [];
  /** @type {Array<{start:number,line:number,text:string}>} */
  const comments = [];

  const lineOf = makeLineIndex(text);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // Line comment.
    if (c === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < text.length && text[j] !== '\n') j++;
      comments.push({ start: i, line: lineOf(i), text: text.slice(i, j) });
      blank(i, j);
      i = j;
      continue;
    }
    // Block comment -- NESTED, which is legal in Rust and not in C.
    if (c === '/' && text[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      comments.push({ start: i, line: lineOf(i), text: text.slice(i, j) });
      blank(i, j);
      i = j;
      continue;
    }
    // Raw string, with or without a byte prefix: r"..", r#".."#, br##".."##.
    if ((c === 'r' || (c === 'b' && text[i + 1] === 'r')) && !isIdentChar(text[i - 1])) {
      const prefixLen = c === 'r' ? 1 : 2;
      let j = i + prefixLen;
      let hashes = 0;
      while (text[j] === '#') {
        hashes++;
        j++;
      }
      if (text[j] === '"') {
        const contentStart = j + 1;
        const terminator = '"' + '#'.repeat(hashes);
        const endIdx = text.indexOf(terminator, contentStart);
        const contentEnd = endIdx === -1 ? text.length : endIdx;
        const end = Math.min(contentEnd + terminator.length, text.length);
        strings.push({ start: i, end, value: text.slice(contentStart, contentEnd) });
        blank(i, end);
        i = end;
        continue;
      }
    }
    // Ordinary or byte string.
    if (c === '"' || (c === 'b' && text[i + 1] === '"' && !isIdentChar(text[i - 1]))) {
      const start = i;
      let j = c === '"' ? i + 1 : i + 2;
      let value = '';
      while (j < text.length) {
        if (text[j] === '\\') {
          value += text[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (text[j] === '"') break;
        value += text[j];
        j++;
      }
      strings.push({ start, end: j + 1, value });
      blank(start, j + 1);
      i = j + 1;
      continue;
    }
    // `'` is a char literal OR a lifetime. `'a` followed by a non-quote is a
    // lifetime; treating it as an unterminated char literal would swallow the
    // file to the next `'` and blind the gate to everything between.
    if (c === "'") {
      const isLifetime = /^'[A-Za-z_][A-Za-z0-9_]*(?!')/.test(text.slice(i, i + 24));
      if (!isLifetime) {
        let j = i + 1;
        while (j < text.length) {
          if (text[j] === '\\') {
            j += 2;
            continue;
          }
          if (text[j] === "'" || text[j] === '\n') break;
          j++;
        }
        blank(i, j + 1);
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return { masked: masked.join(''), strings, comments };
}

/**
 * Match the delimiter opened at `open` in the masked plane.
 *
 * @param {string} masked
 * @param {number} open
 * @returns {number} index of the matching close, or -1
 */
function matchDelim(masked, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const close = pairs[masked[open]];
  if (!close) return -1;
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    if (masked[k] === masked[open]) depth++;
    else if (masked[k] === close) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * Ranges of `#[cfg(test)]`-attributed blocks, in masked-plane offsets.
 *
 * @param {string} masked
 * @returns {Array<[number, number]>}
 */
function cfgTestRanges(masked) {
  /** @type {Array<[number, number]>} */
  const ranges = [];
  const re = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const brace = masked.indexOf('{', m.index);
    if (brace === -1) continue;
    // Only treat the attribute as opening a block if nothing but a `mod`
    // header sits between it and the brace; otherwise `#[cfg(test)] use x;`
    // would claim the next unrelated block.
    const between = masked.slice(m.index + m[0].length, brace);
    if (/[;}]/.test(between)) continue;
    const end = matchDelim(masked, brace);
    if (end !== -1) ranges.push([m.index, end]);
  }
  return ranges;
}

/**
 * Does this path look like a test file by its location or name?
 *
 * @param {string} relPath posix-separated, repo-relative
 * @returns {boolean}
 */
export function isTestPath(relPath) {
  const base = relPath.split('/').pop() ?? relPath;
  return (
    relPath.split('/').includes('tests') ||
    base === 'tests.rs' ||
    base.endsWith('_tests.rs') ||
    base.endsWith('_test.rs')
  );
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isSourcePath(value) {
  // A path, not a sentence: reject anything with whitespace, which is how a
  // prose string ending in a filename would otherwise sneak in.
  if (value.length === 0 || /\s/.test(value)) return false;
  const lower = value.toLowerCase();
  return SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Start of the statement enclosing `offset`: scan the MASKED plane back to the
 * previous `;`, `{` or `}`. Masked, so a `;` inside a comment or a string does
 * not truncate the range -- that is the #3174 property, stated as code.
 *
 * @param {string} masked
 * @param {number} offset
 * @returns {number}
 */
function statementStart(masked, offset) {
  for (let k = offset - 1; k >= 0; k--) {
    if (masked[k] === ';' || masked[k] === '{' || masked[k] === '}') return k + 1;
  }
  return 0;
}

/**
 * Analyse one Rust file.
 *
 * @param {string} text
 * @param {string} relPath posix-separated, repo-relative
 * @returns {{ reads: number, hits: Array<{line:number,path:string,call:string}>, marked: Array<{line:number,reason:string,path:string}>, unusedMarkers: number[] }}
 */
export function analyze(text, relPath) {
  const { masked, strings, comments } = lex(text);
  const lineOf = makeLineIndex(text);
  const fileIsTest = isTestPath(relPath);
  /** @type {Array<[number, number]>} */
  const testRanges = fileIsTest ? [[0, text.length]] : cfgTestRanges(masked);
  const inTestScope = (offset) => testRanges.some(([a, b]) => offset >= a && offset <= b);

  // One-hop literal bindings: `const NAME: &str = "..."`, `static NAME ... = "..."`,
  // `let name = "..."`. The value is taken from the STRING TOKEN at that offset,
  // never from the raw text, so a commented-out binding cannot define a name.
  /** @type {Map<string, string>} */
  const bindings = new Map();
  // The regex stops AT the `=`. It must not run on past it: a string is
  // blanked to spaces in the masked plane, so a trailing `\s*` would swallow
  // the very literal being looked for and every named path would resolve to
  // nothing -- a silent, total loss of this hop, which is the fail-quiet shape
  // the floor exists to catch and which caught this while writing it.
  const bindRe =
    /\b(?:const|static)\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:[^=;]*=|\blet\s+(?:mut\s+)?([a-z_][A-Za-z0-9_]*)\s*(?::[^=;]*)?=/g;
  let bm;
  while ((bm = bindRe.exec(masked)) !== null) {
    const name = bm[1] ?? bm[2];
    if (!name) continue;
    const valueStart = bm.index + bm[0].length;
    // The FIRST literal after the `=`, and only if nothing but blank separates
    // them -- so `let a = helper("x")` binds nothing, which is right: the value
    // is a call result, not that path.
    const lit = strings.find((s) => s.start >= valueStart && masked.slice(valueStart, s.start).trim() === '');
    if (lit && strings.every((s) => s.start >= lit.start || s.end <= valueStart)) bindings.set(name, lit.value);
  }

  /** @type {Array<{line:number,path:string,call:string,start:number,end:number}>} */
  const sites = [];
  let reads = 0;

  // Macro reads: include_str!(..) / include_bytes!(..)
  const macroRe = new RegExp(`\\b(${READ_MACROS.join('|')})\\s*!\\s*[\\(\\[\\{]`, 'g');
  // Call reads: fs::read_to_string(..), std::fs::read(..), File::open(..).
  // A bare `read(`/`open(` is NOT matched -- `reader.read(&mut buf)` is not a
  // path read, and matching it would put the gate's precision at the mercy of
  // every I/O helper in the tree.
  const callRe = new RegExp(`\\b(?:fs|File)\\s*::\\s*(${READ_CALLS.join('|')})\\s*\\(`, 'g');

  for (const re of [macroRe, callRe]) {
    let m;
    while ((m = re.exec(masked)) !== null) {
      const open = m.index + m[0].length - 1;
      const close = matchDelim(masked, open);
      if (close === -1) continue;
      if (!inTestScope(m.index)) continue;
      reads++;
      const argStart = open + 1;
      const argEnd = close;
      // The path comes from a string literal in the argument -- or from a name
      // bound to one. A comment inside the argument is masked and cannot
      // supply either.
      const lit = strings.find((s) => s.start >= argStart && s.end <= argEnd + 1);
      let path = lit?.value;
      if (path === undefined) {
        const idents = masked.slice(argStart, argEnd).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
        for (const id of idents) {
          if (bindings.has(id)) {
            path = bindings.get(id);
            break;
          }
        }
      }
      if (path === undefined || !isSourcePath(path)) continue;
      sites.push({
        line: lineOf(m.index),
        path,
        call: m[1],
        start: statementStart(masked, m.index),
        end: close,
      });
    }
  }

  sites.sort((a, b) => a.line - b.line);

  // Markers, from COMMENT trivia only. A marker excuses a site when it sits
  // inside that site's enclosing-statement character range, or on the line
  // directly above where that statement starts, or trailing on the read's own
  // line.
  const markers = comments
    .filter((c) => c.text.includes(MARKER))
    .map((c) => ({
      start: c.start,
      line: c.line,
      reason: c.text
        .slice(c.text.indexOf(MARKER) + MARKER.length)
        .replace(/\*\/\s*$/, '')
        .trim(),
    }));

  /** @type {Array<{line:number,reason:string,path:string}>} */
  const marked = [];
  /** @type {Set<number>} */
  const usedMarkers = new Set();
  /** @type {Array<{line:number,path:string,call:string}>} */
  const hits = [];

  for (const site of sites) {
    const stmtLine = lineOf(site.start);
    const hit = markers.find(
      (mk) =>
        mk.reason.length > 0 &&
        ((mk.start >= site.start && mk.start <= site.end) || mk.line === stmtLine - 1 || mk.line === site.line)
    );
    if (hit) {
      usedMarkers.add(hit.start);
      marked.push({ line: site.line, reason: hit.reason, path: site.path });
    } else {
      hits.push({ line: site.line, path: site.path, call: site.call });
    }
  }

  const unusedMarkers = markers.filter((mk) => !usedMarkers.has(mk.start)).map((mk) => mk.line);

  return { reads, hits, marked, unusedMarkers };
}
