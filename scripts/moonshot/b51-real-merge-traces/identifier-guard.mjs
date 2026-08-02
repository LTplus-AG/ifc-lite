#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.1 identifier guard: nothing user-attributable reaches a committed
 * artifact.
 *
 * WHY THIS FILE IS WRITTEN FIRST. B5.1's inputs are collaboration room logs.
 * A room log is not a measurement, it is a recording of what people typed:
 * user ids, element names, GUIDs, wall-clock timestamps, the room id (which
 * in this deployment's own guide is a slash-separated project and model name,
 * i.e. a file path). Measurements over that corpus are publishable; the corpus
 * is not.
 *
 * NOTHING FORBIDDEN IS WRITTEN IN THIS FILE. Not the tokens the proof plants,
 * not an example identifier, not a sample room id. Net 1 accounts a string for
 * by finding it in a declared set of source files and this file is one of
 * them, so a token quoted here would be a token the guard stops rejecting.
 * That is not a stylistic rule: the first revision quoted three plants in
 * these comments and three proof cases silently stopped being caught by net 1.
 * The plants live in guard-plants.mjs, which is deliberately outside the
 * corpus.
 * So the guard exists before the first artifact is written and every artifact
 * this bet emits goes through it.
 *
 * THE LESSON FROM B5.2, STATED SO IT IS NOT REPEATED. B5.2's guard was blind
 * for a whole bet because it scanned STEP strings with a regex that loses
 * quote parity at the first `''` escape: a single doubled quote inside one
 * string desynchronised the scanner and every identifier after it in the file
 * became invisible. The defect was not the regex, it was the SHAPE of the
 * defence -- a denylist that has to recognise the bad thing, running over a
 * format it has to parse correctly to see anything at all. One parse bug and
 * the guard silently passes everything.
 *
 * SO THIS GUARD IS AN ALLOWLIST, AND IT NEVER PARSES THE CORPUS. Two
 * independent nets, in this order:
 *
 *   NET 1 (primary, allowlist). Every STRING LEAF and every OBJECT KEY of the
 *   candidate artifact must match one of a small closed set of safe shapes
 *   (SAFE_SHAPES). A string that is not recognisably safe FAILS -- the guard
 *   does not have to know what an identifier looks like, only what a
 *   measurement looks like. A novel identifier form nobody anticipated fails
 *   by default rather than passing by default. This is the property B5.2's
 *   guard did not have.
 *
 *   NET 2 (independent, denylist). Every string the guard is given as
 *   forbidden material -- extracted from the actual trace corpus by the
 *   caller, never stored here -- is searched for as a raw substring in the
 *   artifact's serialized bytes, case-insensitively, with no parsing of any
 *   kind. Substring search cannot lose quote parity because it has no notion
 *   of quotes. Net 2 exists to catch the case where net 1's allowlist is
 *   accidentally widened; net 1 exists to catch what net 2 was never told
 *   about. Neither is trusted alone.
 *
 * The guard NEVER writes a forbidden string anywhere -- not into its own
 * findings, not into an error message, not into an artifact. A finding names
 * the JSON path and a SHA-256 prefix of the offending token, which is enough
 * to locate it in a local run and useless to a reader of the committed file.
 */

import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Net 1: the allowlist                                                  */
/* ------------------------------------------------------------------ */

/**
 * Net 1 has two halves and a string must satisfy one of them.
 *
 * HALF A -- STRUCTURAL SHAPES. Forms that are measurements or self-describing
 * bookkeeping and cannot carry authored content: numbers, day-precision dates,
 * hex digests this bet computed, semver, dotted JSON paths, in-repo source
 * paths. Note what is NOT here: there is no general "looks like an identifier"
 * shape and no general prose shape. An earlier revision of this file had both,
 * and the guard's own planted-identifier proof caught it: a demo session's
 * user id passed the identifier shape, a second-precision timestamp passed the
 * prose shape, and an authored element name passed BOTH nets and would have
 * been written to a committed artifact. That is the same defect
 * as B5.2's, arrived at from a different direction: a shape rule cannot tell a
 * measurement from a name, because names are shaped like words.
 *
 * HALF B -- PROVENANCE. Any other string must appear in a COMMITTED SOURCE
 * FILE this guard was told about. The reasoning is that echoing text which is
 * already published in the repository discloses nothing that was not already
 * public, while text from a room log is by construction absent from every
 * source file. So the question the guard asks is not "does this look
 * dangerous" but "can this bet account for where this string came from",
 * which is a question a novel identifier form fails automatically.
 *
 * WHY CONTAINMENT AND NOT PARSING. Half B is a raw substring test over the
 * concatenated source text -- no tokenizer, no string-literal extraction, no
 * quote tracking. B5.2's guard lost quote parity at the first `''` escape and
 * went blind for a whole bet. The failure mode here is the mirror image and is
 * harmless: if the source text is read wrongly, FEWER strings are accounted
 * for and the guard reports MORE findings. It cannot fail open.
 *
 * The word-level fallback exists because source composes prose across
 * concatenations and line breaks, so a whole sentence is often not a verbatim
 * substring of the file that built it. It is gated on `PROSE_CHARS`: every
 * character must be a letter, a digit, a space or ordinary sentence
 * punctuation, so a path, an email, a snake_case identifier or a compressed
 * GUID can never reach the fallback whatever words it contains.
 */
