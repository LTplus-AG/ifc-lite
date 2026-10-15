/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Buffer } from 'node:buffer';
import { close, constants, fstat, open, read } from 'node:fs';
import { MAX_RECORD_BYTES, refuse } from './bcf-publication-codec.js';

type Result = { ok: true; value: unknown } | { ok: false; error: unknown };

/** One asynchronous record read, with validated bounds and close before settlement. */
export function readPublicationRecord(path: string, syncEntry?: () => Promise<void>): Promise<unknown> {
  // Callback I/O avoids a FileHandle/EventEmitter and a promise per syscall.
  // The operation sequence and every refusal match the bounded store reader.
  return new Promise((resolve, reject) => {
    open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, (openError, fd) => {
      if (openError) { reject(openError); return; }
      const finish = (result: Result): void => {
        try {
          close(fd, closeError => {
            // A finally-close error takes precedence over a read/parse/sync error.
            if (closeError) reject(closeError);
            else if (result.ok) resolve(result.value);
            else reject(result.error);
          });
        } catch (error) { reject(error); }
      };
      try {
        fstat(fd, (statError, stat) => {
          if (statError) { finish({ ok: false, error: statError }); return; }
          let bytes: Buffer;
          try {
            if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) refuse('invalid or oversized stored record');
            bytes = Buffer.alloc(stat.size + 1);
          } catch (error) { finish({ ok: false, error }); return; }
          try {
            read(fd, bytes, 0, bytes.length, 0, (readError, bytesRead) => {
              if (readError) { finish({ ok: false, error: readError }); return; }
              try {
                if (bytesRead > MAX_RECORD_BYTES) refuse('record exceeds storage bound');
                if (bytesRead > stat.size) refuse('stored record grew while reading');
              } catch (error) { finish({ ok: false, error }); return; }
              const parse = (): void => {
                let value: unknown;
                try { value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); }
                catch (error) { finish({ ok: false, error }); return; }
                finish({ ok: true, value });
              };
              if (syncEntry === undefined) { parse(); return; }
              // Durability repair still precedes parsing and acknowledgment.
              try { syncEntry().then(parse, error => { finish({ ok: false, error }); }); }
              catch (error) { finish({ ok: false, error }); }
            });
          } catch (error) { finish({ ok: false, error }); }
        });
      } catch (error) { finish({ ok: false, error }); }
    });
  });
}
