/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Content refusals only: never generic SyntaxError, decoder bounds or I/O errors.
 * Header readers receive completed byte reads; interrupted HTTP ranges have
 * their own length-mismatch errors and must remain outside this family.
 * These packages throw plain Error, except the parser's stable name/code pair.
 * Keep whole-message anchors: arbitrary file bytes may contain engine keywords.
 */
export function isInvalidInputError(err: unknown, message: string): boolean {
  if (typeof err === 'object' && err !== null && 'name' in err &&
      err.name === 'IfcInputError' && 'code' in err &&
      ['EMPTY_INPUT', 'INVALID_STEP', 'MISSING_DATA'].includes(String(err.code))) return true;
  return CONTENT_REFUSALS.some((pattern) => pattern.test(message));
}

const CONTENT_REFUSALS = [
  /^E57: header truncated \(need 48 bytes\)$/,
  /^E57: bad magic "[\s\S]*" \(expected "ASTM-E57"\)$/,
  /^E57: (?:pageSize too small|invalid pageSize \S+|file contains no Data3D scans)$/,
  /^E57: XML root is not <e57Root> \(saw <[^>]*>\)$/,
  /^LAS: (?:header truncated|bad magic — expected "LASF"|invalid point count)$/,
  /^LAS: invalid [XYZ] (?:scale|offset) \(\S+\)$/,
  /^LAS: header point-record length \(\d+\) smaller than format \d+ baseline \(\d+\)$/,
  /^PCD: missing DATA line in header \(scanned first \d+ bytes\)$/,
  /^PCD: (?:malformed DATA line|missing FIELDS|SIZE\/FIELDS length mismatch|TYPE\/FIELDS length mismatch|field stride overflow|invalid point count|x\/y\/z fields are required)$/,
  /^PCD: invalid field SIZE or COUNT \(size=\S+, count=\S+\)$/,
  /^PLY: missing magic — file does not start with "ply"$/,
  /^PLY: missing end_header line in first \d+ bytes$/,
  /^PLY: (?:end_header line not terminated by newline|missing `format` line in header|missing `vertex` element|no vertex element|vertex element must define x, y, z properties)$/,
  /^PLY: invalid element count "[^"\r\n]*" for element "[^"\r\n]*"$/,
  /^PLY: (?:property declared before any element|invalid list property declaration): "[^"\r\n]*"$/,
  /^PLY: invalid vertex count \S+$/,
  /^PLY: vertex property "[^"\r\n]*" must not be declared more than once$/,
  /^(?:XYZ|PTS|CSV): file does not look like ASCII point data$/,
  /^Invalid IFCX file(?: "[^"\r\n]*")?: (?:JSON parse error - SyntaxError: [\s\S]+|missing or invalid header\.ifcxVersion)$/,
  /^Unknown file format\. Expected IFC \(STEP\) or IFCX \(JSON\)\.$/,
];
