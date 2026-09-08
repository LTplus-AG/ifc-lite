/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read the tarball name out of `npm pack`'s output.
 *
 * `npm pack` without `--json` prints an "npm notice" block — the tarball
 * contents, sizes, shasum, integrity — and npm 11 writes that block to
 * STDOUT, not stderr. A caller that trims the captured stdout therefore ends
 * up with twenty lines of prose instead of a filename, and whatever it hands
 * that to fails somewhere else entirely: `fetch-prebuilt-wasm.mjs` passed it
 * to `tar -xzf` and got a bare `status: 2`, which reads like a corrupt
 * download rather than a parse bug. The fix is to ask npm for its
 * machine-readable form and read the documented field.
 */
export function tarballNameFromPackOutput(stdout) {
  let entries;
  try {
    entries = JSON.parse(stdout);
  } catch {
    throw new Error(
      'npm pack --json did not return JSON. Output began: ' +
        JSON.stringify(String(stdout).slice(0, 120)),
    );
  }
  const filename = Array.isArray(entries) ? entries[0]?.filename : undefined;
  if (typeof filename !== 'string' || filename === '') {
    throw new Error(
      'npm pack --json returned no filename. Output began: ' +
        JSON.stringify(String(stdout).slice(0, 120)),
    );
  }
  return filename;
}
