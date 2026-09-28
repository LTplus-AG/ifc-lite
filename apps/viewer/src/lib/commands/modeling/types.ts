/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Modeling command framework: shared types (charter #6232, WP2).
 *
 * A modeling command is a small state machine over a gesture value `G`
 * (`init` → `pointerMove`/`pointerDown`/typed fields → `commit`). The command
 * never touches the store while the gesture runs: per-frame state lives in the
 * vanilla runtime (`runtime.ts`), and a commit runs inside ONE
 * `AuthoringTransaction` (`transaction.ts`), which is one undo step.
 */

import type { ComponentType } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import type { TranslationKey } from '@/i18n';
import type { KeyCommandId } from '@/lib/commands/keyboard-commands';
import type { SnapProfile, SnapQuery, SnapResult, Vec2 } from '@/lib/snap/types';
import type { ViewerState } from '@/store';

/** Render-space 3D point (viewer Y-up), the shape `SnapResult.render` carries. */
export type Vec3 = readonly [number, number, number];

/** Named snap profiles a command can ask for (WP3 owns the profiles themselves). */
export type SnapProfileId = 'modeling';

/** A registered command's id (`wall.place`, `element.split`, …); see `registry.ts`. */
export type CommandId = string;

/** Which plane a session draws on. Storey planes are the only kind built today. */
export type WorkplaneSpec =
  | { kind: 'storey'; storeyId: number; offset: number }
  | { kind: 'section'; planeId: string };

export interface Ray { origin: Vec3; direction: Vec3 }

/**
 * A resolved workplane: maps workplane-local metres (x, y on the plane, z
 * along its normal) to render space and back, for one model.
 */
export interface Workplane {
  readonly spec: WorkplaneSpec;
  readonly modelId: string;
  localToRender(p: Vec3): Vec3;
  renderToLocal(p: Vec3): Vec3;
  readonly plane: { origin: Vec3; normal: Vec3; u: Vec3; v: Vec3 };
  intersectRay(ray: Ray): { local: Vec2; render: Vec3 } | null;
}

/** What a command sees of the session while its gesture runs. */
export interface CommandContext {
  readonly get: () => ViewerState;
  readonly modelId: string;
  readonly storeyId: number | null;
  /** Null until the session's workplane resolves (or when it was refused). */
  readonly workplane: Workplane | null;
}

export type CommandSignal = { commit: true } | { exit: true };

export function isCommandSignal(value: unknown): value is CommandSignal {
  if (value === null || typeof value !== 'object') return false;
  const keys = Object.keys(value);
  return keys.length === 1 && ((value as { commit?: unknown }).commit === true || (value as { exit?: unknown }).exit === true);
}

/** A typed value the HUD's fields bar edits (length, angle, …). */
export interface CommandField<G> {
  readonly id: string;
  readonly labelKey: TranslationKey;
  readonly unit: 'm' | 'deg' | 'count';
  read(g: G): number | null;
  write(g: G, v: number): G;
}

export interface CommitResult {
  /**
   * The model the ids below name, when the command wrote to another model
   * than the session's (a split of an element selected in another federated
   * model). Default: `tx.modelId`.
   */
  modelId?: string;
  created: number[];
  deleted: number[];
  /** Express ids whose mesh must be rebuilt (WP1 `requestRemesh`). */
  remesh: number[];
  /** Express ids to select after the commit. */
  select?: number[];
  /**
   * New elements that take the session's per-kind type and layer-set
   * defaults (`authored-defaults.ts`), in the same undo step. Opt-in, so
   * default none: a command whose new elements continue an existing one (a
   * split's pieces keep the source's type and material) leaves it out.
   */
  authored?: readonly number[];
}

export interface CommandHudProps<G> {
  gesture: G;
  ctx: CommandContext;
}

export interface ModelingCommand<G = unknown> {
  readonly id: CommandId;
  readonly labelKey: TranslationKey;
  readonly hud: {
    Bar?: ComponentType<CommandHudProps<G>>;
    Scene?: ComponentType<CommandHudProps<G>>;
    hint?: (g: G) => TranslationKey;
  };
  readonly fields?: readonly CommandField<G>[];
  readonly snap: SnapProfile | SnapProfileId;
  /** Per-command keys: rows in the `command.<id>` context of `KEY_COMMANDS`. */
  readonly keys?: readonly { commandKey: KeyCommandId; run(g: G, ctx: CommandContext): G | CommandSignal }[];
  init(ctx: CommandContext): G;
  /** What the snap solver constrains against: the anchor, the chain so far, typed locks. */
  snapQuery?(g: G): Pick<SnapQuery, 'anchor' | 'chain' | 'locks'>;
  pointerMove(g: G, s: SnapResult, ctx: CommandContext): G;
  pointerDown(g: G, s: SnapResult, ctx: CommandContext): G | CommandSignal;
  /** Backspace: drop the last placed point. Absent = the key falls through. */
  undoPoint?(g: G): G;
  ghost?(g: G, ctx: CommandContext): MeshData[];
  validate?(g: G, ctx: CommandContext): { ok: true } | { ok: false; reasonKey: TranslationKey };
  commit(g: G, tx: AuthoringTransaction): CommitResult;
  /** The gesture after a successful commit. Default: a fresh `init`. */
  afterCommit?(g: G, result: CommitResult, ctx: CommandContext): G | CommandSignal;
  /** Escape. Default: reset a gesture that has progressed, otherwise exit. */
  cancel?(g: G): 'reset' | 'exit';
}

/**
 * The one mutation scope a command's `commit` gets. Everything written through
 * `store` actions while `commit` runs becomes ONE undo step.
 */
export interface AuthoringTransaction {
  readonly modelId: string;
  readonly storeyId: number | null;
  readonly workplane: Workplane | null;
  /**
   * The undo batch every mutation of this commit is tagged with. Pass it to
   * batch-aware actions (`resizeWall(…, batchId)`) so their per-batch
   * bookkeeping (undo mesh rebuilds, WP1's remesh registry) keys on it.
   */
  readonly batchId: string;
  /** Live store state; re-read after each action, it changes as you write. */
  readonly store: ViewerState;
}
