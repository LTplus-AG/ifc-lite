/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A string-aware STEP (ISO-10303-21) statement scanner — the substrate the
 * mutation generator edits models through.
 *
 * **Why a scanner and not a regex.** Every naive STEP rewriter in this repo's
 * history has been wrong the same way: a regex over the raw text goes blind
 * inside quoted strings. A single-quoted STEP string escapes a quote by
 * doubling it (`'it''s'`), so a regex that stops at the first `'` mis-tracks
 * the string state from there on, and every later match is measured against a
 * shifted view of the file. That defect has already cost this project twice —
 * once hiding 150 of 570 identifiers behind nine escapes, and once (the reason
 * this module exists) rewriting "every 22-character quoted token" as if it
 * were a GlobalId, which silently renamed `Qto_WallBaseQuantities` and
 * `SpaceTemperatureSummer` — both exactly 22 characters in the IFC base64
 * alphabet. A fixture that renames property sets makes the matcher look broken
 * when the fixture is.
 *
 * So: one scanner, used for everything. Attribute edits are ANCHORED to a
 * parsed argument position (`args[0]` of an `IfcRoot` line is the GlobalId),
 * never to what a value looks like.
 */

/** @typedef {{ id: number, type: string, args: string, raw: string }} Statement */

/**
 * Scan `text` for the next unquoted occurrence of any character in `stops`,
 * starting at `from`. Returns the index, or `text.length`.
 *
 * Quoting rules implemented: `'...'` with `''` as the literal quote. STEP also
 * allows `"..."` for binary literals, which contain no delimiters, and
 * `\X2\..\X0\` escapes, which live INSIDE a single-quoted string and so are
 * covered by the quote tracking.
 */
function scanTo(text, from, stops) {
  let index = from;
  while (index < text.length) {
    const ch = text[index];
    if (ch === "'") {
      index++;
      while (index < text.length) {
        if (text[index] === "'") {
          // A doubled quote is a literal quote, not the end of the string.
          if (text[index + 1] === "'") index += 2;
          else break;
        } else index++;
      }
      index++;
      continue;
    }
    if (stops.has(ch)) return index;
    index++;
  }
  return text.length;
}

/**
 * Split a STEP argument list at top-level commas — quote- and paren-aware.
 * `splitArgs("1,(2,3),'a,b'")` is `['1', '(2,3)', "'a,b'"]`.
 */
export function splitArgs(args) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  const stops = new Set(['(', ')', ',']);
  while (index < args.length) {
    index = scanTo(args, index, stops);
    if (index >= args.length) break;
    const ch = args[index];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(args.slice(start, index));
      start = index + 1;
    }
    index++;
  }
  parts.push(args.slice(start));
  return parts.map((part) => part.trim());
}

/**
 * Strip ISO-10303-21 comments (slash-star ... star-slash), string-aware.
 *
 * Needed because statements are split on `;` and a comment carries none, so a
 * comment sitting above an entity lands in the SAME chunk as it and the chunk
 * then parses as neither. Skipping such chunks was the old silent behaviour;
 * now that an unparsed chunk throws, the comment has to be removed properly
 * rather than tolerated. A comment opener inside a quoted string is ordinary text, which is
 * why this walks with the same quote tracking as everything else here.
 */
function stripComments(text) {
  let out = '';
  let index = 0;
  const openers = new Set(['/']);
  while (index < text.length) {
    const at = scanTo(text, index, openers);
    if (at >= text.length) return out + text.slice(index);
    if (text[at + 1] !== '*') {
      out += text.slice(index, at + 1);
      index = at + 1;
      continue;
    }
    const close = text.indexOf('*/', at + 2);
    if (close < 0) throw new Error('unterminated /* comment in DATA;');
    out += text.slice(index, at);
    index = close + 2;
  }
  return out;
}

/**
 * Parse a whole STEP file into a header prologue, an ordered statement list,
 * and an epilogue.
 *
 * Only `#id=TYPE(...)` statements inside `DATA;` are parsed; anything else in
 * the section (there should be nothing) is preserved verbatim as a trailing
 * comment-like chunk and re-emitted in place.
 */
