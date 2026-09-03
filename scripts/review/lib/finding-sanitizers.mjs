/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE SANITISERS (module-size budget, #3795 split out of validate-findings.mjs).
 * Everything model-or-PR-controlled that can reach a posted comment body goes
 * through `sanitizeBody`/`sanitizeLabel`/`sanitizePath` before it does. See
 * `sanitizeBody`'s own doc comment below for the five-step order and why it is
 * load-bearing rather than cosmetic.
 */

import { createHash } from 'node:crypto';

/** GitHub renders long comments fine; a reviewer reading twenty of them does not. */
export const MAX_BODY_CHARS = 1500;
const TRUNCATION_NOTE = '\n\n[truncated by validate-findings]';

/** A class label is a short tag, not a place to smuggle a paragraph. */
const MAX_CLASS_CHARS = 60;

/**
 * THE TOKEN THAT MUST NOT SURVIVE INTO A POSTED BODY.
 *
 * Matched case-insensitively even though `check-review-posted.mjs`'s MARKER_RE is
 * case-sensitive: defanging more than the gate matches is free, and the reverse
 * mistake is a hole. The replacement swaps the SECOND ASCII hyphen for U+2011
 * NON-BREAKING HYPHEN, which reads identically to a human and cannot match a
 * pattern that requires `-`. A zero-width space would work equally well and be
 * invisible; a visible-but-inert token is preferred so a reader looking at a
 * posted comment can SEE that something was defanged rather than wonder why the
 * gate ignored it.
 */
const MARKER_TOKEN_RE = /ifc-lite-review/gi;
/**
 * A REPLACER, not a fixed string, and that is the correction. The pattern is
 * case-INSENSITIVE while the replacement was a lowercase literal, so defanging
 * REWROTE the text it was defanging: `docs/IFC-Lite-Review-Lane.md` came out as
 * `docs/ifc-lite‑review-Lane.md`, a name that exists nowhere. That is the same
 * class as the 60-char `class` cap this file already records for rewriting real
 * paths into names that exist nowhere, arriving by a different door -- and it
 * lands on an advisory list whose whole job is naming files a human then reads.
 *
 * Swaps the SECOND ASCII hyphen of whatever was matched for U+2011 and touches
 * nothing else, so case survives.
 */
const defangToken = (match) => `${match.slice(0, 8)}\u2011${match.slice(9)}`;

/** Whole HTML comments, non-greedy, including multi-line ones. */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * A dangling `<!--` left after the pass above (an UNCLOSED comment). It cannot
 * carry a marker on its own -- the gate's pattern needs the closing `-->` -- but
 * it can swallow whatever the poster appends after it when GitHub renders the
 * comment, including the real marker. Neutralised rather than deleted so the text
 * a human wrote is still legible.
 */
const DANGLING_COMMENT_OPEN_RE = /<!--/g;

/**
 * THE SECURITY BOUNDARY. Everything the model controls that can reach a posted
 * comment body goes through here.
 *
 * Order is deliberate and each step depends on the one before it:
 *
 *   1. Whole HTML comments are REMOVED. They can carry a forged marker, and they
 *      are invisible in the rendered comment, so anything hiding in one is hiding
 *      on purpose.
 *   2. Any remaining `<!--` -- an unclosed comment -- is broken, because it would
 *      otherwise swallow the real marker the poster appends after this body.
 *   3. The literal token `ifc-lite-review` is broken EVERYWHERE, not only inside
 *      comments.
 *
 *      WHAT WAS ACTUALLY MEASURED, because the obvious claim here is wrong.
 *      Mutation-testing this file showed that against the gate's CURRENT
 *      MARKER_RE, steps 1 and 2 are already sufficient on their own: that pattern
 *      requires a literal `<!--`, and after those two steps no `<!--` survives in
 *      the output at all. So the three steps are mutually redundant there, and it
 *      would be false to call this one "the" defence.
 *
 *      It earns its place on the two cases the others do not cover. First, the
 *      token appears in ORDINARY TEXT that is not in a comment -- this lane's own
 *      source carries it (MARKER_RE in check-review-posted.mjs, and this file), so
 *      a model reviewing that diff quotes it and a reviewer writing about it types
 *      it. Second, it is the only step that still holds if the gate's pattern is
 *      ever loosened to match the token outside an HTML comment, which is a change
 *      a future editor could make in check-review-posted.mjs without ever reading
 *      this file.
 *   4. `@` before a word character gets a zero-width space, so a body cannot
 *      summon a person or a team into a thread. (An email address in a body picks
 *      up the same treatment. That is a cosmetic cost on a rare input, taken
 *      knowingly rather than adding a cleverer pattern with a hole in it.)
 *   5. The length cap runs LAST, so the final string is genuinely within the cap:
 *      steps 1-4 change the length in both directions, and capping before them
 *      would let defanging push the result back over. Truncation can only DELETE
 *      trailing text, so it cannot construct a marker out of what remains.
 *
 * @param {unknown} text
 */
export function sanitizeBody(text) {
  let out = defangDangerous(text);
  if (out.length > MAX_BODY_CHARS) {
    out = out.slice(0, MAX_BODY_CHARS - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
  }
  return out;
}

/**
 * THE FOUR DEFANGING STEPS, in one place. `sanitizeBody` and `defangInline` each
 * carried a verbatim copy of the chain, so the numbered contract on
 * `sanitizeBody` described one of them and was true of the other only by
 * inspection -- two copies held together by prose. Steps 1-4 of that list ARE
 * this function; each caller owns only what it adds afterwards.
 *
 * @param {unknown} text
 */
function defangDangerous(text) {
  return String(text ?? '')
    .replace(HTML_COMMENT_RE, '')
    .replace(DANGLING_COMMENT_OPEN_RE, '<!‑-')
    .replace(MARKER_TOKEN_RE, defangToken)
    .replace(/@(?=[A-Za-z0-9])/g, '@​');
}

/**
 * The defanging every model-or-PR-controlled short string gets before a poster
 * may render it, plus the whitespace collapse a one-line field needs. Length
 * policy is NOT here -- it belongs to the caller, because a `class` label and a
 * file path have opposite needs (a label is a tag to cap hard; a path is an
 * identity to keep whole).
 */
function defangInline(text) {
  return defangDangerous(text).replace(/\s+/g, ' ').trim();
}

/**
 * A short label, held to a tighter budget than a body. Same defanging: `class` is
 * model-controlled and a poster that renders it into the comment would carry a
 * marker just as well as `body` would.
 *
 * @param {unknown} text
 */
export function sanitizeLabel(text) {
  return defangInline(text).slice(0, MAX_CLASS_CHARS);
}

/**
 * A file path budget. Borrowing `class`'s 60-char cap here truncated
 * `.../property/property-table.tsx` to a name that exists nowhere, and let two
 * sibling files render as the SAME string -- 1,251 of 6,633 tracked paths
 * exceed 60 chars. The longest tracked path is 188 bytes, so at 500 the cap is
 * unreachable for any real path and exists only against a hostile one padding
 * the posted summary.
 */
const MAX_PATH_CHARS = 500;

/**
 * A path a poster will render: defanged like a label, but kept WHOLE -- its
 * entire job is naming a real file the reviewer never read. If a hostile path
 * does exceed the cap, the truncation says so and stays unambiguous: the tail
 * carries the cut length and a digest of the full sanitised string, so
 * TRUNCATION cannot collapse two paths the way the 60-char slice made
 * `property-table.tsx` and `property-header.tsx` collapse into one.
 *
 * That is the whole guarantee, and it is narrower than "distinct paths always
 * render distinctly". DEFANGING is lossy and runs BEFORE the digest, so paths
 * differing only in what defanging removes still collide -- measured, all legal
 * git paths: `dir/a<!--x-->b.ts` vs `dir/ab.ts`; two spaces vs one; a tab vs a
 * space; a leading space vs none; and `ifc-lite-review.ts` vs its U+2011
 * non-breaking-hyphen lookalike -- IN ANY CASE now, not only in lowercase. The
 * replacement used to be a fixed lowercase string, which spared the uppercase
 * pair by rewriting its case; that was a worse bug than the collision it
 * avoided, so `defangToken` preserves the match and the pair collides like every
 * other. Sub-cap paths get no digest at all, so nothing disambiguates them. A
 * reader can therefore still see `omitted=2` above two identical-looking
 * entries.
 *
 * Accepted rather than fixed: defanging is load-bearing (it is what stops a
 * path forging a marker) and it must stay lossy to do that job. The cost is
 * cosmetic -- a duplicate-looking line in an advisory list.
 *
 * Digesting the RAW path instead would in fact disambiguate these, and safely:
 * a sha256 hex digest is `[0-9a-f]` only, so it cannot reproduce `<!--`, the
 * marker token or an @-mention. An earlier version of this comment claimed
 * otherwise and was simply wrong. The real cost is that it would hang a digest
 * suffix on EVERY row to disambiguate a case nobody has hit, which is a poor
 * trade for an advisory list.
 *
 * @param {unknown} text
 */
export function sanitizePath(text) {
  const out = defangInline(text);
  if (out.length <= MAX_PATH_CHARS) return out;
  const digest = createHash('sha256').update(out).digest('hex').slice(0, 12);
  return `${out.slice(0, MAX_PATH_CHARS)} [truncated: ${out.length} chars, sha256 ${digest}]`;
}
