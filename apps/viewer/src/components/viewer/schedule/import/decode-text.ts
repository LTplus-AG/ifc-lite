/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Decode an imported schedule file's bytes to text, honoring a UTF-16 BOM
 * (issue #1890).
 *
 * `FileReader.readAsText` assumes UTF-8 (or the platform default) and has no
 * BOM sniffing of its own. Excel's "Unicode Text (.txt)" export — a real
 * option users reach for from "Save As" — is UTF-16LE, which under
 * `readAsText` "succeeds" but produces every other byte as a NUL, corrupting
 * every task name into garbage rather than failing loudly. Reading the file
 * as an `ArrayBuffer` and decoding here, after sniffing the BOM, is the only
 * way to catch that case: `readAsText` never surfaces the raw bytes needed
 * to detect it.
 */
export function decodeScheduleFileBytes(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  // No UTF-16 BOM: decode as UTF-8, matching the previous `readAsText`
  // behavior. `ignoreBOM: true` keeps a UTF-8 BOM (EF BB BF) in the decoded
  // string as U+FEFF rather than having `TextDecoder` silently swallow it —
  // `splitCsvRows` already strips that character itself (`charCodeAt(0) ===
  // 0xfeff`), and stripping it here too would just make that check dead code.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}
