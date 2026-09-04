/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * READING findings.json AND THE MARKER FORMAT (module-size budget, #3795
 * split out of post-review.mjs). `readFindingsDoc` parses the file once for
 * every reader below it; `readFindings`/`readOmitted` turn the parsed
 * document into what the poster actually sends; `fingerprint` is the dedupe
 * key; `marker` is the one place the `<!-- ifc-lite-review ... -->` string is
 * built, proved against the real gate by post-review.test.mjs.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PostReviewError } from './post-review-error.mjs';

/**
 * At most this many inline comments reach a human, and it is enforced HERE.
 *
 * It was enforced in the judge, which is the one step in the lane designed to be
 * skippable: the workflow's crash backstop does `cp findings.json judged.json`,
 * bypassing that module completely, and the validator's own ceiling is twelve.
 * So the cap held only when the optional filter succeeded, and the failure path
 * -- the one that runs when something has already gone wrong -- posted twelve.
 *
 * This module is the only one on the posting path that always runs.
 */
export const MAX_POSTED_FINDINGS = 5;

/**
 * The findings the model produced.
 *
 * BOTH plausible spellings are accepted -- a bare array, and `{ findings: [...] }`
 * -- and everything else REFUSES. The component writing this file is precisely
 * the unreliable one, so the failure that must not exist is a shape mismatch
 * read as "no findings": that would post a `verdict=clean` marker over a review
 * that found things, and nothing downstream can tell those two apart afterwards.
 *
 * @returns {{ path: string, line: number, body: string, title: string|null }[]}
 */

/**
 * READ AND PARSE findings.json ONCE, for every reader below.
 *
 * There were four independent `readFileSync` + `JSON.parse` calls on this one
 * path -- the findings, the omitted list, the judge's drop count and the cap's
 * -- so the poster read the same file four times per run and each reader carried
 * its own answer to "what if it is unreadable". Two of them fail soft with a
 * warning, one throws, and one threw a message about a race that could only
 * happen BECAUSE it re-read. Parsing here deletes the race rather than handling
 * it: every reader now sees the same bytes by construction, and the diagnosis
 * for an unreadable or malformed file lives in exactly one place.
 *
 * @returns {unknown} the parsed document, whatever shape it is; each reader
 *   below owns what it will accept.
 */
export function readFindingsDoc(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new PostReviewError(
        'NO_FINDINGS_FILE',
        `Findings file \`${path}\` is missing. A missing findings file is NOT an empty one: treating it ` +
          'as clean would post a clean marker over a review whose findings never left the runner. ' +
          'REMEDY: fix the reviewer step that was meant to write it.',
      );
    }
    throw new PostReviewError('NO_FINDINGS_FILE', `Cannot read \`${path}\`: ${err.code || err.message}.`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new PostReviewError('BAD_FINDINGS', `\`${path}\` is not valid JSON: ${err.message}`);
  }
}

