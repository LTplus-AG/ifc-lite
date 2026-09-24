/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The .bcfzip container the writer fills (#3612).
 *
 * The archive is built with fflate rather than JSZip. JSZip's ZipFileWorker
 * hardcodes "version needed to extract" to 1.0 (0x000A) in every local and
 * central directory header, whatever the compression method, and has no
 * option to change it. Every entry here is DEFLATE (method 8), which the ZIP
 * APPNOTE (6.3.3, section 4.4.3) says needs 2.0, so JSZip's archives were out
 * of spec. fflate writes 2.0 (0x0014) in both headers.
 *
 * Only flat paths such as `<guid>/markup.bcf` are added, so fflate writes file
 * entries only and never a `<guid>/` directory entry (the BCF spec describes
 * only files).
 */

import { strToU8, zip } from 'fflate';

export class BcfArchive {
  // A Map keeps insertion order. fflate takes a plain object, and every key
  // here contains '.' or '/', so none is an integer-like key that an object
  // would reorder.
  private readonly entries = new Map<string, Uint8Array>();

  /** Add (or replace) a file entry. Strings are encoded as UTF-8. */
  file(path: string, content: string | Uint8Array): void {
    this.entries.set(path, typeof content === 'string' ? strToU8(content) : content);
  }

  /**
   * Pack every entry with DEFLATE (level 6) into a .bcfzip Blob. fflate's
   * async `zip` deflates large entries (snapshots) in workers, so a big
   * export does not block the caller's thread the way `zipSync` would.
   */
  toBlob(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      zip(Object.fromEntries(this.entries), { level: 6 }, (err, bytes) =>
        err ? reject(err) : resolve(new Blob([bytes], { type: 'application/zip' })),
      );
    });
  }
}
