/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Action-log types and the v1 action vocabulary.
 *
 * The action log records high-level intents the user performs — `model.load`,
 * `lens.apply`, `export.run` and so on — for the pattern-miner loop
 * (§06.3) and the personal-memory loop (§06.4). What it does NOT
 * record: model content, chat content, file contents, BYOK keys.
 *
 * Storage and emission patterns mirror the audit log, but the data is
 * different in scope: audit log = security-relevant lifecycle events,
 * action log = user-driven intents.
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §2.
 */

/** Recognised action intent kinds. New kinds extend the vocabulary. */
export type ActionIntent =
  | 'model.load'
  | 'model.unload'
  | 'query.run'
  | 'lens.apply'
  | 'lens.clear'
  | 'export.run'
  | 'script.execute'
  | 'chat.message'
  | 'extension.install'
  | 'extension.uninstall'
  | 'extension.enable'
  | 'extension.disable'
  | 'flavor.activate'
  | 'flavor.export'
  | 'flavor.import'
  | 'selection.change'
  | 'section.apply'
  | 'view.change';

/** All recognised intents. The miner uses this for vocabulary discovery. */
export const ACTION_INTENTS: readonly ActionIntent[] = [
  'model.load',
  'model.unload',
  'query.run',
  'lens.apply',
  'lens.clear',
  'export.run',
  'script.execute',
  'chat.message',
  'extension.install',
  'extension.uninstall',
  'extension.enable',
  'extension.disable',
  'flavor.activate',
  'flavor.export',
  'flavor.import',
  'selection.change',
  'section.apply',
  'view.change',
];

/**
 * Per-intent parameter schemas. Each is a small, content-free metadata
 * shape — counts, schema names, format labels. The miner uses these
 * for sub-pattern discrimination (e.g. "CSV export" vs "JSON export").
 *
 * The keys are deliberately enumerated. If a parameter could carry
 * user content (file names, property values, etc.) it does NOT belong
 * here — keep the no-content rule (§06 §7).
 */
export interface ActionParams {
  'model.load': { schema?: string; entityCount?: number; sizeBytes?: number };
  'model.unload': Record<string, never>;
  'query.run': { type?: string; resultCount?: number };
  'lens.apply': { id?: string };
  'lens.clear': Record<string, never>;
  'export.run': { format: string; entityCount?: number };
  'script.execute': { templateId?: string; durationMs?: number };
  'chat.message': { intent: 'authoring' | 'query' | 'one-shot' | 'fork' };
  'extension.install': { id: string };
  'extension.uninstall': { id: string };
  'extension.enable': { id: string };
  'extension.disable': { id: string };
  'flavor.activate': { id: string };
  'flavor.export': Record<string, never>;
  'flavor.import': Record<string, never>;
  'selection.change': { count: number };
  'section.apply': Record<string, never>;
  'view.change': { mode?: '2d' | '3d' };
}

/** A logged action event. */
export type ActionEvent = {
  [K in ActionIntent]: {
    /** Monotonic-ish sequence assigned by the log. */
    seq: number;
    /** ISO timestamp the log writes; never user-supplied. */
    ts: string;
    intent: K;
    /** Intent-specific parameters from `ActionParams[K]`. */
    params: ActionParams[K];
    /** True if the action completed without error. */
    success: boolean;
    /** Wall-clock duration in ms, if the writer measured it. */
    durationMs?: number;
  };
}[ActionIntent];

export interface ActionFilter {
  /** Restrict to a specific intent. */
  intent?: ActionIntent;
  /** Restrict to events at or after this seq (inclusive). */
  sinceSeq?: number;
  /** Restrict to events at or before this seq (inclusive). */
  untilSeq?: number;
  /** Restrict to events at or after this ISO timestamp (inclusive). */
  sinceTs?: string;
}
