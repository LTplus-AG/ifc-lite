/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { randomBytes } from 'node:crypto';
import type { NativeArtifactAdapter } from './config.js';
import type { Session } from './sessions.js';
type JobOwner = Pick<Session, 'active' | 'operations'>;
import { ServiceError } from './upstream.js';

type Artifact = Awaited<ReturnType<NativeArtifactAdapter['convert']>>;
interface Job {
  owner: JobOwner;
  controller: AbortController;
  state: 'preparing' | 'ready' | 'failed';
  artifact?: Artifact;
  claimed?: boolean;
  error?: ServiceError;
  timer: ReturnType<typeof setTimeout>;
}
/** Bounded in-process jobs. Slots cover conversion AND retained artifact bytes. */
export class ImportJobs {
  private readonly running = new Map<string, Promise<void>>();
  private closing = false;
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly capacity: number, private readonly maxBytes: number) {}

  start(owner: JobOwner, adapter: NativeArtifactAdapter, input: Parameters<NativeArtifactAdapter['convert']>[0]): string {
    input.signal.throwIfAborted();
    if (this.closing || !owner.active) throw new ServiceError(503, 'worker-stopping', 'The import service is stopping.');
    this.prune();
    if (new Set([...this.jobs.keys(), ...this.running.keys()]).size >= this.capacity) throw new ServiceError(429, 'import-busy', 'The import service is busy. Try again shortly.');
    const id = randomBytes(24).toString('base64url');
    const controller = new AbortController();
    const job: Job = { owner, controller, state: 'preparing', timer: setTimeout(() => this.remove(id), 15 * 60_000) };
    job.timer.unref();
    owner.operations.add(controller);
    this.jobs.set(id, job);
    controller.signal.addEventListener('abort', () => this.remove(id), { once: true });
    const signal = AbortSignal.any([input.signal, controller.signal]);
    // Run outside the HTTP request: return 202 before waiting for any SDK work.
    const work = Promise.resolve().then(() => adapter.convert({ ...input, signal })).then((result) => {
      signal.throwIfAborted();
      if (!owner.active || !this.jobs.has(id)) return;
      if (result.revisionId !== input.ref.revisionId) throw new ServiceError(502, 'revision-mismatch', 'The converted model does not match the selected revision.');
      if (result.format !== (adapter.kind === 'proposal' ? 'ifcx' : 'ifc')) throw new ServiceError(502, 'format-mismatch', 'The adapter returned an unsupported model format.');
      if (!result.bytes.byteLength) throw new ServiceError(502, 'empty-artifact', 'The adapter returned an empty model.');
      if (result.bytes.byteLength > this.maxBytes) throw new ServiceError(413, 'artifact-limit', 'The converted model exceeds this deployment’s limit.');
      job.artifact = result; job.state = 'ready';
      this.expireResult(id, job);
    }).catch((error: unknown) => {
      if (!this.jobs.has(id)) return;
      job.state = 'failed';
      job.error = error instanceof ServiceError ? error : new ServiceError(502, 'conversion-failed', 'The Autodesk import failed. Refresh and retry.');
      this.expireResult(id, job);
    }).finally(() => { this.running.delete(id); });
    this.running.set(id, work);
    return id;
  }
  status(id: string, owner: JobOwner): { state: 'preparing' | 'ready' } {
    const job = this.get(id, owner);
    if (job.error) { this.remove(id); throw job.error; }
    return { state: job.state === 'ready' ? 'ready' : 'preparing' };
  }
  take(id: string, owner: JobOwner): { artifact: Artifact; controller: AbortController; release: () => void } {
    const job = this.get(id, owner);
    if (job.error) { this.remove(id); throw job.error; }
    if (!job.artifact) throw new ServiceError(409, 'import-preparing', 'The model is still preparing.');
    const artifact = job.artifact;
    job.claimed = true; job.artifact = undefined;
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.remove(id), 15 * 60_000); job.timer.unref();
    // Bound downloads as well as preparing/retained bytes; release on consumption.
    return { artifact, controller: job.controller, release: () => this.remove(id) };
  }
  cancel(id: string, owner: JobOwner): void { this.get(id, owner); this.remove(id); }
  private get(id: string, owner: JobOwner): Job {
    this.prune();
    const job = this.jobs.get(id);
    if (!job || job.claimed || job.owner !== owner || !owner.active) throw new ServiceError(404, 'import-expired', 'This import is unavailable or expired. Start it again.');
    return job;
  }
  private expireResult(id: string, job: Job): void {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.remove(id), 2 * 60_000);
    job.timer.unref();
  }
  private remove(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id); clearTimeout(job.timer);
    job.owner.operations.delete(job.controller);
    job.controller.abort();
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const id of this.jobs.keys()) this.remove(id);
    await Promise.allSettled(this.running.values());
  }
  private prune(): void {
    for (const [id, job] of this.jobs) if (!job.owner.active || job.controller.signal.aborted) this.remove(id);
  }
}