const SAFE_SHAPES = [
  ['empty', /^$/],
  // Numbers written as strings, including exponent and percent forms.
  ['number', /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?%?$/],
  // ISO dates at DAY precision only. Second-precision timestamps are exactly
  // the field a session recording carries, so they are not on this list.
  ['iso-day', /^\d{4}-\d{2}-\d{2}$/],
  // A hex digest this bet computed itself.
  ['hex-digest', /^[0-9a-f]{8,64}$/],
  // Semver.
  ['semver', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/],
  // Dotted JSON paths this bet emits for its own artifact fields.
  ['json-path', /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+|\[\d+\])*$/, 128],
  // In-repo source references. Restricted to paths starting at a repository
  // directory, so it cannot smuggle an absolute path or a home directory.
  ['repo-path', /^(?:packages|scripts|rust|docs|apps|tests|examples)\/[A-Za-z0-9./-]+$/, 160],
  // One or two characters cannot be an identifier.
  ['tiny', /^.{1,2}$/],
];

/** Characters a string may contain and still be eligible for the word-level
 *  provenance fallback. Excludes every character an identifier, a path, an
 *  email or a compressed GUID needs. */
const PROSE_CHARS = /^[A-Za-z0-9 ,.;:()<>+%='"?!-]+$/;

/** Set by {@link setSourceCorpus}. Empty until then, which means half B
 *  accounts for nothing and the guard is at its strictest. */
let SOURCE_TEXT = '';
let SOURCE_WORDS = new Set();
let SOURCE_FILE_COUNT = 0;

/**
 * Declare the committed source files half B may account for a string against.
 * Pass paths; unreadable ones are skipped, which only makes the guard
 * stricter.
 */
export function setSourceCorpus(readFile, files) {
  const parts = [];
  let n = 0;
  for (const f of files) {
    const text = readFile(f);
    if (typeof text !== 'string') continue;
    parts.push(text);
    n += 1;
  }
  SOURCE_TEXT = parts.join('\n');
  SOURCE_WORDS = new Set(
    SOURCE_TEXT.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0).map((w) => w.toLowerCase()),
  );
  SOURCE_FILE_COUNT = n;
  return { sourceFiles: n, sourceChars: SOURCE_TEXT.length, sourceWords: SOURCE_WORDS.size };
}

export function sourceCorpusSize() {
  return { sourceFiles: SOURCE_FILE_COUNT, sourceWords: SOURCE_WORDS.size };
}

/** The first rule that accounts for `s`, or null. */
function classify(s) {
  for (const [name, re, max] of SAFE_SHAPES) {
    if (max !== undefined && s.length > max) continue;
    if (re.test(s)) return name;
  }
  if (SOURCE_TEXT.length === 0) return null;
  // Half B, whole string first.
  if (SOURCE_TEXT.includes(s)) return 'source-verbatim';
  // Half B, word level. Three gates, and all three were forced by the guard's
  // own planted-identifier proof rather than chosen:
  //   - PROSE_CHARS, so a path, an email or a compressed GUID never reaches
  //     the fallback whatever words it happens to contain;
  //   - a SPACE must be present, so the fallback applies to sentences and
  //     never to a single token. Without this gate a hyphenated session id was
  //     accounted for, because its alphabetic half appears in ordinary prose
  //     and its numeric half is pure digits. A lone token has to be verbatim
  //     in the corpus or match a shape;
  //   - every non-numeric word must appear in the corpus.
  if (!PROSE_CHARS.test(s)) return null;
  if (!/\s/.test(s)) return null;
  const words = s.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0);
  if (words.length === 0) return null;
  for (const w of words) {
    // Pure digits are measurements wherever they appear.
    if (/^\d+$/.test(w)) continue;
    if (!SOURCE_WORDS.has(w.toLowerCase())) return null;
  }
  return 'source-words';
}

/* ------------------------------------------------------------------ */
/* Net 2: the denylist                                                   */
/* ------------------------------------------------------------------ */

/**
 * Structural forms that are forbidden REGARDLESS of the allowlist, checked by
 * raw substring/regex scan over the serialized artifact. These are the shapes
 * an identifier takes even when nobody handed the guard a corpus: they are a
 * safety net under net 1, not a substitute for it.
 *
 * Every pattern here is applied to the FLAT serialized text, so none of them
 * can be desynchronised by an escape sequence the way a quote-tracking
 * scanner can.
 */
