/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Detection half of scripts/check-source-text-assertions.mjs (#2434), split out
 * so it can be unit-tested against hand-written sources instead of only against
 * whatever the repo happens to contain today.
 *
 * THE RULE, as the gate's docblock has always stated it: a test that reads
 * `Thing.tsx` and then asserts on THAT STRING. The original detector checked
 * the two halves independently — "this file reads a file somewhere" AND "this
 * file applies a text predicate somewhere" — and never checked they were
 * connected. That is a proxy, and it broke exactly the way proxies break:
 * `packages/data/scripts/generate-ifc-schema.test.ts` reads upstream fixtures
 * only to copy them into a temp dir, runs the real generator as a child
 * process, and asserts solely on `r.stdout` / `r.stderr` — pure behaviour — yet
 * was reported as a source-text assertion.
 *
 * The obvious repair, excluding `.stdout`/`.stderr` receivers, was considered
 * and REJECTED: a file may legitimately assert on file text in one place and
 * wrap a subprocess result in another, and an exclusion keyed on the second
 * would blind the gate to the first with nothing recording the decision. That
 * is the same class of mistake — a proxy that correlates with the property you
 * want, until it does not.
 *
 * So this module pairs them. A predicate counts only when it is applied to a
 * value that a file read produced. Taint starts at `readFileSync`/`readFile`
 * and propagates through the shapes that actually occur here:
 *
 *   const source = readFileSync(p, 'utf8')          // direct binding
 *   const src = readSource('Thing.tsx')             // read behind a helper
 *   const real = Object.fromEntries(… readFileSync) // read inside a callback
 *   let s = readFileSync(p); s = s.replace(a, b)    // reassignment
 *   mutate(real.platform, …) → function mutate(source, …)  // through a parameter
 *
 * Propagation is deliberately over-eager (one flat name set, no scoping, every
 * call site of a function taints that function's parameters). Over-tainting
 * makes the gate stricter, which is the safe direction for a ratchet;
 * under-tainting would silently drop coverage, which is the direction that
 * turns a gate into decoration.
 *
 * WHAT COUNTS AS THE PREDICATE'S SUBJECT is both the receiver chain and the
 * arguments, because both spellings occur: `source.includes(x)` and
 * `assert.match(source, /x/)` and `new RegExp(x).exec(source)` are the same
 * assertion. `expect(source).toContain(x)` needs no special case — `expect(…)`
 * is part of the receiver chain, so `source` is found by reading it.
 *
 * THE ANCHOR-GUARD ESCAPE HATCH. `assert.ok(source.includes(from), 'mutation
 * anchor not found')` before a `source.replace(from, to)` is, by this rule, a
 * source-text assertion — and by value the opposite of one: it exists so a
 * mutation that silently fails to apply is caught instead of testing nothing.
 * It is NOT structurally carved out. "A predicate immediately preceding a
 * mutation" is another proxy, unreviewable and silent, and this file exists
 * because of what proxies cost. Instead the site marks itself:
 *
 *     // @source-text-assertion-ok mutation anchor guard, not a subject assertion
 *     assert.ok(source.includes(from), `anchor not found: ${from}`);
 *
 * The marker suppresses the predicate on its own line, or anywhere from the
 * first line of the enclosing assertion upward by one -- a wrapped
 * `assert.ok(\n  source.includes(x),\n)` puts the predicate below the line the
 * marker sits above, and the remedy this gate prints assumes that works
 * — same ratchet discipline as the allowlist. The decision stays a grep-able
 * line in the diff, which a structural carve-out never would be.
 */

/** Reads a file from disk at all — the taint source. */
export const READS_A_FILE = /\b(readFileSync|readFile)\s*\(/;

/**
 * Names a SOURCE file as a literal. Fixture formats (.ifc, .json, .csv, …) are
 * deliberately absent: reading a fixture and asserting on it is a normal test.
 */
export const SOURCE_LITERAL = /['"`][^'"`\n]*\.(ts|tsx|mts|rs|css|scss)['"`]/;

/**
 * Text predicates. `test` and `exec` are here because this repo already writes
 * them that way — `/re/.test(source)` in export-ui-parity.test.tsx and
 * `new RegExp(…).exec(src)` in prepass-class-spans.test.ts, the latter a form
 * the guard was blind to until #2434. Under the pairing rule they no longer
 * need the receiver-name allowlist the flat version used (`.test(source|src|
 * text|…)`): the receiver of `/re/.test(x)` is a regex and never tainted, so
 * what decides the case is whether `x` came from a file — which is the actual
 * question.
 */
const PREDICATE_METHOD =
  /\.\s*(includes|indexOf|match|search|startsWith|endsWith|exec|test|toContain|toMatch)\s*\(/g;

/** `@source-text-assertion-ok <reason>` — see the docblock. */
const MARKER = /@source-text-assertion-ok\b[ \t]*(\S[^\n]*)?/;

const OPENERS = '([{';
const CLOSERS = ')]}';

/** Characters after which a `/` begins a REGEX rather than a division. */
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '>', '\n',
]);

/** Keywords after which a `/` begins a regex (`return /re/.test(x)`). */
const REGEX_PRECEDING_WORDS = /(?:^|[^A-Za-z0-9_$])(return|typeof|instanceof|case|in|of|delete|void|new|do|else|yield|await)$/;

/**
 * TRUE when the `)` at `end` closes an `if (…)` / `for (…)` / `while (…)` style
 * HEADER rather than a parenthesised expression.
 *
 * `)` is not a regex-preceder, because `(a + b) / c` is division. But an
 * unbraced control body can be a regex expression statement:
 *
 *     if (ok) /["']/.test(value);
 *
 * There the `/` starts a literal, and reading it as division let the `"` open a
 * string that never closed, blanking the rest of the file -- the gate then
 * reported a clean file. Distinguishing the two needs the token before the
 * MATCHING `(`, so this walks back to it.
 */
function closesAControlHeader(back, end) {
  if (back[end] !== ')') return false;
  let depth = 0;
  let j = end;
  for (; j >= 0; j--) {
    if (back[j] === ')') depth++;
    else if (back[j] === '(') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (j < 0) return false;
  let w = j - 1;
  while (w >= 0 && (back[w] === ' ' || back[w] === '\t')) w--;
  const span = back.slice(Math.max(0, w - 8), w + 1).join('');
  return /(?:^|[^A-Za-z0-9_$])(if|for|while|switch|catch|with)$/.test(span);
}

/**
 * If `src[start]` opens a regex literal, the index just PAST it (flags
 * included); otherwise `start`, meaning "this `/` is division".
 *
 * The division-vs-regex question is decided by the previous significant
 * character. That is the standard heuristic and it is APPROXIMATE, not sound;
 * measured against the TypeScript parser over the scanned corpus it disagrees
 * on a handful of lines, none of which currently changes a verdict.
 * A `[...]` class is tracked, since `/` inside one is literal, and an
 * unterminated literal (no closing `/` before the line ends) is treated as
 * division rather than swallowing the rest of the file.
 */
function regexLiteralEnd(src, start, back) {
  // The BACKWARD scan reads `back`, which is the output-so-far with comments
  // already blanked, while the forward scan reads raw `src`. They must differ:
  // looking back over raw text puts the `/` of a preceding `*/` in front of
  // the literal, so `const a = 1; /* c */ /["']/.test(z)` reads as DIVISION,
  // the `"` opens a string that never closes, and the rest of the file is
  // blanked -- a silent fail-open. Comments blank to spaces, which this skips.
  // `back` is REQUIRED rather than defaulting to `src`: a default would let a
  // future two-argument call silently restore that bug, and absence should not
  // read as success.
  let k = start - 1;
  while (k >= 0 && (back[k] === ' ' || back[k] === '\t')) k--;
  const prev = k >= 0 ? back[k] : '';
  // `<` is deliberately NOT a preceder. `</Foo>` puts one directly before the
  // slash, and these files are `.tsx`: accepting it made every JSX closing tag
  // open a "regex", which on a line with a second `/` swallowed the opening
  // quote and desynced the scanner for the rest of the FILE. That is the exact
  // whole-file blanking this function exists to prevent, reintroduced by the
  // fix for it. `>` has to stay, because it carries `=>`.
  //
  // `a++ / b` and `a-- / b` are division, so a doubled `+`/`-` is excluded even
  // though a single one is a legitimate preceder (`a + /re/.test(b)`).
  const doubled = (prev === '+' || prev === '-') && back[k - 1] === prev;
  const wordSpan = back.slice(Math.max(0, k - 12), k + 1).join('');
  const isRegex =
    !doubled
    && (prev === ''
      || REGEX_PRECEDERS.has(prev)
      || REGEX_PRECEDING_WORDS.test(wordSpan)
      || closesAControlHeader(back, k));
  if (!isRegex) return start;

  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') return start; // unterminated: it was division after all
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      while (i < src.length && /[a-z]/.test(src[i])) i++; // flags
      return i;
    }
    i++;
  }
  return start;
}

/**
 * ONE pass over `src` producing three length- and line-preserving views.
 *
 * Comments and strings cannot be lexed separately, because each can contain
 * the other. Doing comments first (the old `stripComments`) truncated
 * `const doc = 'see // the docs';` to an unterminated quote, and the string
 * lexer then blanked the REST OF THE FILE, so every assertion after it went
 * invisible and the gate reported nothing to see. Doing strings first fails
 * the mirror case, a quote inside a comment. So both happen here, together.
 *
 *   text      comments blanked, string CONTENT intact -- for the pattern tests
 *             that must still see a filename literal
 *   blanked   comments AND string content blanked -- the code skeleton every
 *             index-based read walks
 *   comments  ONLY comment interiors kept -- markers are read from this, so a
 *             `@source-text-assertion-ok` sitting inside a STRING can no
 *             longer excuse a real finding
 *
 * Blanking to spaces rather than deleting keeps every index and line number
 * equal to the original, which every caller here relies on.
 */
function lexViews(src) {
  const text = src.split('');
  const blanked = src.split('');
  const comments = src.split('');
  for (let k = 0; k < src.length; k++) if (src[k] !== '\n') comments[k] = ' ';

  const blankBoth = (k) => {
    if (src[k] === '\n') return;
    text[k] = ' ';
    blanked[k] = ' ';
  };
  const keepComment = (k) => {
    blankBoth(k);
    comments[k] = src[k];
  };

  const stack = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const top = stack[stack.length - 1];

    if (top && top.kind === 'str') {
      if (c === '\\') {
        if (src[i] !== '\n') blanked[i] = ' ';
        if (src[i + 1] !== undefined && src[i + 1] !== '\n') blanked[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === top.quote) {
        stack.pop();
        i++;
        continue;
      }
      if (top.quote === '`' && c === '$' && src[i + 1] === '{') {
        stack.push({ kind: 'interp', depth: 0 });
        i += 2;
        continue;
      }
      if (c !== '\n') blanked[i] = ' ';
      i++;
      continue;
    }

    // COMMENTS ARE TESTED BEFORE REGEX. `//` would otherwise be offered to
    // `regexLiteralEnd` as an empty literal and could swallow code up to the
    // next slash on the line.
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') keepComment(i++);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      keepComment(i++);
      keepComment(i++);
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) keepComment(i++);
      if (i < src.length) {
        keepComment(i++);
        keepComment(i++);
      }
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      stack.push({ kind: 'str', quote: c });
      i++;
      continue;
    }

    if (c === '/') {
      const end = regexLiteralEnd(src, i, blanked);
      if (end > i) {
        // Keep the OPENING `/` in the blanked view. Blanking a literal whole
        // makes the next `/` look back past it to whatever preceded the
        // literal: in `const n = /a/ / b; const s = 'q/w';` the division saw
        // `=`, called itself a regex, ran forward into the `'q/w'` string for
        // its "closing" slash, and blanked the rest of the file. A surviving
        // `/` is not a regex-preceder, so the division is read as division.
        for (let k = i + 1; k < end; k++) if (src[k] !== '\n') blanked[k] = ' ';
        i = end;
        continue;
      }
    }

    if (top && top.kind === 'interp') {
      if (OPENERS.includes(c)) top.depth++;
      else if (c === '}' && top.depth === 0) {
        stack.pop();
        i++;
        continue;
      } else if (CLOSERS.includes(c)) top.depth--;
    }
    i++;
  }
  return { text: text.join(''), blanked: blanked.join(''), comments: comments.join('') };
}