export function readFindings(parsed, path) {
  const list = Array.isArray(parsed) ? parsed : parsed?.findings;
  if (!Array.isArray(list)) {
    throw new PostReviewError(
      'BAD_FINDINGS',
      `\`${path}\` must be a JSON array of findings, or an object with a \`findings\` array; found ` +
        `${parsed === null ? 'null' : typeof parsed}. Not defaulted to empty: an unrecognised shape read ` +
        'as "no findings" is the same lie as a review that never ran.',
    );
  }
  // The cap is applied AFTER validation and AFTER the judge, never before either.
  // Capping earlier discards candidates a later stage might have preferred to the
  // ones it kept -- the judge rejecting the first seven of twelve should leave the
  // remaining five, not nothing.
  const capped = list.length > MAX_POSTED_FINDINGS ? list.slice(0, MAX_POSTED_FINDINGS) : list;
  if (capped.length < list.length) {
    console.log(
      `CAPPED: ${list.length} findings reached the poster; posting the first ${MAX_POSTED_FINDINGS} ` +
        'in the order they were given.',
    );
  }
  return capped.map((f, i) => {
    const where = `finding ${i + 1} of ${capped.length} in \`${path}\``;
    if (f === null || typeof f !== 'object' || Array.isArray(f)) {
      throw new PostReviewError('BAD_FINDING', `${where} is not an object.`);
    }
    if (typeof f.path !== 'string' || f.path.trim() === '') {
      throw new PostReviewError('BAD_FINDING', `${where} has no \`path\`. GitHub would reject it with a 422.`);
    }
    // `indexLine` renders `f.path` raw onto the issue comment that also carries
    // the review marker, and check-review-posted runs `MARKER_RE.exec` over the
    // RAW body and takes the FIRST match. A PR author may legally name a file
    // `x<!-- ifc-lite-review sha=<40 hex> verdict=clean count=0 -->.ts`; that
    // forged marker then sorts ahead of the genuine one. Reproduced: the first
    // match reads `verdict=clean` while the real `verdict=findings` marker sits
    // in the same comment, so the gate returns STALE_REVIEW while the poster's
    // own `.includes(want)` read-back still says REVIEW_POSTED. Green poster,
    // red gate, and every re-run posts another poisoned summary.
    //
    // MATCHED ON `<!--` ALONE, deliberately. `MARKER_RE` and the `sawUnparseable`
    // probe both require a literal `<!--`, so the bare token forges nothing. An
    // earlier version of this guard also refused `ifc-lite-review`, which made
    // a legal filename like `docs/ifc-lite-review-lane.md` abort the poster
    // before it wrote any marker -- no marker means the gate reports NOT_POSTED
    // and tells you to re-run, and the re-run fails identically. That is the
    // very unclearable red this guard exists to prevent, re-created by the
    // guard. Narrow to the character sequence that can actually open a marker.
    if (f.path.includes('<!--')) {
      throw new PostReviewError(
        'BAD_FINDING',
        `${where} has a \`path\` containing an HTML comment opener. Rendered onto the summary it would ` +
          'let a PR-chosen filename forge a review marker ahead of the genuine one. REMEDY: rename the ' +
          'file, or drop this finding. NOT a sanitisation bug -- `path` must round-trip verbatim as the ' +
          'API `path=` parameter and as the dedupe fingerprint, so rewriting it here would misplace the ' +
          'comment instead.',
      );
    }
    if (!Number.isInteger(f.line) || f.line < 1) {
      throw new PostReviewError(
        'BAD_FINDING',
        `${where} has \`line\`=${JSON.stringify(f.line)}; it must be a positive integer line in this ` +
          "commit's diff. Refused here rather than sent, because a 422 mid-loop leaves half the findings " +
          'posted and the rest lost.',
      );
    }
    if (typeof f.body !== 'string' || f.body.trim() === '') {
      throw new PostReviewError('BAD_FINDING', `${where} has an empty \`body\`. An empty finding is not a finding.`);
    }
    // `class` is carried and RENDERED, not dropped. It was validated upstream and
    // then discarded here, so the one field a precision-by-class tally needs
    // never reached a durable surface -- and findings.json dies with the runner.
    // The tag is appended AFTER upstream sanitisation and deliberately cannot
    // match the review marker's grammar, so it can never be mistaken for one.
    const cls = typeof f.class === 'string' && f.class.trim() !== '' ? f.class.trim().slice(0, 60) : 'unclassified';
    return {
      path: f.path,
      line: f.line,
      // THE SIBLING IS RENDERED, because otherwise verifying it bought nothing a
      // human ever sees. The validator proves the twin exists at that line in the
      // pack the reviewer was shown, the judge is given it -- and the poster used
      // to drop it, so on the second-site family this whole pack exists to catch,
      // the twin's location died with the runner unless the model happened to
      // repeat it in prose. The comment in validate-findings claimed post-review
      // rendered it; it did not.
      body:
        `${f.body}` +
        // A sibling whose path could open a marker is DROPPED, not refused. The
        // sibling sentence is decoration on a finding that is otherwise fine, so
        // refusing the whole review over it would trade a cosmetic loss for the
        // unclearable red this guard exists to avoid. `f.path` cannot be dropped
        // the same way -- it IS the finding's anchor -- which is why that one
        // refuses above.
        (f.sibling?.path && !f.sibling.path.includes('<!--') && Number.isInteger(f.sibling.line)
          ? `\n\nThe same shape is at ${inlineCode(`${f.sibling.path}:${f.sibling.line}`)}, which this PR does not change.`
          : '') +
        `\n\n<!-- ifc-lite-finding v=1 class=${cls.replace(/[^a-z0-9-]/gi, '-')} -->`,
      // The class IS the title. They were a dead pair: `class` was validated
      // then dropped, while `title` was read by the summary index and never
      // written, so the index always fell back to the first line of the body.
      title: cls === 'unclassified' ? null : cls,
    };
  });
}

/**
 * What makes two findings "the same one" for dedupe. Path and line are in the
 * key as well as the body: two findings can legitimately share wording on
 * different lines, and a body-only key would silently drop the second.
 */
export function fingerprint(path, line, body) {
  return createHash('sha256').update(`${path}\u0000${line}\u0000${body}`).digest('hex');
}