const FORBIDDEN_FORMS = [
  ['uuid', /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/],
  // An IFC GlobalId is 22 characters of a base64 variant. Bare length is not
  // enough to key on: a 22-character camelCase field name is a false positive
  // and this guard must be usable, so the form additionally requires the
  // entropy signature a compressed GUID always has and an identifier chosen by
  // a programmer almost never does -- a `$` or `_`, or three or more digits,
  // together with both letter cases. Net 1 is the primary defence and rejects
  // unrecognised strings whatever they look like; this pattern is here to
  // catch a GlobalId that reaches a field net 1 was widened to allow.
  ['ifc-globalid', /\b(?=[0-9A-Za-z_$]{22}\b)(?=[0-9A-Za-z_$]*[a-z])(?=[0-9A-Za-z_$]*[A-Z])(?:[0-9A-Za-z_$]*[_$][0-9A-Za-z_$]*|[0-9A-Za-z]*\d[0-9A-Za-z]*\d[0-9A-Za-z]*\d[0-9A-Za-z]*)\b/],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['absolute-path', /(?:^|["\s:,])(?:\/(?:Users|home|var|tmp|data|mnt)\/|[A-Za-z]:\\\\)/],
  ['home-tilde', /~\/[A-Za-z0-9._-]/],
  ['url', /\bhttps?:\/\//],
  ['ws-url', /\bwss?:\/\//],
  ['model-filename', /[A-Za-z0-9._-]+\.(?:ifc|ifcx|ifczip|ifcZIP|rvt|dwg|nwd|step|stp)\b/i],
  ['second-precision-timestamp', /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/],
  ['demo-user-id', /\buser-\d{3,}\b/],
  ['at-mention', /(?:^|[\s"([])@[A-Za-z0-9._-]{2,}/],
];

/* ------------------------------------------------------------------ */
/* Findings                                                              */
/* ------------------------------------------------------------------ */

/** 12 hex chars of SHA-256. Enough to locate a token in a local re-run,
 *  useless as a disclosure. Forbidden material is NEVER echoed. */
export function tokenDigest(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 12);
}

function finding(net, kind, where, token) {
  return { net, kind, where, tokenSha256Prefix: tokenDigest(token), tokenLength: String(token).length };
}

/* ------------------------------------------------------------------ */
/* The guard                                                             */
/* ------------------------------------------------------------------ */

/**
 * Scan a candidate artifact.
 *
 * @param {unknown} value        the artifact, as a JS value (pre-serialization)
 * @param {object}  [opts]
 * @param {string[]} [opts.forbidden]  raw strings from the trace corpus that
 *        must not appear anywhere. The caller extracts these; the guard never
 *        retains them past the call and never writes them out.
 * @returns {{ ok: boolean, findings: object[], stringLeaves: number,
 *             forbiddenTermsChecked: number, forbiddenDigests: string[] }}
 */
export function scanArtifact(value, opts = {}) {
  const forbidden = (opts.forbidden ?? []).filter((s) => typeof s === 'string' && s.length >= 4);
  const findings = [];
  let stringLeaves = 0;

  // ---- Net 1: allowlist over every string leaf and object key ----
  const visit = (node, path) => {
    if (typeof node === 'string') {
      stringLeaves += 1;
      if (classify(node) === null) findings.push(finding(1, 'string-not-on-allowlist', path, node));
      return;
    }
    if (node === null || typeof node === 'number' || typeof node === 'boolean') return;
    if (Array.isArray(node)) {
      node.forEach((c, i) => visit(c, `${path}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (classify(k) === null) findings.push(finding(1, 'key-not-on-allowlist', path || '(root)', k));
        visit(v, path ? `${path}.${k}` : k);
      }
      return;
    }
    // undefined / function / symbol: JSON.stringify would drop it. Flag it so
    // an artifact never silently loses a field.
    findings.push(finding(1, 'unserializable-value', path, String(typeof node)));
  };
  visit(value, '');

  // ---- Net 2: raw scan over the serialized bytes, no parsing ----
  const flat = JSON.stringify(value) ?? '';
  const lower = flat.toLowerCase();
  for (const term of forbidden) {
    if (lower.includes(term.toLowerCase())) {
      findings.push(finding(2, 'corpus-term-present', '(serialized)', term));
    }
  }
  for (const [kind, re] of FORBIDDEN_FORMS) {
    const m = re.exec(flat);
    if (m) findings.push(finding(2, `forbidden-form:${kind}`, '(serialized)', m[0]));
  }

  return {
    ok: findings.length === 0,
    findings,
    stringLeaves,
    forbiddenTermsChecked: forbidden.length,
    // Publishable proof of WHICH terms were checked, without publishing them.
    forbiddenDigests: forbidden.map(tokenDigest).sort(),
  };
}

/**
 * Positive-assertion wrapper. Throws unless the artifact is clean. Used on
 * every write path in run.mjs so an artifact cannot be emitted by a code path
 * that forgot to check -- the verdict comes from this call succeeding, never
 * from the absence of an exception somewhere else.
 */
export function assertClean(label, value, opts = {}) {
  const r = scanArtifact(value, opts);
  if (!r.ok) {
    const summary = r.findings
      .map((f) => `net${f.net} ${f.kind} at ${f.where} (sha256:${f.tokenSha256Prefix}, len ${f.tokenLength})`)
      .join('; ');
    throw new Error(`identifier-guard REFUSED to emit ${label}: ${r.findings.length} finding(s): ${summary}`);
  }
  return r;
}
