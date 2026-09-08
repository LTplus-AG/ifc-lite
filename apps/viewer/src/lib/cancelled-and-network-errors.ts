/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two families that mean the work never finished for a reason outside the
 * model: someone cancelled it, or the transport dropped it. The kinds
 * themselves (`cancelled`, `network_unavailable`) are declared with the rest of
 * the taxonomy in ./load-errors.ts, which calls these in its documented order.
 *
 * They live together because they are one design problem, not two. Both are in
 * `BENIGN_ERROR_KINDS` (./analytics-scrub.ts), so a match downgrades the event
 * to `warning`; `network_unavailable` is additionally DELETED outright on a
 * client the browser reported offline. Matching is therefore how an actionable
 * failure of ours stops being triaged, or stops existing — which is exactly
 * what a substring test caused (#2410) and why every pattern below is anchored
 * to the whole message, `STRINGIFIED_ERROR_PREFIX` and all. The one asymmetry
 * between them (a cancellation report names its subject and carries authored
 * detail after the token; a transport failure IS the browser's whole string) is
 * spelled out on `CANCELLED_REPORT`, and only reads as a decision with the
 * other pattern in view.
 *
 * Split out of ./load-errors.ts on size (#2459), not on behaviour: these are
 * the same patterns, with the same anchors, called from the same place.
 */

/**
 * A cross-realm throwable reaches the analytics path as `String(err)` — i.e.
 * `"TypeError: Load failed"`, not `"Load failed"`. Structural, so the anchored
 * matchers below tolerate it; BOUNDED, so it cannot stand in for an arbitrary
 * leading sentence of ours that happens to end in "…Error:".
 *
 * `{0,32}`, not `{1,32}`: the commonest constructor is `Error` itself, whose
 * stringification is the bare `Error: Load failed`, and requiring a letter in
 * front excluded exactly that (Codex review, #2431). What does the real work is
 * `[A-Za-z]` admitting no space and no colon — a leading clause of ours can
 * never be swallowed however the count is written.
 */
const STRINGIFIED_ERROR_PREFIX = '(?:[A-Za-z]{0,32}Error:\\s*)?';

/**
 * The user (or a superseding load) cancelled the operation.
 *
 * ANCHORED, because `cancelled` is in `BENIGN_ERROR_KINDS` (./analytics-scrub.ts):
 * matching it downgrades the event to `warning` and fingerprints it into the
 * cancellation issue, taking an actionable failure off the error-level list as
 * effectively as deleting it. The old `/\bcancel(?:led|ed)?\b/` fired on the word
 * ANYWHERE — and, both suffixes optional, on a bare "cancel" — so `Upload failed:
 * driver shim logged cancelled while retrying` read benign (#2410).
 *
 * Shaped differently from the whole-message anchor `isNetworkUnavailableError`
 * uses, because the wordings have a different author: the transport strings
 * come from `fetch()` and ARE the entire message, whereas cancellations are
 * mostly ours and carry authored detail after the token (`Sync cancelled:
 * <model> was removed while its update was downloading.`, `Clash run cancelled
 * before meshing.`). So what is pinned is the SUBJECT — a cancellation report
 * names what was cancelled in its opening words; a failure that merely mentions
 * one reaches the token past a clause of its own. Two arms, because the bare
 * token has no subject to name and so gets no trailing latitude at all
 * (otherwise `cancelled and our upload pipeline then wrote 0 bytes` walks
 * through). The residual, stated plainly: `Upload cancelled and the pipeline
 * wrote 0 bytes` is still read as a cancellation report, because it is one.
 */
const CANCELLED_REPORT = new RegExp(
  `^\\s*${STRINGIFIED_ERROR_PREFIX}(?:`
  + 'cancell?ed\\.?\\s*$'
  // `[^\s:]+` so the subject cannot be reached across a `:` — that separator is
  // what makes "Upload failed: …" a sentence about the upload, not a cancellation.
  + '|(?:[^\\s:]+\\s+){1,2}cancell?ed\\b'
  + ')',
  'i',
);

/**
 * The browsers' own abort wordings — unlike ours these ARE the whole message,
 * so both ends are pinned. `.name === 'AbortError'` already claims the live
 * DOMException in {@link classifyLoadError}; this covers the analytics path,
 * where all we ever have is the stringified value.
 */
const ABORTED_MESSAGE = new RegExp(
  `^\\s*${STRINGIFIED_ERROR_PREFIX}(?:`
  + 'the operation was aborted'          // Gecko
  + '|the user aborted a request'        // Chromium
  + '|fetch is aborted'                  // WebKit
  + '|signal is aborted without reason'  // AbortController with no reason
  + ')\\.?\\s*$',
  'i',
);

export function isCancelledError(message: string): boolean {
  // `AbortError` is the stringified NAME — an identity, not prose — so it is
  // anchored to the start rather than matched as a substring anywhere.
  return CANCELLED_REPORT.test(message)
    || /^\s*AbortError\b/.test(message)
    || ABORTED_MESSAGE.test(message);
}

/**
 * A bare transport failure: the request never completed and the browser gave us
 * nothing but its house phrasing. These strings originate inside `fetch()`
 * rather than in our frames, so they arrive with an EMPTY stack — exactly how
 * #1903 reached error tracking as an unattributable `TypeError: Load failed`.
 * Checked LAST, so a failure that named itself (the engine binary, the file, a
 * worker) keeps its own, more actionable kind.
 *
 * ANCHORED AT BOTH ENDS, and that is load-bearing rather than tidiness: this is
 * the most dangerous label in the file. `analytics-scrub.ts` downgrades it to
 * `warning` via `BENIGN_ERROR_KINDS` AND deletes the event outright when the
 * browser also reported `navigator.onLine === false`, so the old substring test
 * meant any failure of ours quoting a transport phrase (`Upload failed: driver
 * shim logged Failed to fetch while retrying`) was silenced, and on an offline
 * client destroyed with no record (#2410). The anchor is exactly the premise
 * stated above — these strings come FROM `fetch()`, so anything wrapping one is
 * by construction ours. A wrapped transport failure now falls to `unknown`:
 * loud, own grouping, the safe direction for a droppable kind.
 *
 * This subsumes what used to be an explicit module-import exclusion: Chromium's
 * `Failed to fetch dynamically imported module: …/assets/Foo-<hash>.js` is our
 * deploy rotating an asset under a still-open tab, not a dropped connection, and
 * it names the module, so it is no longer the whole wording. The guard that said
 * so is gone rather than left as an unreachable branch — `load-errors.test.ts`
 * keeps the regression test as the live gate on this anchor.
 */
const BARE_TRANSPORT_FAILURE = new RegExp(
  `^\\s*${STRINGIFIED_ERROR_PREFIX}(?:`
  // WebKit/Safari, Chromium, Gecko — the generic "fetch rejected" strings.
  + 'load failed'
  + '|failed to fetch'
  // Gecko's full wording is `NetworkError when attempting to fetch resource.`;
  // the noun is optional only because the old matcher keyed on the fragment.
  + '|networkerror when attempting to fetch(?:\\s+resource)?'
  // Darwin's CFNetwork wordings, surfaced verbatim by Safari/WebKit when the
  // connection drops, the device is offline, or DNS cannot resolve the host.
  + '|the network connection was lost'
  + '|the internet connection appears to be offline'
  + '|a server with the specified hostname could not be found'
  + ')\\.?\\s*$',
  'i',
);

export function isNetworkUnavailableError(message: string): boolean {
  return BARE_TRANSPORT_FAILURE.test(message);
}