export function parseStepFile(text) {
  const dataStart = text.indexOf('DATA;');
  if (dataStart < 0) throw new Error('not a STEP file: no DATA; section');
  const bodyStart = dataStart + 'DATA;'.length;
  const endMark = text.lastIndexOf('ENDSEC;');
  if (endMark < 0 || endMark < bodyStart) throw new Error('not a STEP file: no closing ENDSEC;');

  const header = text.slice(0, bodyStart);
  const body = stripComments(text.slice(bodyStart, endMark));
  const footer = text.slice(endMark);

  /** @type {Statement[]} */
  const statements = [];
  /** Express ids already defined — uniqueness is part of being well-formed. */
  const seen = new Set();
  const semicolons = new Set([';']);
  let index = 0;
  while (index < body.length) {
    const end = scanTo(body, index, semicolons);
    if (end >= body.length) break;
    const raw = body.slice(index, end).trim();
    index = end + 1;
    if (raw.length === 0) continue;
    // Everything else MUST parse. Skipping an unrecognised chunk was the
    // quiet failure: the statement would vanish from `file.statements`, the
    // serializer would not write it back, and the head revision would silently
    // lose content the answer key still describes — scoring a real number over
    // a model nobody described. A scanner that cannot read a line has to say
    // so, not drop it.
    const reject = (why) => {
      throw new Error(
        `unparsed chunk in DATA; (${why}): ${raw.slice(0, 120)}${raw.length > 120 ? '…' : ''}`,
      );
    };
    const eq = raw.indexOf('=');
    if (raw[0] !== '#' || eq < 0) reject('not a #id=TYPE(...) statement');
    // VALIDATE THE TEXT, THEN CONVERT — never the other way round.
    // `Number.parseInt` is a lexer, not a validator: it consumes what it can
    // and returns that, so `12A` -> 12, `+5` -> 5, `-3` -> -3, `0x10` -> 0 and
    // `1e3` -> 1. Checking `Number.isInteger` afterwards can never catch any of
    // them, because the coercion already discarded the evidence. Every one of
    // those was silently accepted, and a mis-read id is the worst kind here:
    // the statement lands under a DIFFERENT express id, the answer key points
    // at an element that is not there, and the run still scores a number.
    //
    // ISO 10303-21 spells an entity instance name `#` followed by one or more
    // digits. No sign, no radix prefix, no exponent — so `+5` and `-3` are not
    // out-of-range numbers, they are not numbers this grammar can express at
    // all, and they are rejected as SYNTAX.
    //
    // Whitespace needs care, and getting it wrong is not hypothetical: a rule
    // of `^\d+$` on this slice rejected FOUR valid files in the corpus, all
    // written as `#1 = IFCPROJECT(...)`. Whitespace BETWEEN tokens is legal and
    // must be tolerated; whitespace INSIDE the name token is not, so `# 5` and
    // `1 2` still fail. Hence trailing space allowed, leading space not.
    const idText = raw.slice(1, eq);
    if (!/^\d+\s*$/.test(idText)) reject(`express id '${idText}' is not a run of digits`);
    const id = Number(idText.trim());
    // ...whereas `0` and an id past the exact-integer ceiling ARE well-formed
    // digits and fail for a different reason: entity instance names are
    // positive, and beyond 2^53 two distinct ids would compare equal and quietly
    // collide in the permutation map. Reported separately so the message says
    // which of the two rules was broken.
    if (id < 1 || !Number.isSafeInteger(id)) {
      reject(`express id '${idText}' is out of range (ids start at 1 and must be exact)`);
    }
    // ...and a third, distinct failure: the id is well-formed and in range, but
    // already used. Malformed STEP, and the damage is the familiar one —
    // `indexModel` does `byId.set(statement.id, ...)`, so the second statement
    // silently REPLACES the first, and `permuteIds` keys its map by id, so both
    // are handed the same permuted id. The head revision would then contain a
    // collision the answer key does not describe, and the run would score it.
    if (seen.has(id)) reject(`duplicate express id #${id} (already defined in this file)`);
    seen.add(id);
    const open = raw.indexOf('(', eq);
    if (open < 0 || !raw.endsWith(')')) reject('no balanced argument list');
    statements.push({
      id,
      type: raw.slice(eq + 1, open).trim().toUpperCase(),
      args: raw.slice(open + 1, raw.length - 1),
      raw,
    });
  }

  return { header, statements, footer };
}

