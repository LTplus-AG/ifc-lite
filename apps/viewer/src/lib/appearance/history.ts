/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Mutation, MutablePropertyView } from '@ifc-lite/mutations';
import type { StoreApi } from 'zustand';
import type { ViewerState } from '@/store/index.js';

export interface AppearanceHistoryCommand {
  readonly mutations: readonly Mutation[];
  /** Synchronous, atomic IFC + GPU replay. Throwing leaves history untouched. */
  replay(direction: 'undo' | 'redo'): AppearanceHistoryPublication | void;
  /** Release this history owner's resource leases, never the live model's owner. */
  dispose(): void;
}
export type AppearanceHistoryPublication = Partial<Pick<ViewerState, 'models' | 'geometryResult' | 'selectedEntityId' | 'selectedEntityIds' | 'selectedEntity' | 'selectedEntitiesSet' | 'selectedEntities'>>;
interface Entry {
  modelId: string;
  view: MutablePropertyView;
  command: AppearanceHistoryCommand;
}
interface Registry {
  entries: Map<string, Entry>;
  unsubscribe: () => void;
  replaying: boolean;
}
// Zustand's React bound hook and the slice's vanilla API are different objects,
// but expose the same getState function. Both must resolve one command registry.
const registries = new WeakMap<StoreApi<ViewerState>['getState'], Registry>();

function prune(store: StoreApi<ViewerState>, registry: Registry): void {
  const state = store.getState();
  const liveIds = new Map<string, Set<string>>();
  const staleIds = new Set<string>();
  for (const [id, entry] of registry.entries) {
    let ids = liveIds.get(entry.modelId);
    if (!ids) {
      ids = new Set([...(state.undoStacks.get(entry.modelId) ?? []), ...(state.redoStacks.get(entry.modelId) ?? [])]
        .map(mutation => mutation.id));
      liveIds.set(entry.modelId, ids);
    }
    const currentView = state.mutationViews.get(entry.modelId) === entry.view;
    const retained = currentView && ids.has(id);
    if (retained) continue;
    if (!currentView && ids.has(id)) staleIds.add(id);
    registry.entries.delete(id);
    try { entry.command.dispose(); }
    catch (error) { console.error('Failed to release appearance history resources', error); }
  }
  if (registry.entries.size === 0) {
    registry.unsubscribe();
    registries.delete(store.getState);
  }
  if (staleIds.size) {
    // Never let an orphaned grouped record fall through to generic replay on a
    // replacement view that happens to reuse the same model/entity identifiers.
    const withoutStale = (stacks: Map<string, Mutation[]>) => new Map([...stacks]
      .map(([modelId, mutations]) => [modelId, mutations.filter(mutation => !staleIds.has(mutation.id))]));
    store.setState(current => ({ undoStacks: withoutStale(current.undoStacks), redoStacks: withoutStale(current.redoStacks) }));
  }
}

/** Group already-applied domain edits into one step in the model's existing Ctrl+Z order. */
export function registerAppearanceHistory(
  store: StoreApi<ViewerState>, modelId: string, command: AppearanceHistoryCommand,
): Mutation {
  return prepareAppearanceHistory(store, modelId, command)();
}

/**
 * Validate after the IFC transaction and before publishing GPU replacements. Then
 * publish GPU state and call the returned history commit in the same synchronous
 * turn, with no intervening model/history edit. Validation never takes ownership.
 * Replay must stage GPU resources first, atomically replay IFC, then publish GPU
 * state; if it throws, its own rollback must restore IFC + GPU before returning.
 */
export function prepareAppearanceHistory(
  store: StoreApi<ViewerState>, modelId: string, command: AppearanceHistoryCommand,
  stagedView?: MutablePropertyView,
): (publication?: AppearanceHistoryPublication) => Mutation {
  const state = store.getState();
  const view = state.mutationViews.get(modelId);
  const finalMutation = command.mutations.at(-1);
  if (!view || !finalMutation || command.mutations.some(mutation => mutation.modelId !== modelId)) {
    throw new Error('Appearance history requires applied mutations for the current model.');
  }
  const appliedIds = new Set((stagedView ?? view).getMutations().map(mutation => mutation.id));
  const commandIds = new Set(command.mutations.map(mutation => mutation.id));
  if (commandIds.size !== command.mutations.length || command.mutations.some(mutation => !appliedIds.has(mutation.id))
    || [state.undoStacks, state.redoStacks].some(stacks =>
      stacks.get(modelId)?.some(mutation => commandIds.has(mutation.id)))) {
    throw new Error('Appearance history contains missing or already recorded mutations.');
  }
  let committed = false;
  return (publication = {}) => {
    if (committed) return finalMutation;
    committed = true;
    let registry = registries.get(store.getState);
    if (!registry) {
      registry = { entries: new Map(), unsubscribe: () => {}, replaying: false };
      const owned = registry;
      registry.unsubscribe = store.subscribe((current, previous) => {
        if (current.undoStacks !== previous.undoStacks || current.redoStacks !== previous.redoStacks
          || current.mutationViews !== previous.mutationViews) prune(store, owned);
      });
      registries.set(store.getState, registry);
    }
    registry.entries.set(finalMutation.id, { modelId, view, command });
    store.setState(current => ({
      ...publication,
      undoStacks: new Map(current.undoStacks).set(modelId, [...(current.undoStacks.get(modelId) ?? []), finalMutation]),
      redoStacks: new Map(current.redoStacks).set(modelId, []),
      dirtyModels: new Set(current.dirtyModels).add(modelId),
      mutationVersion: current.mutationVersion + 1,
    }));
    return finalMutation;
  };
}

/** Called before generic mutation replay; a failed command never advances either stack. */
export function replayAppearanceHistory(
  store: StoreApi<ViewerState>, modelId: string, direction: 'undo' | 'redo',
): boolean {
  const registry = registries.get(store.getState);
  if (!registry) return false;
  const source = direction === 'undo' ? 'undoStacks' : 'redoStacks';
  const destination = direction === 'undo' ? 'redoStacks' : 'undoStacks';
  const mutation = store.getState()[source].get(modelId)?.at(-1);
  const entry = mutation && registry.entries.get(mutation.id);
  if (!entry || entry.modelId !== modelId) return false;
  if (registry.replaying) throw new Error('An appearance history command is already replaying.');
  registry.replaying = true;
  let publication: AppearanceHistoryPublication | void;
  try { publication = entry.command.replay(direction); }
  finally { registry.replaying = false; }
  store.setState(state => ({
    ...publication,
    [source]: new Map(state[source]).set(modelId, state[source].get(modelId)!.slice(0, -1)),
    [destination]: new Map(state[destination]).set(modelId, [...(state[destination].get(modelId) ?? []), mutation]),
    mutationVersion: state.mutationVersion + 1,
  }));
  return true;
}
