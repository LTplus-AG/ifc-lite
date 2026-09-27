/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The authoring session (charter #6232, WP2): which workspace the viewer is
 * in, and — in the Model workspace — which model, storey and workplane new
 * geometry lands on and which modeling command is running.
 *
 * Only coarse session state lives here. The running command's per-frame
 * gesture lives in the vanilla runtime (`lib/commands/modeling/runtime.ts`);
 * this slice starts and ends it, and ends it whenever the active tool leaves
 * `'command'` or the session goes away (model removed, file swap).
 *
 * Snapping has one owner, the existing `snapEnabled` flag (S toggles it in
 * the `command` key context); the session only names the profile.
 */

import type { StateCreator, StoreApi } from 'zustand';
import type { ViewerState } from '../index.js';
import { defineSliceTeardown } from '../teardown.js';
import { selectEffectiveStoreyId } from '@/components/viewer/add-element-storeys';
import { getModelingCommand, resolveWorkplane } from '@/lib/commands/modeling/registry';
import {
  beginCommandRuntime,
  endCommandRuntime,
  getCommandRuntime,
  type CommandPhase,
} from '@/lib/commands/modeling/runtime';
import type { CommandId, WorkplaneSpec } from '@/lib/commands/modeling/types';
import type { SnapProfileId } from '@/lib/snap/types';

export type WorkspaceMode = 'view' | 'model';
export type EndCommandReason = 'commit' | 'cancel' | 'switch';

export interface AuthoringSession {
  readonly modelId: string;
  readonly storeyId: number | null;
  /** Null while the model has no storey to draw on. */
  readonly workplane: WorkplaneSpec | null;
  readonly activeCommandId: CommandId | null;
  readonly phase: CommandPhase;
  readonly snap: { readonly profile: SnapProfileId };
}

export interface EnterModelWorkspaceOptions {
  modelId?: string;
  storeyId?: number;
  command?: CommandId;
}

export interface AuthoringSessionSlice {
  workspaceMode: WorkspaceMode;
  session: AuthoringSession | null;
  /** False when refused (collab role, no editable model). */
  enterModelWorkspace: (opts?: EnterModelWorkspaceOptions) => boolean;
  exitModelWorkspace: () => void;
  setSessionStorey: (storeyId: number) => void;
  setWorkplane: (spec: WorkplaneSpec) => void;
  /** Start a modeling command, entering the Model workspace first if needed. */
  startCommand: (id: CommandId) => void;
  endCommand: (reason: EndCommandReason) => void;
}

type Set = StoreApi<ViewerState>['setState'];
type Get = () => ViewerState;

function resolveModelId(s: ViewerState, preferred: string | undefined): string | null {
  const candidates = [preferred, s.addElementModelId ?? undefined, s.activeModelId ?? undefined, s.models.keys().next().value];
  return candidates.find((id): id is string => id !== undefined && s.models.get(id)?.ifcDataStore != null) ?? null;
}

function patchSession(set: Set, patch: Partial<AuthoringSession>): void {
  set((s) => (s.session ? { session: { ...s.session, ...patch } } : {}));
}

function launch(set: Set, get: Get, api: StoreApi<ViewerState>, id: CommandId): void {
  const command = getModelingCommand(id);
  const session = get().session;
  if (!command || !session) return;
  patchSession(set, { activeCommandId: id, phase: 'idle' });
  const built = session.workplane ? resolveWorkplane(get(), session.modelId, session.workplane) : null;
  if (built && 'refused' in built) console.warn(`[modeling] No workplane: ${built.refused}`);
  beginCommandRuntime(
    command,
    { get, modelId: session.modelId, storeyId: session.storeyId, workplane: built && !('refused' in built) ? built : null },
    api,
    {
      onPhase: (phase) => { if (get().session?.phase !== phase) patchSession(set, { phase }); },
      onExit: () => get().endCommand('cancel'),
    },
  );
}

/** Keep the runtime in step with the tool and the session, whoever changed them. */
function syncRuntime(api: StoreApi<ViewerState>): void {
  api.subscribe((s) => {
    const running = getCommandRuntime().command;
    const commandTool = s.activeTool === 'command';
    if (running && (!commandTool || s.session?.activeCommandId !== running.id)) endCommandRuntime();
    if (!commandTool && s.session?.activeCommandId) {
      api.setState({ session: { ...s.session, activeCommandId: null, phase: 'idle' } });
    } else if (commandTool && !s.session) {
      // The session ended under a running command (model removed, file swap).
      s.setActiveTool('select');
    }
  });
}

export const createAuthoringSessionSlice: StateCreator<ViewerState, [], [], AuthoringSessionSlice> = (set, get, api) => {
  syncRuntime(api);
  return {
    workspaceMode: 'view',
    session: null,

    enterModelWorkspace: (opts = {}) => {
      const s = get();
      if (!s.canCollabEdit()) return false;
      const modelId = resolveModelId(s, opts.modelId);
      const store = modelId ? s.models.get(modelId)?.ifcDataStore : null;
      if (!modelId || !store) return false;
      const storeyId = selectEffectiveStoreyId(store, s.mutationViews.get(modelId), opts.storeyId ?? s.addElementStoreyId);
      set({
        workspaceMode: 'model',
        editEnabled: true,
        session: {
          modelId,
          storeyId,
          workplane: storeyId === null ? null : { kind: 'storey', storeyId, offset: 0 },
          activeCommandId: null,
          phase: 'idle',
          snap: { profile: 'modeling' },
        },
      });
      if (opts.command) get().startCommand(opts.command);
      return true;
    },

    exitModelWorkspace: () => {
      if (get().session?.activeCommandId) get().endCommand('cancel');
      set({ workspaceMode: 'view', session: null });
    },

    setSessionStorey: (storeyId) => {
      patchSession(set, { storeyId, workplane: { kind: 'storey', storeyId, offset: 0 } });
      const active = get().session?.activeCommandId;
      if (active) launch(set, get, api, active);
    },

    setWorkplane: (workplane) => patchSession(set, { workplane }),

    startCommand: (id) => {
      if (!getModelingCommand(id)) {
        console.warn(`[modeling] Unknown command: ${id}`);
        return;
      }
      if (!get().session && !get().enterModelWorkspace()) return;
      // The shared authoring gate (collab role) lives in setActiveTool.
      if (get().activeTool !== 'command') get().setActiveTool('command');
      if (get().activeTool !== 'command') return;
      launch(set, get, api, id);
    },

    endCommand: () => {
      endCommandRuntime();
      patchSession(set, { activeCommandId: null, phase: 'idle' });
      if (get().activeTool === 'command') get().setActiveTool('select');
    },
  };
};

const CLOSED = { workspaceMode: 'view', session: null } as const;

/**
 * A session names one model and one of its storeys, so it ends with that
 * model, with the federation, and with a file swap. The runtime follows
 * through `syncRuntime` (the tool leaves `'command'`).
 */
export const authoringSessionTeardown = defineSliceTeardown('authoringSessionSlice', ['workspaceMode', 'session'], {
  'session-reset': () => CLOSED,
  'model-removed': (scope, state) => (state.session?.modelId === scope.modelId ? CLOSED : {}),
  'all-models-cleared': () => CLOSED,
});