/** Serialize back to STEP text. One statement per line, `#id=TYPE(args);`. */
export function serializeStepFile(file) {
  const lines = file.statements.map((s) => `#${s.id}=${s.type}(${s.args});`);
  return `${file.header}\n${lines.join('\n')}\n${file.footer}`;
}

/** Every `#id` reference appearing in `args`, outside quoted strings. */
export function referencesIn(args) {
  const refs = [];
  const hash = new Set(['#']);
  let index = 0;
  while (index < args.length) {
    index = scanTo(args, index, hash);
    if (index >= args.length) break;
    let end = index + 1;
    while (end < args.length && args[end] >= '0' && args[end] <= '9') end++;
    if (end > index + 1) refs.push(Number.parseInt(args.slice(index + 1, end), 10));
    index = end;
  }
  return refs;
}

/**
 * Rewrite every `#id` reference in `args` through `map`. Ids absent from the
 * map are left alone — the caller decides whether that is an error.
 */
export function rewriteReferences(args, map) {
  let out = '';
  let index = 0;
  const hash = new Set(['#']);
  while (index < args.length) {
    const at = scanTo(args, index, hash);
    if (at >= args.length) {
      out += args.slice(index);
      return out;
    }
    let end = at + 1;
    while (end < args.length && args[end] >= '0' && args[end] <= '9') end++;
    out += args.slice(index, at);
    if (end > at + 1) {
      const id = Number.parseInt(args.slice(at + 1, end), 10);
      const mapped = map.get(id);
      out += `#${mapped === undefined ? id : mapped}`;
    } else {
      out += '#';
    }
    index = end;
  }
  return out;
}

/**
 * Replace argument `position` of `statement` with `value`, by parsed position.
 *
 * This is the anchored write the module header argues for: the caller says
 * "attribute 0 of this `IfcRoot`", never "the token that looks like a GlobalId".
 */
export function setArg(statement, position, value) {
  const parts = splitArgs(statement.args);
  if (position >= parts.length) {
    throw new Error(`#${statement.id}=${statement.type} has no attribute ${position}`);
  }
  parts[position] = value;
  return { ...statement, args: parts.join(',') };
}

/** A STEP-quoted string literal, with embedded quotes doubled. */
export function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Decode a STEP string literal (the inverse of {@link quote}); `$` → null. */
export function unquote(literal) {
  const text = literal.trim();
  if (text === '$' || text === '*') return null;
  if (text[0] !== "'" || text[text.length - 1] !== "'") return text;
  return text.slice(1, -1).replaceAll("''", "'");
}

/**
 * Format a number the way an IFC exporter does: no exponent for ordinary
 * magnitudes, and always a decimal point (`2.` is a REAL, `2` is an INTEGER,
 * and the two are different types to a schema-aware reader).
 */
export function real(value) {
  if (!Number.isFinite(value)) throw new Error(`not a finite REAL: ${value}`);
  // Fixed notation, never exponential: `String(1e-7)` is `1e-7`, whose
  // lowercase `e` is not what a STEP REAL looks like, and the parsers that do
  // accept it are doing us a favour. Nine decimals is far below the 1 mm grid
  // the geometry hash quantizes to.
  // The trailing-zero strip always leaves the decimal point in place, so `2`
  // never comes out as an INTEGER token.
  return value.toFixed(9).replace(/0+$/, '');
}