/**
 * Blank string and template-literal CONTENT, preserving length, newlines and
 * `${…}` interpolations. Length preservation is load-bearing: every index
 * computed on the blanked text is used against the original. One view of
 * {@link lexViews} rather than a second scanner.
 */
export function blankStrings(src) {
  return lexViews(src).blanked;
}

/**
 * Comments blanked, string content INTACT, line numbers and length preserved,
 * so a marker can be matched against the line of the predicate it excuses.
 * Load-bearing rather than tidy: three unrelated tests mention a `.ts` filename
 * in prose while reading a wasm binary or a JSON manifest.
 *
 * One view of {@link lexViews}. It used to be a pair of regexes that truncated
 * a line at `//` with no idea whether that `//` was inside a STRING, which is
 * what made the gate go silent from `const doc = 'see // the docs';` onward.
 */
export function stripComments(source) {
  return lexViews(source).text;
}

/** Identifiers in `expr` at value position: property names after `.` excluded. */
function valueIdentifiers(expr) {
  const names = new Set();
  // NOT `\b` before the name. `$` is legal in a JS identifier and is not a word
  // character, so `\b` never matches in front of a LEADING `$`: `$read(x)`
  // yielded `read`, which matches nothing in the tainted set, and `a.$b` yielded
  // `b` with the dot marker lost, so a property was read as a value. Both are
  // silent. An explicit "not preceded by an identifier character" assertion
  // handles `$`, and the trailing `\b` is unnecessary because the class is
  // greedy.
  const re = /(\.?)\s*(?<![\w$])([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(expr)) !== null) {
    if (m[1] === '.') continue;
    names.add(m[2]);
  }
  return names;
}

