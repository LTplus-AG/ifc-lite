/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The session's ephemeral job journal (U02, #6925): model loads, checks,
 * exports, assistant requests and Flow runs that the user started.
 *
 * These jobs live in memory and cannot resume after a reload, so the
 * journal records each start and finish in `sessionStorage` (per tab,
 * survives reload, never shared with another tab that may still be running
 * its own jobs). On boot, a job recorded as running is restored as
 * `interrupted`: it did not finish, and is never shown as completed.
 *
 * Durable work (the BCF publication outbox) is not journaled here; it has its
 * own IndexedDB record and its own reload recovery, and the tray reads it
 * directly. A record holds identifiers, a catalogued title, a native phase
 * string and times; no model content.
 */

import { create } from 'zustand';
import type { TranslationKey } from '@/i18n';
import { isAnalysisPanel, isWorkspacePanelId, type AnalysisPanelId } from '@/lib/panels/registry';

export type ActivityKind = 'load' | 'check' | 'export' | 'ai' | 'flow';
export type ActivityOutcome = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';

export interface ActivityJob {
  id: string;
  kind: ActivityKind;
  title: TranslationKey;
  /** What the job ran on: a file, an export, a model route. Native text, shown as is. */
  subject?: string;
  /** The panel that owns the job's artifact; the tray opens it. */
  panel?: AnalysisPanelId;
  /** The job's own phase wording, or counted progress. */
  phase?: string;
  progress?: { done: number; total: number };
  startedAt: number;
  finishedAt?: number;
  outcome: ActivityOutcome;
  /** A failure message or outcome qualifier, as the native source reported it. */
  detail?: string;
  detailKey?: TranslationKey;
}

export const ACTIVITY_STORAGE_KEY = 'ifc-lite:activity-journal:v1';
export const ACTIVITY_LIMIT = 30;

interface JournalState {
  jobs: ActivityJob[];
}

export const useActivityJournal = create<JournalState>(() => ({ jobs: [] }));

/** Cancel handles for running jobs. Functions are not persisted; a restored job has none. */
const cancellers = new Map<string, () => void>();
let sequence = 0;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch (error) {
    console.warn('[activity] Session storage is unavailable; jobs will not survive a reload', error);
    return null;
  }
}

function persist(jobs: readonly ActivityJob[]): void {
  const target = storage();
  if (!target) return;
  try {
    target.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(jobs));
  } catch (error) {
    console.warn('[activity] Could not record the job journal', error);
  }
}

function commit(update: (jobs: ActivityJob[]) => ActivityJob[], write = true): void {
  const jobs = update(useActivityJournal.getState().jobs).slice(-ACTIVITY_LIMIT);
  useActivityJournal.setState({ jobs });
  if (write) persist(jobs);
}

export interface BeginActivity {
  kind: ActivityKind;
  title: TranslationKey;
  subject?: string;
  panel?: ActivityJob['panel'];
  phase?: string;
  /** Present when the job can be cancelled from the tray. */
  cancel?: () => void;
  /** Stable id from the source (a request id); generated otherwise. */
  id?: string;
}

export function beginActivity(input: BeginActivity, now = Date.now()): string {
  const id = input.id ?? `${input.kind}-${now}-${++sequence}`;
  if (input.cancel) cancellers.set(id, input.cancel);
  const job: ActivityJob = {
    id, kind: input.kind, title: input.title, startedAt: now, outcome: 'running',
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.panel ? { panel: input.panel } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
  };
  commit((jobs) => [...jobs.filter((existing) => existing.id !== id), job]);
  return id;
}

/**
 * Live updates of a running job. Recorders call this on every store change,
 * so an unchanged patch is a no-op, not a re-render. Phase and progress are
 * not persisted (a reload restores the job as interrupted regardless); a
 * subject that becomes known late (the file name) is, so the interrupted
 * row still says what it was.
 */
