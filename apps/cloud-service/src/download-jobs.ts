/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { randomBytes } from 'node:crypto';
import { CloudError } from './config.js';
import type { DownloadFile } from './download-file.js';
import { downloadResponse } from './download-response.js';
import type { CloudSession, CloudSessions } from './sessions.js';
import { downloadBytes } from './upstream.js';
type Body = { path: string; revision?: string };
interface Job {
  id: string; owner: CloudSession; state: 'preparing' | 'ready' | 'failed';
  controller: AbortController; op: ReturnType<CloudSessions['operation']>;
  file?: DownloadFile; error?: CloudError; timer: ReturnType<typeof setTimeout>;
  removed: boolean; released: boolean; claimed: boolean;
}
/** Preparation replies immediately; private artifacts are session-owned and claimable once. */
export class DownloadJobs {
  private readonly jobs = new Map<string, Job>();
  private active = 0;
  constructor(private readonly sessions: CloudSessions) {}
  start(owner: CloudSession, body: Body): string {
    if (this.active >= 2 || this.jobs.size >= 64) throw new CloudError(503, 'busy', 'Downloads are busy. Try again.');
    const controller = new AbortController();
    const op = this.sessions.operation(owner, 15 * 60_000, controller.signal);
    const id = randomBytes(32).toString('base64url');
    const job: Job = { id, owner, controller, op, state: 'preparing', removed: false, released: false, claimed: false,
      timer: setTimeout(() => controller.abort(), 15 * 60_000) };
    job.timer.unref(); this.jobs.set(id, job); this.active++;
    op.signal.addEventListener('abort', () => {
      this.remove(job);
      if (job.state === 'ready' && !job.claimed) void this.dispose(job).catch(() => console.warn('Cloud artifact cleanup failed'));
    }, { once: true });
    void this.prepare(job, body);
    return id;
  }
  private release(job: Job): void {
    if (job.released) return;
    job.released = true; this.active--; job.op.done();
  }
  private remove(job: Job): void {
    job.removed = true; clearTimeout(job.timer); this.jobs.delete(job.id);
  }
  private async dispose(job: Job): Promise<void> {
    const file = job.file; job.file = undefined;
    try { if (file) { try { await file.stream.cancel(); } finally { await file.dispose(); } } }
    finally { this.release(job); }
  }
  private async prepare(job: Job, body: Body): Promise<void> {
    try {
      job.file = await downloadBytes(this.sessions, job.owner, body, job.op.signal);
      if (job.removed || job.op.signal.aborted) { await this.dispose(job); return; }
      job.state = 'ready'; clearTimeout(job.timer);
      job.timer = setTimeout(() => job.controller.abort(), 2 * 60_000); job.timer.unref();
    } catch (error) {
      if (!job.removed) {
        job.state = 'failed';
        job.error = error instanceof CloudError ? error : new CloudError(502, 'download-failed', 'Cloud file download failed.');
        clearTimeout(job.timer); job.timer = setTimeout(() => this.remove(job), 2 * 60_000); job.timer.unref();
      }
      this.release(job);
    }
  }
  private owned(owner: CloudSession, id: unknown): Job {
    const job = typeof id === 'string' ? this.jobs.get(id) : undefined;
    if (!job || job.owner !== owner || !owner.active) throw new CloudError(404, 'download-expired', 'Cloud download expired. Try again.');
    if (job.state === 'failed') { this.remove(job); throw job.error ?? new CloudError(502, 'download-failed', 'Cloud file download failed.'); }
    return job;
  }
  status(owner: CloudSession, id: unknown): { state: 'preparing' | 'ready' } {
    const job = this.owned(owner, id); return { state: job.state === 'ready' ? 'ready' : 'preparing' };
  }
  claim(owner: CloudSession, id: unknown, signal: AbortSignal): Response {
    const job = this.owned(owner, id);
    if (job.state !== 'ready' || !job.file) throw new CloudError(409, 'download-preparing', 'Cloud download is still preparing.');
    // Removal prevents a second claim; the operation still owns the file until streaming cleanup.
    job.claimed = true; this.remove(job); const file = job.file; job.file = undefined;
    const downloadSignal = AbortSignal.any([job.op.signal, signal]);
    return downloadResponse(file, downloadSignal, () => this.release(job));
  }
  cancel(owner: CloudSession, id: unknown): void {
    const job = typeof id === 'string' ? this.jobs.get(id) : undefined;
    if (!job || job.owner !== owner) return;
    job.controller.abort(); this.remove(job);
  }
}