/** End index (exclusive) of the statement whose right-hand side starts at `start`. */
function statementEnd(blanked, start) {
  let depth = 0;
  for (let i = start; i < blanked.length; i++) {
    const c = blanked[i];
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (c === ';' && depth === 0) return i;
    else if (c === '\n' && depth === 0) {
      // Approximate ASI: a line that ends mid-expression, or whose successor
      // continues one, is not a statement boundary.
      const before = blanked.slice(start, i).trimEnd().slice(-1);
      if (before && '=+-*/%,.?:&|<>({[!~^'.includes(before)) continue;
      const next = /\S/.exec(blanked.slice(i));
      if (next && '.?:+-*/%&|,)]}'.includes(next[0])) continue;
      return i;
    }
  }
  return blanked.length;
}

/** Index OF the `)` matching the `(` at `open`; `blanked.length` if unclosed. */
function matchParen(blanked, open) {
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    if (OPENERS.includes(blanked[i])) depth++;
    else if (CLOSERS.includes(blanked[i])) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return blanked.length;
}

/**
 * Start index of the receiver chain ending at `dot` — walking back over
 * balanced `(…)`/`[…]` groups and dotted identifiers, so the receiver of
 * `expect(readFileSync(p)).toContain(x)` is the whole `expect(readFileSync(p))`.
 */
