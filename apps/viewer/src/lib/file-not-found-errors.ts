/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `NotFoundError` half of the `file_unreadable` family (the kind is
 * declared, with the rest of the taxonomy, in ./load-errors.ts).
 *
 * TWO DOMException names map to `file_unreadable`, not one. `NotReadableError`
 * — the file still at its path but unreadable — stays in ./load-errors.ts,
 * because its matcher is a pattern and nothing more. `NotFoundError` is the
 * file whose bytes are GONE by read time: moved, renamed, deleted, or rewritten
 * in place by the authoring tool between `getFile()` and the read, which is
 * exactly what the Refresh flow (#1345) invites. Its two engine wordings carry
 * far more rationale than pattern, and each has a DIFFERENT safety argument, so
 * they live here rather than lengthening the classifier — the same split, for
 * the same reason, as ./webgl-unavailable.ts and
 * ./cancelled-and-network-errors.ts.
 *
 * The whole family lives here so the SET is visible in one read: a third engine
 * wording adds an arm to {@link isFileNotFoundMessage}, rather than a matcher
 * somewhere else that nobody thinks to group. Only that one predicate is
 * exported; the per-engine arms and the load-context set are private, because
 * the ORDER the buckets are tried in stays the classifier's business.
 *
 * WHY THIS MODULE CARRIES THE SEVERITY ARGUMENT. `file_unreadable` is in
 * `BENIGN_ERROR_KINDS` (./analytics-scrub.ts), so it is captured, kept and
 * fingerprinted — a spike is still a real signal about, say, a sync client
 * evicting files mid-load — but reported at `warning` rather than `error`: the
 * file the user picked moved, was renamed, deleted or evicted between the pick
 * and the read, nothing in the app failed, the toast already says to select the
 * file again, and no code change of ours can alter it.
 *
 * That downgrade is safe ONLY because of the context gate in
 * {@link isWebkitGenericNotFoundMessage} below. While the WebKit wording was
 * claimed unconditionally, a Safari React reconciler crash classified as
 * `file_unreadable` and the downgrade would have hidden a hard crash behind a
 * warning. Uncontextualised, that string classifies `unknown` and keeps its
 * `error` level. Loosen the gate and the severity rule stops being safe, so the
 * two have to be read together — which is why they sit in one file.
 */

/**
 * The `context` property a model-load capture site stamps on its exception.
 *
 * Only these two mean "this exception was thrown while reading and processing a
 * file the user picked" — `useIfcLoader`'s outer catch and its geometry-stream
 * catch. Every other context in the app (`ids_validation`, `clash_detection`,
 * `export_glb`, `device_lost`, …) is some other operation entirely, and an
 * exception with NO context at all is an uncaught one PostHog autocaptured,
 * which by definition nobody attributed to a load.
 *
 * It exists for exactly one arm: {@link isWebkitGenericNotFoundMessage}.
 * Nothing else here needs to know who was calling, and nothing else should
 * start to — a classifier that consults the caller for its ordinary buckets is
 * a classifier that gives two answers for one error.
 */
const LOAD_CONTEXTS: ReadonlySet<string> = new Set(['ifc_model_load', 'geometry_processing']);

/**
 * Whether a capture-site `context` marks a model-load failure. Deliberately
 * takes `unknown`: the analytics path reads it straight off an event's
 * properties, where it is whatever the capture site put there.
 */
function isLoadContext(context: unknown): boolean {
  return typeof context === 'string' && LOAD_CONTEXTS.has(context);
}

/**
 * Chromium's wording, and the one the field reports actually carry (#2546,
 * #2860, #3324, #3731: four separate PostHog issues over four weeks, every one
 * of them classified `unknown`, so the user was shown the raw DOM sentence and
 * each occurrence spawned its own GitHub issue).
 *
 * What is CONFIRMED is the wording and that it keeps arriving; the mechanism
 * behind it is read off Blink rather than reproduced here, and is recorded as
 * the inference it is: a blob read fails with `NotFoundError` once the backing
 * file no longer matches the snapshot taken when the `File` was handed out.
 * Either way the user guidance is identical to `NotReadableError`'s, which is
 * why both map to `file_unreadable`: the file the user picked is not there to
 * be read.
 *
 * ANCHORED on the whole message, never a substring test, and that is
 * load-bearing rather than stylistic: `NotFoundError` is also what
 * `removeChild` / `insertBefore` throw when a translation extension re-parents
 * a node React owns (the family `harden-dom-mutations.ts` exists to suppress —
 * #1229 / #1230 / #1232). A search for "could not be found" would sweep those
 * in and tell that user their file had moved, which is a lie. Matching by
 * `.name` alone would do the same, so the name is deliberately NOT used here.
 *
 * What makes anchoring SUFFICIENT here is a property of Blink, and it is worth
 * stating precisely because the obvious reading is wrong: this string does not
 * name files because Blink reserved it for file failures. It is Blink's generic
 * description for the `NotFoundError` NAME, handed to any throw that supplies
 * no message of its own. The safety comes from the other side — Blink's DOM
 * sites all DO supply a message, the `Failed to execute '…' on '…'` form, so
 * they never reach this text and the anchor excludes them. That is a fact about
 * Blink's DOM bindings, not about this string, and if it ever stopped being
 * true this arm would need the same context gate its WebKit sibling has.
 *
 * An optional `NotFoundError: ` prefix is tolerated for the stringified form —
 * `analytics-scrub.ts` classifies from the message text alone, where all that
 * survives is `String(err)`.
 */
function isChromiumFileNotFoundMessage(message: string): boolean {
  return /^(?:NotFoundError: )?A requested file or directory could not be found at the time an operation was processed\.?$/i
    .test(message.trim());
}

/**
 * WebKit's wording for the same DOMException (#2860) — and the arm that CANNOT
 * stand on the message alone, which is why the predicate takes a context.
 *
 * "The object can not be found here." is WebKit's GENERIC description for the
 * `NotFoundError` name, and unlike Blink, WebKit does NOT supply a per-site
 * message for the DOM mutation failures: `removeChild` / `insertBefore` against
 * a parent that no longer holds the node throw a bare `NotFoundError` carrying
 * exactly this text. So on Safari the string is genuinely ambiguous between
 * "the file the user picked is gone" and "a translation extension re-parented a
 * node React owns and the reconciler crashed" (#1229 / #1230 / #1232). The
 * anchoring that separates the two families on Chromium separates nothing here.
 *
 * Getting it wrong is not cosmetic in either direction. Claimed unconditionally,
 * a Safari reconciler crash is shown to the user as "your file may have been
 * moved… select the file again" and, because `analytics-scrub.ts` runs the
 * classifier over EVERY `$exception`, is fingerprinted into
 * `ifc-lite:file_unreadable` and buried in a file-picker issue. Dropped
 * entirely, the Safari half of the family it was added for goes back to being
 * an unclassified one-off.
 *
 * The capture-site `context` is what actually distinguishes them, and it is
 * already on the event: a load failure is caught by `useIfcLoader` and captured
 * as `ifc_model_load` / `geometry_processing`, while a reconciler crash is
 * uncaught and reaches PostHog with no context at all. So this wording counts
 * only inside a load. An uncontextualised occurrence stays `unknown`, which is
 * the honest answer: on this engine, with this string and nothing else, we do
 * not know which failure it was.
 */
function isWebkitGenericNotFoundMessage(message: string): boolean {
  return /^(?:NotFoundError: )?The object can ?not be found here\.?$/i.test(message.trim());
}

/**
 * Whether a message says the picked file was GONE by read time.
 *
 * `context` is the capture site's own `context` property, where one exists. It
 * gates the WebKit arm alone: that engine's wording is ambiguous, so it counts
 * only inside a load. Omitting the context can therefore only cost that one
 * Safari wording its kind — it can never turn a non-match into a match.
 */
export function isFileNotFoundMessage(message: string, context?: unknown): boolean {
  return (
    isChromiumFileNotFoundMessage(message) ||
    (isLoadContext(context) && isWebkitGenericNotFoundMessage(message))
  );
}
