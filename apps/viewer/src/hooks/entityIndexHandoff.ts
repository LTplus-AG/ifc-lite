/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one hop between the geometry pre-pass and the parser worker.
 *
 * On every SAB-backed worker load at or above 2 MB the parser does not scan
 * the file at all -- the geometry pre-pass hands it a finished entity index and
 * the whole model is built from those columns. Anything the pre-pass dropped
 * is therefore invisible on the parser side by construction: a record refused
 * for an oversized express id (#3395) is not in `ids`, and a scan that stopped
 * at an unterminated string or comment (#3790) takes the entire tail of the
 * file with it. Both counts have to make this hop or the viewer renders a
 * short model and reports a clean load.
 *
 * A named function rather than an inline closure in `useIfcLoader.ts` so the
 * forwarding can be tested by calling it, instead of by reading the hook's
 * source text -- the pre-pass and the parser worker both live behind Workers,
 * and this hop is the part the viewer owns.
 */

/** The slice of `WorkerParser` this handoff needs (it may not exist yet). */
export interface EntityIndexSink {
  setEntityIndex(
    ids: Uint32Array,
    starts: Uint32Array,
    lengths: Uint32Array,
    oversizedIdCount?: number,
    malformedRecordCount?: number,
  ): void;
}

/**
 * Build the `onEntityIndex` callback for `processAdaptive`, forwarding to
 * `sink` -- or doing nothing when the parser fell back to the main thread and
 * there is no worker to hand anything to.
 */
export function forwardEntityIndexTo(sink: EntityIndexSink | null | undefined) {
  return (
    ids: Uint32Array,
    starts: Uint32Array,
    lengths: Uint32Array,
    oversizedIdCount?: number,
    malformedRecordCount?: number,
  ): void => {
    sink?.setEntityIndex(ids, starts, lengths, oversizedIdCount, malformedRecordCount);
  };
}
