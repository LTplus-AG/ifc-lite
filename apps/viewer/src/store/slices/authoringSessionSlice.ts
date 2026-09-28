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
import { fromGlobalIdFromModels } from '../globalId.js';
import { selectEffectiveStoreyId } from '@/components/viewer/add-element-storeys';
import { getModelingCommand, resolveWorkplane } from '@/lib/commands/modeling/registry';
import {
  beginCommandRuntime,
  endCommandRuntime,
  getCommandRuntime,
  type CommandPhase,
} from '@/lib/commands/modeling/runtime';
import type { CommandId, SnapProfileId, WorkplaneSpec } from '@/lib/commands/modeling/types';
import {
  loadModelLayout, persistModelLayout, restoreSidebar, showModelInspector,
  type ModelLayout, type ModelLayoutPick, type SidebarRestore,
} from './authoringSessionSidebar.js';

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
  /** The sidebar panel to put back on exit (null: the workspace took nothing over). */
  readonly sidebarRestore: SidebarRestore | null;
}

export interface EnterModelWorkspaceOptions {
  modelId?: string;
  storeyId?: number;
  command?: CommandId;
}

export interface AuthoringSessionSlice {
  workspaceMode: WorkspaceMode;
  session: AuthoringSession | null;
  /** Plan ‖ 3D split of the Model workspace's viewport as the user picked it (persisted per browser). */
  modelLayout: ModelLayoutPick;
  setModelLayout: (layout: ModelLayout) => void;
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

function selectedRef(s: ViewerState): { modelId: string; expressId: number } | null {
  // The store's own resolver first (it knows overlay-allocated ids), then the
  // offset ranges — `resolveEntityRef`'s order, without importing the store.
  if (s.selectedEntityId === null) return null;
  return s.resolveGlobalIdFromModels(s.selectedEntityId) ?? fromGlobalIdFromModels(s.models, s.selectedEntityId) ?? null;
}

/** The storey the selection sits on (or is), in `modelId`. */
function selectionStorey(s: ViewerState, modelId: string): number | null {
  const ref = selectedRef(s);
  const hierarchy = s.models.get(modelId)?.ifcDataStore?.spatialHierarchy;
  if (!ref || ref.modelId !== modelId || !hierarchy) return null;
  if (hierarchy.storeyElevations.has(ref.expressId)) return ref.expressId;
  return hierarchy.elementToStorey.get(ref.expressId) ?? null;
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
  api.subscribe((s, prev) => {
    // The workspace closed, however (Leave, its model removed, a file swap):
    // the sidebar gets its panel back, and edit mode goes with it, so the two
    // never disagree.
    if (prev.workspaceMode === 'model' && s.workspaceMode === 'view') {
      restoreSidebar(api.getState, prev.session?.sidebarRestore ?? null);
      if (api.getState().editEnabled) {
        api.getState().setEditEnabled(false);
        return;
      }
    }
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
    modelLayout: loadModelLayout(),
    setModelLayout: (modelLayout) => {
      persistModelLayout(modelLayout);
      set({ modelLayout });
    },

    enterModelWorkspace: (opts = {}) => {
      const s = get();
      if (!s.canCollabEdit()) return false;
      if (s.session && opts.modelId === undefined && opts.storeyId === undefined) {
        if (opts.command) get().startCommand(opts.command);
        return true;
      }
      const modelId = resolveModelId(s, opts.modelId ?? selectedRef(s)?.modelId);
      const store = modelId ? s.models.get(modelId)?.ifcDataStore : null;
      if (!modelId || !store) return false;
      // Storey: explicit → the selection's → the Add Element panel's → the first.
      const preferred = opts.storeyId ?? selectionStorey(s, modelId) ?? s.addElementStoreyId;
      const storeyId = selectEffectiveStoreyId(store, s.mutationViews.get(modelId), preferred);
      // Re-entering on another model keeps the panel the FIRST entry took over.
      const sidebarRestore = s.session ? s.session.sidebarRestore : showModelInspector(s);
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
          sidebarRestore,
        },
      });
      if (opts.command) get().startCommand(opts.command);
      return true;
    },

    exitModelWorkspace: () => {
      // Leaving cancels the gesture in progress; nothing half-drawn is written.
      if (get().session?.activeCommandId) get().endCommand('cancel');
      set({ workspaceMode: 'view', session: null });
      // …and edit mode with it (authoring tools, georef drafts: uiSlice).
      if (get().editEnabled) get().setEditEnabled(false);
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
