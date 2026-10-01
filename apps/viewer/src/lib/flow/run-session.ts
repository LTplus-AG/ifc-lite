/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Execution lease survives component unmounts and cancellation drain. */
let active: WorkflowRun | null = null;
export class WorkflowRun {
  readonly id = crypto.randomUUID();
  readonly controller = new AbortController();
  readonly warnings: string[] = [];
  readonly resources = new Map<string, { kind: string; value: unknown }>();
  readonly files = new Map<string, readonly File[]>();
  readonly text = new Map<File, string>();
  phase = '';
  modelReaders = 0;
  async withModelRead<T>(operation: () => Promise<T>): Promise<T> {
    this.check(); this.modelReaders++;
    try { return await operation(); } finally { this.modelReaders--; }
  }
  onProgress?: (phase: string) => void;

  check(): void {
    if (active !== this || this.controller.signal.aborted) throw new DOMException('Workflow cancelled or superseded', 'AbortError');
  }
  progress(phase: string): void { this.check(); this.phase = phase; this.onProgress?.(phase); }
  warn(message: string): void { this.check(); this.warnings.push(message); }
  put(kind: string, value: unknown): string {
    this.check();
    const token = `flow-resource:${this.id}:${crypto.randomUUID()}`;
    this.resources.set(token, { kind, value });
    return token;
  }
  get<T>(token: unknown, kind: string): T {
    this.check();
    const entry = typeof token === 'string' ? this.resources.get(token) : undefined;
    if (!entry || entry.kind !== kind) throw new Error(`Invalid or expired workflow ${kind} resource`);
    return entry.value as T;
  }
  cancel(): void { this.controller.abort(); }
  release(): void {
    this.files.clear(); this.text.clear(); this.resources.clear();
    if (active === this) active = null;
  }
}
export function startWorkflowRun(): WorkflowRun {
  if (active) throw new Error('A workflow is already running or finishing cancellation');
  active = new WorkflowRun();
  return active;
}
export function cancelWorkflowRun(): void { active?.cancel(); }
export function isNativeWorkflowBusy(): boolean { return active !== null; }
export function assertWorkflowOwner(owner?: string): void {
  if (active && active.id !== owner) throw new Error('A workflow is running; wait or cancel it first');
  if (active?.controller.signal.aborted) throw new DOMException('Workflow cancelled', 'AbortError');
}

/** Native edits wait while check inputs or PDF inputs are being captured. */
export function areWorkflowModelsReadLocked(): boolean { return (active?.modelReaders ?? 0) > 0; }
