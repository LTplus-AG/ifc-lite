/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The modeling command runtime (charter #6232, WP2): the active command's
 * per-frame gesture state, in a vanilla external store rather than Zustand —
 * a pointer move re-renders only the HUD that reads it (`useCommandRuntime`),
 * not every store subscriber.
 *
 * The session slice starts and ends a command (`beginCommandRuntime` /
 * `endCommandRuntime`); the pointer router and the keyboard bindings feed it.
 * A commit runs through `runTransaction`, so it is one undo step.
 */

import { useSyncExternalStore } from 'react';
import { toast } from '@/components/ui/toast';
import { resolve as translate } from '@/i18n/registry';
import type { SnapResult } from '@/lib/snap/types';
import { bindCommandKeys } from './keys.js';
import { runTransaction, type TransactionStore } from './transaction.js';
import { isCommandSignal, type CommandContext, type CommandSignal, type ModelingCommand } from './types.js';

export type CommandPhase = 'idle' | 'gesture' | 'committing';

export interface CommandRuntimeHooks {
  /** The gesture moved between idle / in progress / committing. */
  onPhase(phase: CommandPhase): void;
  /** The command asked to end (Escape on an idle gesture, an exit signal). */
  onExit(): void;
}

export interface FieldEditRequest {
  readonly index: number;
  /** Text to start the edit with (a typed digit); absent = the current value. */
  readonly draft?: string;
  /** Distinguishes two requests for the same field. */
  readonly seq: number;
}

export interface CommandRuntimeState {
  readonly command: ModelingCommand | null;
  readonly ctx: CommandContext | null;
  readonly gesture: unknown;
  /** True once the gesture has progressed past `init` (drives Escape and the phase). */
  readonly dirty: boolean;
  readonly snap: SnapResult | null;
  /** The field the HUD should open for typing; the fields bar consumes it. */
  readonly fieldRequest: FieldEditRequest | null;
  /** The field last opened for typing (Tab moves on from here). */
  readonly activeField: number | null;
}

const IDLE: CommandRuntimeState = {
  command: null, ctx: null, gesture: null, dirty: false, snap: null, fieldRequest: null, activeField: null,
};

let state: CommandRuntimeState = IDLE;
let store: TransactionStore | null = null;
let hooks: CommandRuntimeHooks | null = null;
let unbindKeys: (() => void) | null = null;
let requestSeq = 0;
const listeners = new Set<() => void>();

function publish(next: Partial<CommandRuntimeState>): void {
  const wasDirty = state.dirty;
  state = { ...state, ...next };
  if (state.command && wasDirty !== state.dirty) hooks?.onPhase(state.dirty ? 'gesture' : 'idle');
  for (const listener of listeners) listener();
}

function subscribeCommandRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getCommandRuntime(): CommandRuntimeState {
  return state;
}

export function useCommandRuntime(): CommandRuntimeState {
  return useSyncExternalStore(subscribeCommandRuntime, getCommandRuntime, getCommandRuntime);
}

/** Start `command`; any running command is ended first (without its exit hook). */
export function beginCommandRuntime(
  command: ModelingCommand,
  ctx: CommandContext,
  access: TransactionStore,
  runtimeHooks: CommandRuntimeHooks,
): void {
  endCommandRuntime();
  store = access;
  hooks = runtimeHooks;
  unbindKeys = bindCommandKeys(command, {
    isActive: () => state.command === command,
    commit: commitCommand,
    cancel: cancelCommand,
    undoPoint: undoCommandPoint,
    nextField: () => requestFieldEdit('next'),
    typeValue: (draft) => requestFieldEdit(state.activeField ?? 0, draft),
    toggleSnap: () => { store?.getState().toggleSnap(); return true; },
    runKey: (run) => applyStep(run(state.gesture, ctx)),
  });
  publish({ ...IDLE, command, ctx, gesture: command.init(ctx) });
}

/** Drop the active command's gesture and key bindings. Never calls `onExit`. */
export function endCommandRuntime(): void {
  unbindKeys?.();
  unbindKeys = null;
  store = null;
  hooks = null;
  if (state !== IDLE) publish(IDLE);
}

/** A new gesture value, or a signal, from any command step. */
function applyStep(next: unknown): boolean {
  if (!state.command) return false;
  if (!isCommandSignal(next)) {
    publish({ gesture: next, dirty: true });
    return true;
  }
  return settleSignal(next);
}

function settleSignal(signal: CommandSignal): boolean {
  if ('exit' in signal) {
    hooks?.onExit();
    return true;
  }
  return commitCommand();
}

export function commandPointerMove(snap: SnapResult): void {
  const { command, ctx } = state;
  if (!command || !ctx) return;
  publish({ gesture: command.pointerMove(state.gesture, snap, ctx), snap });
}

export function commandPointerDown(snap: SnapResult): void {
  const { command, ctx } = state;
  if (!command || !ctx) return;
  // Down lands where the last move solved; refresh it so a click with no
  // preceding move (touch, synthetic) still commits the clicked point.
  const moved = command.pointerMove(state.gesture, snap, ctx);
  publish({ gesture: moved, snap });
  applyStep(command.pointerDown(moved, snap, ctx));
}

export function writeCommandField(index: number, value: number): void {
  const field = state.command?.fields?.[index];
  if (!field || !Number.isFinite(value)) return;
  publish({ gesture: field.write(state.gesture, value), dirty: true, activeField: index });
}

/** Enter: validate, then commit the gesture as one transaction. */
export function commitCommand(): boolean {
  const { command, ctx, gesture } = state;
  if (!command || !ctx || !store || !hooks) return false;
  const verdict = command.validate?.(gesture, ctx);
  if (verdict && !verdict.ok) {
    toast.error(translate(verdict.reasonKey));
    return true;
  }
  hooks.onPhase('committing');
  const outcome = runTransaction(store, command, gesture, ctx);
  if (!outcome.ok) {
    hooks.onPhase(state.dirty ? 'gesture' : 'idle');
    toast.error(outcome.reason);
    return true;
  }
  const next = command.afterCommit ? command.afterCommit(gesture, outcome.result, ctx) : command.init(ctx);
  if (isCommandSignal(next)) {
    publish({ gesture: command.init(ctx), dirty: false, fieldRequest: null, activeField: null });
    if ('exit' in next) hooks.onExit();
    else hooks.onPhase('idle');
    return true;
  }
  publish({ gesture: next, dirty: command.afterCommit !== undefined, fieldRequest: null, activeField: null });
  hooks.onPhase(state.dirty ? 'gesture' : 'idle');
  return true;
}

/** Escape: reset a progressed gesture; on an untouched one, end the command. */
function cancelCommand(): boolean {
  const { command, ctx, gesture, dirty } = state;
  if (!command || !ctx) return false;
  const verdict = command.cancel ? command.cancel(gesture) : dirty ? 'reset' : 'exit';
  if (verdict === 'exit') {
    hooks?.onExit();
    return true;
  }
  publish({ gesture: command.init(ctx), dirty: false, fieldRequest: null, activeField: null });
  return true;
}

/** Backspace: the command's own "drop the last point", when it has one. */
function undoCommandPoint(): boolean {
  const { command } = state;
  if (!command?.undoPoint) return false;
  publish({ gesture: command.undoPoint(state.gesture) });
  return true;
}

/** Ask the fields bar to open field `index` (or the next one) for typing. */
export function requestFieldEdit(target: number | 'next', draft?: string): boolean {
  const count = state.command?.fields?.length ?? 0;
  if (count === 0) return false;
  const index = target === 'next' ? ((state.activeField ?? -1) + 1) % count : Math.min(Math.max(target, 0), count - 1);
  requestSeq += 1;
  publish({ fieldRequest: { index, draft, seq: requestSeq }, activeField: index });
  return true;
}

/** The fields bar reports the field the user opened (click) or left (null). */
export function noteActiveField(index: number | null): void {
  if (state.activeField === index) return;
  publish({ activeField: index });
}