export function updateActivity(id: string, patch: Pick<ActivityJob, 'phase' | 'progress' | 'subject'>): void {
  const job = useActivityJournal.getState().jobs.find((candidate) => candidate.id === id);
  if (!job || job.outcome !== 'running') return;
  const subject = patch.subject ?? job.subject;
  if (job.phase === patch.phase && job.subject === subject
    && job.progress?.done === patch.progress?.done && job.progress?.total === patch.progress?.total) return;
  commit((jobs) => jobs.map((candidate) => candidate === job ? { ...job, ...patch, subject } : candidate), subject !== job.subject);
}

export function finishActivity(
  id: string,
  outcome: Exclude<ActivityOutcome, 'running' | 'interrupted'>,
  extra: Pick<ActivityJob, 'detail' | 'detailKey'> = {},
  now = Date.now(),
): void {
  cancellers.delete(id);
  commit((jobs) => jobs.map((job) => job.id === id && job.outcome === 'running'
    // A finished job shows its outcome, not its last live phase or progress.
    ? { ...job, ...extra, outcome, finishedAt: now, phase: undefined, progress: undefined }
    : job));
}

/** Drop a job whose outcome its host reports elsewhere. */
export function discardActivity(id: string): void {
  cancellers.delete(id);
  commit((jobs) => jobs.filter((job) => job.id !== id));
}

/** The source's cancel for a job that is running now; null for anything else (a restored job has none). */
export function activityCanceller(id: string): (() => void) | null {
  const running = useActivityJournal.getState().jobs.some((job) => job.id === id && job.outcome === 'running');
  return running ? cancellers.get(id) ?? null : null;
}

export function cancelActivity(id: string): void {
  activityCanceller(id)?.();
}

export function clearFinishedActivity(): void {
  commit((jobs) => jobs.filter((job) => job.outcome === 'running'));
}

const KINDS = new Set<ActivityKind>(['load', 'check', 'export', 'ai', 'flow']);
const OUTCOMES = new Set<ActivityOutcome>(['running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted']);

function decodeJob(value: unknown, known: (key: string) => key is TranslationKey): ActivityJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const job = value as Record<string, unknown>;
  if (typeof job.id !== 'string' || !KINDS.has(job.kind as ActivityKind) || typeof job.title !== 'string' || !known(job.title)
    || typeof job.startedAt !== 'number' || !OUTCOMES.has(job.outcome as ActivityOutcome)) return null;
  const text = (field: unknown) => typeof field === 'string' ? field.slice(0, 500) : undefined;
  const detailKey = typeof job.detailKey === 'string' && known(job.detailKey) ? job.detailKey : undefined;
  return {
    id: job.id.slice(0, 200), kind: job.kind as ActivityKind, title: job.title, startedAt: job.startedAt,
    outcome: job.outcome as ActivityOutcome,
    ...(text(job.subject) ? { subject: text(job.subject) } : {}),
    ...(typeof job.panel === 'string' && isWorkspacePanelId(job.panel) && isAnalysisPanel(job.panel) ? { panel: job.panel } : {}),
    ...(text(job.phase) ? { phase: text(job.phase) } : {}),
    ...(typeof job.finishedAt === 'number' ? { finishedAt: job.finishedAt } : {}),
    ...(text(job.detail) ? { detail: text(job.detail) } : {}),
    ...(detailKey ? { detailKey } : {}),
  };
}

/**
 * Restore this tab's journal after a reload. Every job still recorded as
 * running was cut off by the reload and comes back `interrupted`.
 * Returns how many were interrupted.
 */
export function restoreActivityJournal(known: (key: string) => key is TranslationKey): number {
  const source = storage();
  if (!source) return 0;
  let parsed: unknown;
  try {
    const raw = source.getItem(ACTIVITY_STORAGE_KEY);
    if (!raw) return 0;
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('[activity] The recorded job journal is unreadable; starting empty', error);
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  let interrupted = 0;
  const restored = parsed.slice(-ACTIVITY_LIMIT).flatMap((value) => {
    const job = decodeJob(value, known);
    if (!job) return [];
    if (job.outcome !== 'running') return [job];
    interrupted++;
    return [{ ...job, outcome: 'interrupted' as const }];
  });
  const live = useActivityJournal.getState().jobs;
  commit(() => [...restored.filter((job) => !live.some((current) => current.id === job.id)), ...live]);
  return interrupted;
}
