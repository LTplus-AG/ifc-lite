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
import { modelWorkspaceTarget } from '@/lib/commands/modeling/workspace-target';
import { getModelingCommand, resolveRoofHeight, resolveWorkplane } from '@/lib/commands/modeling/registry';
import {
  beginCommandRuntime,
  endCommandRuntime,
  getCommandRuntime,
  rebindCommandContext,
  type CommandPhase,
} from '@/lib/commands/modeling/runtime';
import type { CommandContext, CommandId, ModelingCommand, SnapProfileId, WorkplaneSpec } from '@/lib/commands/modeling/types';
import {
  loadModelLayout, persistModelLayout, restoreSidebar, showModelInspector,
  type ModelLayout, type ModelLayoutPick, type SidebarRestore,
} from './authoringSessionSidebar.js';

export type WorkspaceMode = 'view' | 'model';
export type EndCommandReason = 'commit' | 'cancel' | 'switch';

export interface AuthoringSession {
  /**
   * Which entry into the workspace this is: a new number every time a session
   * starts (a storey switch keeps it). Deferred work started in one session
   * checks it before acting, so it never acts on a later one (#9013).
   */
  readonly entry: number;
  readonly modelId: string;
  readonly storeyId: number | null;
  /** Null while the model has no storey to draw on. */
  readonly workplane: WorkplaneSpec | null;
  /** The Roof tool raised the plane by itself, so the plane comes back down when the roof drawing ends (#9202). */
  readonly planeRaisedForRoof: boolean;
  /** The user chose this height (Floor included when typed as 0), so the Roof tool leaves it where it is. */
  readonly planeHeightPinned: boolean;
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
  /**
   * Move the session plane. A height set this way is the user's (`pinned`, the
   * default); `pinned: false` hands it back, so the Roof tool may raise it again.
   */
  setWorkplane: (spec: WorkplaneSpec, options?: { pinned?: boolean }) => void;
  /** Start a modeling command, entering the Model workspace first if needed. */
  startCommand: (id: CommandId) => void;
  endCommand: (reason: EndCommandReason) => void;
}

type Set = StoreApi<ViewerState>['setState'];
type Get = () => ViewerState;

function patchSession(set: Set, patch: Partial<AuthoringSession>): void {
  set((s) => (s.session ? { session: { ...s.session, ...patch } } : {}));
}

/** What `command` runs against, on the session's plane as it is now. */
function commandContext(get: Get, session: AuthoringSession, command: ModelingCommand): CommandContext {
  const built = session.workplane ? resolveWorkplane(get(), session.modelId, session.workplane) : null;
  if (built && 'refused' in built) console.warn(`[modeling] No workplane: ${built.refused}`);
  const ctx = { get, modelId: session.modelId, storeyId: session.storeyId, workplane: built && !('refused' in built) ? built : null };
  if (command.workplane) ctx.workplane = command.workplane(ctx);
  return ctx;
}

/** Move the session's plane; a running command keeps its gesture and draws on the new plane from here on. */
function moveWorkplane(set: Set, get: Get, patch: Pick<AuthoringSession, 'workplane' | 'planeRaisedForRoof'> & Partial<Pick<AuthoringSession, 'planeHeightPinned'>>): void {
  patchSession(set, patch);
  const session = get().session;
  const { command } = getCommandRuntime();
  if (session && command) rebindCommandContext(commandContext(get, session, command));
}

const drawingRoof = (s: ViewerState): boolean =>
  s.session?.activeCommandId === 'slab.place' && s.authoringDefaults.slabClass === 'roof';

/**
 * A roof is drawn at the top of the walls (#9202): starting one raises a plane
 * the user has not pinned, and ending it lowers that plane again, so the next
 * wall does not silently start at the eaves. A height the user set (even 0) is
 * theirs, in both directions.
 */
function settleRoofPlane(set: Set, get: Get): void {
  const s = get();
  const { session } = s;
  if (session?.workplane?.kind !== 'storey' || session.storeyId === null) return;
  const { workplane } = session;
  if (drawingRoof(s)) {
    if (session.planeHeightPinned) return;
    const offset = resolveRoofHeight(s, session.modelId, session.storeyId);
    // Walls can top out below the floor; only no height at all leaves the plane where it is.
    if (Number.isFinite(offset) && offset !== 0) moveWorkplane(set, get, { workplane: { ...workplane, offset }, planeRaisedForRoof: true });
  } else if (session.planeRaisedForRoof) {
    moveWorkplane(set, get, { workplane: { ...workplane, offset: 0 }, planeRaisedForRoof: false });
  }
}

function launch(set: Set, get: Get, api: StoreApi<ViewerState>, id: CommandId): void {
  const command = getModelingCommand(id);
  if (!command || !get().session) return;
  // Patched first: a plane the Roof tool raises or lowers moves on this very write.
  patchSession(set, { activeCommandId: id, phase: 'idle' });
  const session = get().session;
  if (!session) return;
  const ctx = commandContext(get, session, command);
  beginCommandRuntime(
    command,
    ctx,
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
    if (drawingRoof(s) !== drawingRoof(prev)) settleRoofPlane(api.setState, api.getState);
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

/** Session entries so far, for `AuthoringSession.entry`. */
let sessionEntries = 0;

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
      const target = modelWorkspaceTarget(s, opts);
      if (!target) return false;
      const { modelId, storeyId } = target;
      // Re-entering on another model keeps the panel the FIRST entry took over.
      const sidebarRestore = s.session ? s.session.sidebarRestore : showModelInspector(s);
      set({
        workspaceMode: 'model',
        editEnabled: true,
        session: {
          entry: ++sessionEntries,
          modelId,
          storeyId,
          workplane: storeyId === null ? null : { kind: 'storey', storeyId, offset: 0 },
          planeRaisedForRoof: false,
          planeHeightPinned: false,
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
      // …and the storey manager (#9013): the next session opens on the inspector.
      if (get().storeyManagerOpen) get().setStoreyManagerOpen(false);
    },

    setSessionStorey: (storeyId) => {
      patchSession(set, { storeyId, workplane: { kind: 'storey', storeyId, offset: 0 }, planeRaisedForRoof: false, planeHeightPinned: false });
      settleRoofPlane(set, get);
      const active = get().session?.activeCommandId;
      if (active) launch(set, get, api, active);
    },

    setWorkplane: (workplane, options = {}) => moveWorkplane(set, get, { workplane, planeRaisedForRoof: false, planeHeightPinned: options.pinned ?? true }),

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