/**
 * The files the review DID NOT read, dropped upstream to fit the model prompt
 * (#3679). Read from the same findings.json the findings come from, because
 * that file is the only artefact that crosses from the validator to this
 * poster.
 *
 * REFUSES rather than defaults on a malformed shape: a partial review whose
 * omission list is unreadable would post a marker byte-identical to a full
 * review's, which is the absence-reads-as-success shape this lane exists to
 * close. An ABSENT field is fine -- the bare-array findings shape and every
 * findings.json written before #3679 mean "nothing was omitted", and treating
 * that as an error would redden every legacy re-run.
 *
 * Each entry is also required to be already-defanged: validate-findings
 * sanitises these paths before writing them, and a raw `<!--` or marker token
 * here means the two files have drifted -- rendering it anyway would open the
 * marker-forgery channel the sanitiser closes.
 *
 * @returns {string[]}
 */
export function readOmitted(parsed, path) {
  const omitted = Array.isArray(parsed) ? undefined : parsed?.omitted;
  if (omitted === undefined) return [];
  if (!Array.isArray(omitted) || omitted.some((p) => typeof p !== 'string' || p.trim() === '')) {
    throw new PostReviewError(
      'BAD_FINDINGS',
      `\`omitted\` in \`${path}\` must be an array of non-empty strings when present. Defaulting to ` +
        '"nothing omitted" would post a full-review marker over a partial review. REMEDY: fix ' +
        'validate-findings, which writes this field.',
    );
  }
  for (const p of omitted) {
    if (/<!--|ifc-lite-review/i.test(p)) {
      throw new PostReviewError(
        'BAD_FINDINGS',
        `An \`omitted\` entry in \`${path}\` carries an HTML comment opener or the marker token, which ` +
          'validate-findings is required to defang before writing. Rendering it would let a PR-chosen ' +
          'file path forge a review marker through our own identity. REMEDY: fix the sanitisation in ' +
          'validate-findings.',
      );
    }
  }
  return omitted;
}

/**
 * THE MARKER'S VERDICT WHEN NOTHING REACHED THE PULL REQUEST (#3862).
 *
 * A standing count of zero is produced by two runs that are not the same review:
 *
 *   - the reviewer answered `clean`, and `checkClassPass` made it show a verdict
 *     on every defect class before that answer was accepted;
 *   - the reviewer answered `findings` -- exempt from the class pass on purpose
 *     -- and run-judge then dropped every one of them.
 *
 * The second never walked the list, so calling it `clean` certifies a diff
 * nothing walked. The flag the validator wrote is the only thing that separates
 * them by the time this file runs, and it is required to be EXACTLY `true`: a
 * findings.json that carries no flag says nothing about a class pass, and
 * reading silence as a pass is the defect family this lane is named after.
 *
 * A verdict is never upgraded here. `classPass: true` beside a document the
 * judge emptied cannot happen -- a `clean` verdict has no findings to empty --
 * and if it ever did, this would post `clean`, which is what the validator
 * already certified.
 *
 * @param {unknown} doc - the parsed findings.json / judged.json.
 * @param {number} standing - findings read back off the pull request and still
 *   unresolved (#3768); the same number the marker carries.
 * @returns {'clean'|'clean-by-judge'|'findings'}
 */
export function markerVerdict(doc, standing) {
  if (standing > 0) return 'findings';
  return (Array.isArray(doc) ? undefined : doc?.classPass) === true ? 'clean' : 'clean-by-judge';
}

/** The marker the gate parses. Built in exactly one place; proved against the real gate by the harness. */
export function marker(sha, verdict, count, omitted = 0) {
  // `omitted=` appears ONLY on a partial review: a full review's marker stays
  // byte-identical to what every earlier version of the gate parses.
  return `<!-- ifc-lite-review sha=${sha} verdict=${verdict} count=${count}${omitted > 0 ? ` omitted=${omitted}` : ''} -->`;
}

/**
 * A Markdown inline code span that survives backticks IN the text. A git path
 * may contain backticks, and `` `${p}` `` lets such a path close the span at
 * its own backtick -- spilling the tail into the comment as live Markdown
 * (#3688 review). CommonMark's remedy: fence with a run one longer than the
 * longest run in the content, padded with one space each side so an edge
 * backtick cannot fuse with the fence; the renderer strips that pad.
 *
 * Lives here (rather than in ./review-summary.mjs, which also uses it) because
 * `readFindings` above needs it for the sibling sentence, and review-summary.mjs
 * already imports `marker` from this file -- so this direction has no cycle.
 */
export function inlineCode(text) {
  const runs = String(text).match(/`+/g);
  if (runs === null) return `\`${text}\``;
  const fence = '`'.repeat(Math.max(...runs.map((r) => r.length)) + 1);
  return `${fence} ${text} ${fence}`;
}
