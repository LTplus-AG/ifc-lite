/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Signed ISO 8601 duration codec, shared by the schedule extractor (decode,
 * for `IfcLagTime`/`IfcTaskTime` durations coming out of a STEP file) and the
 * schedule serializer (encode, for durations going back in).
 *
 * Kept as one pair of functions rather than two private copies so the
 * round-trip property — `parseIso8601Duration(secondsToIso8601Duration(s)) ===
 * s` for any representable `s` — is visible in one place instead of having to
 * be checked twice against drifting implementations.
 *
 * The sign is a deliberate, documented departure from strict ISO 8601 (which
 * has no negative durations): IFC schedule lag can be a lead time (a
 * successor starting before its predecessor finishes), and losing that sign
 * silently turns a lead into a lag of the same magnitude — a swing of twice
 * the lag's size for anyone reading the exported file. ISO 8601-2 does define
 * a signed extension (`-P2D`), which is what `IfcDuration`'s `STRING` type
 * accepts here. Some third-party `^P...` IfcDuration parsers reject the
 * leading `-` outright; that tradeoff is accepted deliberately in exchange
 * for a lossless round trip through this codec. See
 * `.changeset/lag-time-lead-magnitude.md` and `docs/guide/schedule-import.md`.
 */

/**
 * Parse an ISO-8601 duration string (e.g. "P1D", "PT2H30M", "P1Y2M3DT4H5M6S",
 * or the signed extension "-P2D") into a number of seconds. Returns
 * undefined on invalid input, including a bare "P"/"PT" (no components) or a
 * bare "-P"/"-PT" with a sign but nothing else to negate.
 */
export function parseIso8601Duration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(
    /^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match) return undefined;
  const [, sign, y, mo, w, d, h, mi, s] = match;
  // Reject bare "P" / "PT" (and the signed "-P" / "-PT") which would
  // otherwise silently return 0 and mask malformed IfcLagTime / IfcTaskTime
  // durations.
  if (y === undefined && mo === undefined && w === undefined && d === undefined
    && h === undefined && mi === undefined && s === undefined) {
    return undefined;
  }
  const yearSec = 365.2425 * 86400;
  const monthSec = yearSec / 12;
  const magnitude =
    (y ? parseFloat(y) * yearSec : 0) +
    (mo ? parseFloat(mo) * monthSec : 0) +
    (w ? parseFloat(w) * 7 * 86400 : 0) +
    (d ? parseFloat(d) * 86400 : 0) +
    (h ? parseFloat(h) * 3600 : 0) +
    (mi ? parseFloat(mi) * 60 : 0) +
    (s ? parseFloat(s) : 0);
  return sign ? -magnitude : magnitude;
}

/**
 * Format seconds (signed) as an ISO 8601 duration string suitable for
 * `IfcDuration`. Prefers the coarsest integer unit that divides cleanly to
 * avoid noisy "PT432000S" style output for round values like "P5D". Negative
 * input emits the ISO 8601-2 signed form ("-P2D") — see the module doc
 * comment for why.
 */
export function secondsToIso8601Duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds === 0) return 'PT0S';
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.abs(seconds);
  // Only a whole number of seconds can promote to a coarser unit — rounding
  // a fractional value into days/hours/minutes here would be the same silent
  // precision loss as the seconds case below, just hidden behind a coarser
  // label.
  if (Number.isInteger(abs)) {
    if (abs % 86_400 === 0) return `${sign}P${abs / 86_400}D`;
    if (abs % 3_600 === 0) return `${sign}PT${abs / 3_600}H`;
    if (abs % 60 === 0) return `${sign}PT${abs / 60}M`;
    return `${sign}PT${abs}S`;
  }
  // A fractional lag survives as a decimal on the seconds component (ISO
  // 8601 permits a decimal fraction there) instead of being rounded away —
  // `Math.round` used to degrade any sub-second value to PT0S, in the very
  // codec this was consolidated to make lossless. `toFixed` + trim (rather
  // than `String`) keeps very small magnitudes like 1e-7 from producing
  // exponent notation, which is not valid inside an IfcDuration string.
  const fixed = abs.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  return `${sign}PT${fixed}S`;
}