function receiverStart(blanked, dot) {
  let i = dot - 1;
  for (;;) {
    while (i >= 0 && /\s/.test(blanked[i])) i--;
    if (i < 0) return 0;
    const c = blanked[i];
    if (c === ')' || c === ']') {
      let depth = 0;
      for (; i >= 0; i--) {
        if (CLOSERS.includes(blanked[i])) depth++;
        else if (OPENERS.includes(blanked[i])) {
          depth--;
          if (depth === 0) break;
        }
      }
      i--;
      continue;
    }
    if (/[\w$]/.test(c)) {
      while (i >= 0 && /[\w$]/.test(blanked[i])) i--;
      while (i >= 0 && /\s/.test(blanked[i])) i--;
      if (i >= 0 && blanked[i] === '.') {
        i--;
        continue;
      }
      return i + 1;
    }
    return i + 1;
  }
}

/** Every name that can hold, or return, bytes that came off the disk. */
function computeTainted(blanked) {
  const tainted = new Set(['readFileSync', 'readFile']);
  // TRUE when `expr` yields bytes off the disk -- either because it PERFORMS a
  // read, or because it refers to a name already known to hold one. The two
  // arms are why this is not called `refersToTainted`: the first answers a
  // question about the expression itself, not about the `tainted` set.
  const carriesFileBytes = (expr) => {
    // A READ is a read however it is spelled. `valueIdentifiers` drops any name
    // preceded by `.`, so `fs.readFileSync(p)` yielded `{fs, p}` and taint never
    // started -- `READS_A_FILE` still matched, so the file was ANALYSED rather
    // than skipped, the taint set stayed empty, and the answer was
    // `flagged: false`. Namespaced reads are the ordinary spelling in this repo
    // and `await fsp.readFile(...)` failed the same way, so the gate was blind
    // to both. Seeding from the same pattern that decides whether to analyse at
    // all stops the two from disagreeing.
    if (READS_A_FILE.test(expr)) return true;
    for (const name of valueIdentifiers(expr)) if (tainted.has(name)) return true;
    return false;
  };

  // Declarations and assignments: `const|let|var x = RHS`, `{a, b} = RHS`, `x = RHS`.
  const bindings = [];
  const bindRe = /(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*|\{[^{}\n]*\}|\[[^[\]\n]*\])\s*=(?!=|>)/g;
  let m;
  while ((m = bindRe.exec(blanked)) !== null) {
    const rhsStart = m.index + m[0].length;
    bindings.push({
      names: [...valueIdentifiers(m[1])],
      rhs: blanked.slice(rhsStart, statementEnd(blanked, rhsStart)),
    });
  }

  // Functions, so a read behind a helper and a read passed as an argument both
  // propagate: `function f(p) { … }`, `const f = (p) => …`, `const f = function (p) {…}`.
  const fns = [];
  const fnRe =
    /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*\*?\s*[A-Za-z_$\w$]*\s*)?\(/g;
  // A single arrow parameter needs no parentheses, and requiring the `(` above
  // meant `const check = src => src.includes(x)` registered no function at all:
  // the call site never tainted `src`, and the equivalent `(src) =>` spelling
  // was caught while this one went silent.
  const bareArrowRe =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = fnRe.exec(blanked)) !== null) {
    const open = blanked.lastIndexOf('(', fnRe.lastIndex);
    const close = matchParen(blanked, open);
    const params = [...valueIdentifiers(blanked.slice(open + 1, close))];
    // Body: the block or concise arrow body that follows the parameter list.
    // The gap may hold a TS return-type annotation (`): string {`), so it is
    // matched as "anything that is not a statement" rather than whitespace —
    // requiring whitespace is what made `function readSource(p): string` opaque.
    const after = blanked.slice(close + 1);
    const braceOffset = after.indexOf('{');
    const arrowOffset = after.indexOf('=>');
    let body = '';
    let concise = false;
    if (
      arrowOffset !== -1 &&
      (braceOffset === -1 || arrowOffset < braceOffset) &&
      /^[^;{}]*$/.test(after.slice(0, arrowOffset))
    ) {
      const rest = after.slice(arrowOffset + 2);
      const lead = rest.match(/^\s*/)[0].length;
      const bodyStart = close + 1 + arrowOffset + 2 + (rest[lead] === '{' ? lead : 0);
      body =
        rest[lead] === '{'
          ? blanked.slice(bodyStart, matchParen(blanked, bodyStart) + 1)
          : blanked.slice(bodyStart, statementEnd(blanked, bodyStart));
      concise = rest[lead] !== '{';
    } else if (braceOffset !== -1 && /^[^;{}]*$/.test(after.slice(0, braceOffset))) {
      const bodyStart = close + 1 + braceOffset;
      body = blanked.slice(bodyStart, matchParen(blanked, bodyStart) + 1);
    }
    fns.push({ name: m[1] || m[2], params, body, concise });
  }
  while ((m = bareArrowRe.exec(blanked)) !== null) {
    const arrow = blanked.indexOf('=>', m.index) + 2;
    const braced = /^\s*\{/.test(blanked.slice(arrow));
    const bodyStart = braced ? blanked.indexOf('{', arrow) : arrow;
    fns.push({
      name: m[1],
      params: [m[2]],
      body: braced
        ? blanked.slice(bodyStart, matchParen(blanked, bodyStart) + 1)
        : blanked.slice(arrow, statementEnd(blanked, arrow)),
      concise: !braced,
    });
  }

  // Each pass that changes anything adds at least one name, and names come from
  // the file, so `bindings.length + fns.length + 2` is an upper bound the loop
  // cannot need to exceed -- it is a runaway guard, not a policy. The old fixed
  // 8 WAS reachable: a chain declared in reverse order resolves one link per
  // pass, so eight links exhausted it and `analyze` reported a clean file.
  const maxPasses = bindings.length + fns.length + 2;
  for (let pass = 0; pass < maxPasses; pass++) {
    const before = tainted.size;
    for (const b of bindings) {
      if (carriesFileBytes(b.rhs)) for (const n of b.names) tainted.add(n);
    }
    for (const fn of fns) {
      // A helper that returns file bytes taints its own name, so both
      // `readSource(f).includes(x)` and `const s = readSource(f)` are seen.
      if (fn.name && !tainted.has(fn.name)) {
        const returned = fn.concise ? [fn.body] : fn.body.match(/\breturn\b[^;\n]*/g) || [];
        if (returned.some(carriesFileBytes)) tainted.add(fn.name);
      }
      // A tainted argument taints the parameter it lands in.
      if (!fn.name || fn.params.length === 0) continue;
      // `$` is legal in a JS identifier AND is a regex anchor, so `$read` built
      // a pattern that could never match and the helper's parameter taint was
      // lost with no signal. Escape before interpolating.
      const callRe = new RegExp(`\\b${fn.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'g');
      let call;
      while ((call = callRe.exec(blanked)) !== null) {
        const open = callRe.lastIndex - 1;
        const args = splitArgs(blanked.slice(open + 1, matchParen(blanked, open)));
        args.forEach((arg, idx) => {
          if (idx < fn.params.length && carriesFileBytes(arg)) tainted.add(fn.params[idx]);
        });
      }
    }
    // An ITERATION CALLBACK receives the bytes one ELEMENT at a time, so no
    // tainted NAME ever appears inside it. `source.split('\n').some((line) =>
    // line.includes(needle))` reads the file and asserts on its text, and the
    // detector saw a predicate applied to `line`, a parameter it believed was
    // clean. Same for `.filter`, `.map`, `.every`, `.forEach`, `.find`. Taint
    // flows from the RECEIVER to the callback's parameters.
    for (const m of blanked.matchAll(/\.\s*[A-Za-z_$][\w$]*\s*\(/g)) {
      const dot = m.index;
      const open = m.index + m[0].length - 1;
      if (!carriesFileBytes(blanked.slice(receiverStart(blanked, dot), dot))) continue;
      const args = blanked.slice(open + 1, matchParen(blanked, open));
      for (const cb of args.matchAll(/(\([^()]*\)|\b[A-Za-z_$][\w$]*)\s*=>/g))
        for (const q of valueIdentifiers(cb[1])) tainted.add(q);
      // An anonymous `function (line) { … }` callback is the same flow with a
      // different spelling, and matching only arrows left it undetected.
      for (const cb of args.matchAll(/\bfunction\s*[A-Za-z_$][\w$]*?\s*\(([^()]*)\)|\bfunction\s*\(([^()]*)\)/g))
        for (const q of valueIdentifiers(cb[1] ?? cb[2] ?? '')) tainted.add(q);
      // A HOISTED callback is passed by name, so its parameters are declared
      // somewhere else entirely: `.some(hit)` with `const hit = (line) => …`.
      for (const arg of splitArgs(args)) {
        const named = fns.find((f) => f.name && f.name === arg.trim());
        if (named) for (const q of named.params) tainted.add(q);
      }
    }
    // `for (const line of source.split('\n'))` binds the ELEMENT. `bindRe`
    // requires an `=`, so this shape bound nothing and the loop body read as
    // clean.
    for (const m of blanked.matchAll(
      /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+/g,
    )) {
      // The iterable runs to the `)` MATCHING the for-header's `(`, not to the
      // first one. A `[^)]*` capture stopped inside `source.trim().split('\n')`
      // at the `)` of `trim(`, so the `.split(` below was never seen and the
      // loop body read as clean -- the silent direction.
      const header = blanked.indexOf('(', m.index);
      // No emptiness guard here on purpose: an empty or inverted range slices
      // to '', which fails the `.split(` test below and adds no taint -- the
      // same outcome, without a line that reads as a guard while guarding
      // nothing. Verified on `for (const x of ) {}` and an unclosed header.
      const iterEnd = matchParen(blanked, header);
      // Deliberately narrow to a SPLIT of tainted text. Tainting on
      // `carriesFileBytes` alone also catches `for (const file of files)`
      // where the elements are PATHS, not contents -- measured as 4 false hits
      // in toolbar-parity.test.ts, because a list of paths is tainted too.
      // Nothing lexical separates a tainted array of lines from a tainted
      // array of filenames, so this takes the shape it can prove and leaves
      // `for (const line of lines)` (split bound to a name first) uncovered
      // rather than paying for it in false flags on every path loop.
      const iter = blanked.slice(m.index + m[0].length, iterEnd).trim();
      if (/\.\s*split\s*\(/.test(iter) && carriesFileBytes(iter)) tainted.add(m[1]);
    }
    // FAIL CLOSED on flow this analysis cannot follow. When file bytes are
    // handed to a callee it cannot name — `mutators[key](real[key])`, or
    // anything returned by a call — the value lands in a parameter no lexical
    // rule can identify, and the honest answer is "undecidable", not "clean".
    // Undecidable resolves to tainting every function-expression parameter in
    // the file, so coverage degrades toward MORE flagging rather than less.
    // Named callees (`mutate(real.platform, …)`) and plain dotted ones
    // (`fs.writeFileSync(path, text)`) are followed or ignored precisely and do
    // not trigger this.
    for (const call of blanked.matchAll(/[)\]]\s*\(/g)) {
      const open = call.index + call[0].length - 1;
      if (!splitArgs(blanked.slice(open + 1, matchParen(blanked, open))).some(carriesFileBytes))
        continue;
      for (const m2 of blanked.matchAll(/(\([^()]*\)|\b[A-Za-z_$][\w$]*)\s*=>/g))
        for (const p of valueIdentifiers(m2[1])) tainted.add(p);
      for (const fn of fns) for (const p of fn.params) tainted.add(p);
      break;
    }
    if (tainted.size === before) break;
  }
  return tainted;
}

/** Split an argument list on top-level commas. */
function splitArgs(text) {
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  args.push(text.slice(start));
  return args;
}

/** A line is a continuation of the one below it when it ends mid-expression. */
const CONTINUES = /(?:[([,]|=>|&&|\|\||[-+*/%?:]|=)\s*$/;

/**
 * The line carrying the marker that excuses a predicate on `line`, or `null`.
 *
 * A marker sits immediately above the ASSERTION, and the assertion may be
 * wrapped over several lines, so the predicate is not always on the line the
 * marker is above. This walks up over continuation lines to the statement's
 * first line and allows the marker anywhere from just above that down to the
 * predicate itself.
 *
 * `codeLines` must be COMMENT-STRIPPED (`stripComments`), because `CONTINUES`
 * contains `*`, `/`, `:` and `-`, so `// Arrange:`, `// see https://x/`, a JSDoc
 * ` *` line and this repo's own `// ------` separators all read as continuations
 * of prose. A stale marker then reaches across them to excuse an unrelated
 * predicate AND is recorded as used, so the dead-marker check goes quiet too:
 * both halves of the gate wrong at once.
 *
 * `stripComments` is now string-aware (it is one view of the single lexing
 * pass), so a `//` inside a string no longer truncates the line: `name: '///'`,
 * `'https://x/y'` and `'see // docs'` all keep their trailing `;` and correctly
 * stop the walk, where the earlier per-line stripper got each of them wrong in
 * the fail-open direction. (Do not restate that as "no file's stripped view
 * differs in LENGTH from the original". That holds for ANY input, because this
 * pass blanks to spaces and never deletes, so it stays true with the
 * string-awareness removed. It measures the blanking, not the fix.)
 *
 * The 24-line bound is a POLICY cap on how far a marker may reach, not a
 * runaway guard -- the walk terminates on its own, because `codeLines[top - 2]`
 * yields `''` at the top of the file and `''` is not a continuation. The
 * previous bound of 8 was small enough that a legitimately long wrapped
 * assertion fell out the other side and hit the double failure above.
 */
function markerLineFor(markerLines, codeLines, line) {
  if (markerLines.has(line)) return line;
  let top = line;
  for (let n = 0; n < 24; n++) {
    const above = (codeLines[top - 2] ?? '').trim();
    if (!CONTINUES.test(above)) break;
    top -= 1;
  }
  for (let candidate = line - 1; candidate >= top - 1; candidate--) {
    if (markerLines.has(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {string} original Raw file text (comments intact — markers live there).
 * @returns {{ flagged: boolean, hits: Array<{line: number, text: string}>,
 *             marked: Array<{line: number, reason: string}>,
 *             unusedMarkers: number[] }}
 */
export function analyze(original) {
  const views = lexViews(original);
  const stripped = views.text;
  const strippedLines = stripped.split('\n');
  const empty = { flagged: false, hits: [], marked: [], unusedMarkers: [] };
  const rawLines = original.split('\n');
  const markerLines = new Map();
  // Markers are read from the COMMENT view, never the raw line. A raw-line
  // scan accepted `const doc = 'write @source-text-assertion-ok fake';` as a
  // genuine marker, so a STRING could excuse a real finding -- a silent
  // fail-open in the direction this gate exists to prevent.
  views.comments.split('\n').forEach((line, idx) => {
    const m = MARKER.exec(line);
    if (m) markerLines.set(idx + 1, (m[1] || '').trim());
  });

  if (!READS_A_FILE.test(stripped) || !SOURCE_LITERAL.test(stripped)) {
    return { ...empty, unusedMarkers: [...markerLines.keys()] };
  }

  // The SAME pass that produced `stripped`, not a second lex of it. The two
  // routes now agree (they did NOT before the `back` lookback landed, which is
  // what an earlier version of this comment recorded), so this is duplicated
  // work rather than a correctness trap -- but one pass is the point of
  // `lexViews`, and re-lexing its own output invites the ordering hazards it
  // exists to remove.
  const blanked = views.blanked;
  const tainted = computeTainted(blanked);

  const lineOf = (index) => blanked.slice(0, index).split('\n').length;
  const hits = [];
  const marked = [];
  const usedMarkers = new Set();

  PREDICATE_METHOD.lastIndex = 0;
  let m;
  while ((m = PREDICATE_METHOD.exec(blanked)) !== null) {
    const dot = m.index;
    const open = m.index + m[0].length - 1;
    const receiver = blanked.slice(receiverStart(blanked, dot), dot);
    const args = blanked.slice(open + 1, matchParen(blanked, open));
    const subject = `${receiver} ${args}`;
    let hit = false;
    for (const name of valueIdentifiers(subject)) {
      if (tainted.has(name)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    const line = lineOf(dot);
    // A marker excuses the predicate on its own line, or on any line from the
    // start of the enclosing statement to just above it.
    //
    // "The line above" alone was wrong for a WRAPPED assertion, which is the
    // prevailing style in the files this gate actually reports. Written exactly
    // as `check-source-text-assertions.mjs` prints the remedy:
    //
    //     // @source-text-assertion-ok anchor guard
    //     assert.ok(
    //       source.includes(anchor),
    //     );
    //
    // the predicate is on the THIRD line and the marker on the first, so the
    // marker excused nothing AND was then reported as unused: CI failed twice
    // and the printed fix did not work. A remedy an instrument prints has to be
    // one the instrument accepts.
    const markerLine = markerLineFor(markerLines, strippedLines, line);
    if (markerLine !== null && markerLines.get(markerLine)) {
      usedMarkers.add(markerLine);
      marked.push({ line, reason: markerLines.get(markerLine) });
      continue;
    }
    hits.push({ line, text: rawLines[line - 1]?.trim() ?? '' });
  }

  return {
    flagged: hits.length > 0,
    hits,
    marked,
    unusedMarkers: [...markerLines.keys()].filter((l) => !usedMarkers.has(l)),
  };
}
