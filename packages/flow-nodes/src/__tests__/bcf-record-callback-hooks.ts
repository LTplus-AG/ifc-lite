/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Stats } from 'node:fs';

export interface CallbackProbe {
  afterStat?: (fd: number, stat: Stats, deliver: (error?: NodeJS.ErrnoException) => void) => void;
  afterClose?: (fd: number, deliver: () => void) => void;
  readError?: NodeJS.ErrnoException;
  closeError?: NodeJS.ErrnoException;
  reads: number;
  closes: number;
}
const errno = (error: unknown): NodeJS.ErrnoException => error instanceof Error ? error : new Error(String(error));
/** Delegate real fd operations; tests may interleave actual filesystem effects. */
export function forwardingFs(actual: typeof import('node:fs'), probe: CallbackProbe) {
  return { ...actual,
    fstat(fd: number, callback: (error: NodeJS.ErrnoException | null, stat: Stats) => void) {
      actual.fstat(fd, (error, stat) => {
        if (error || probe.afterStat === undefined) { callback(error, stat); return; }
        try { probe.afterStat(fd, stat, error => { callback(error ?? null, stat); }); }
        catch (error) { callback(errno(error), stat); }
      });
    },
    read(fd: number, buffer: Buffer, offset: number, length: number, position: number,
      callback: (error: NodeJS.ErrnoException | null, bytesRead: number, data: Buffer) => void) {
      probe.reads += 1;
      if (probe.readError) { callback(probe.readError, 0, buffer); return; }
      actual.read(fd, buffer, offset, length, position, callback);
    },
    close(fd: number, callback: (error: NodeJS.ErrnoException | null) => void) {
      actual.close(fd, error => {
        probe.closes += 1;
        const deliver = () => { callback(error ?? probe.closeError ?? null); };
        if (probe.afterClose === undefined) { deliver(); return; }
        try { probe.afterClose(fd, deliver); } catch (error) { callback(errno(error)); }
      });
    },
  };
}
export function observeStat(probe: CallbackProbe, action: (fd: number, stat: Stats) => void | Promise<void>) {
  const previous = probe.afterStat;
  probe.afterStat = (fd, stat, deliver) => {
    void Promise.resolve().then(() => action(fd, stat)).then(() => { deliver(); }, error => { deliver(errno(error)); });
  };
  return { mockRestore() { probe.afterStat = previous; } };
}
