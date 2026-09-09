/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { planAuthoredResourceCleanup } from '@ifc-lite/export';
import { textureUrlBasename } from '@/utils/textureResources.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue, MutablePropertyView, NewEntity } from '@ifc-lite/mutations';

export interface AuthoredResourceContext {
  dataStore: IfcDataStore;
  view: MutablePropertyView;
  isCurrent(): boolean;
  changed(): void;
  subscribe?(changed: () => void): () => void;
}
interface Command {
  created: ReadonlyArray<Pick<NewEntity, 'expressId' | 'type'>>;
  protectedValues: readonly IfcAttributeValue[];
  history: boolean;
}
interface Model {
  context: AuthoredResourceContext;
  commands: Map<string, Command>;
  queued: boolean;
  reconciling: boolean;
  unsubscribe?: () => void;
}

/** Owned by the model asset service; no independent singleton or ingest path. */
export class AuthoredResourceLifecycle {
  private models = new Map<string, Model>();
  constructor(
    private readonly unregister: (modelId: string, commandId: string) => void,
    private readonly registeredUris: (modelId: string, commandId: string) => Iterable<string>,
  ) {}

  track(modelId: string, commandId: string, context: AuthoredResourceContext,
    created: readonly NewEntity[], protectedValues: readonly IfcAttributeValue[]): void {
    let model = this.models.get(modelId);
    if (model && model.context.view !== context.view) {
      throw new Error('Appearance resources belong to a different model revision.');
    }
    if (!model) {
      model = { context, commands: new Map(), queued: false, reconciling: false };
      this.models.set(modelId, model);
      const owned = model;
      model.unsubscribe = context.subscribe?.(() => {
        if (!owned.reconciling) this.schedule(modelId, owned);
      });
    }
    model.commands.set(commandId, { created: created.map(({ expressId, type }) => ({ expressId, type })), protectedValues, history: true });
    this.schedule(modelId, model);
  }
  retire(modelId: string, commandId: string): void {
    const model = this.models.get(modelId), command = model?.commands.get(commandId);
    if (!model || !command) return;
    command.history = false;
    command.protectedValues = [];
    this.schedule(modelId, model);
  }
  forget(modelId: string, commandId: string): void {
    this.models.get(modelId)?.commands.delete(commandId);
  }
  remove(modelId: string): void {
    this.models.get(modelId)?.unsubscribe?.();
    this.models.delete(modelId);
  }
  clear(): void { for (const id of this.models.keys()) this.remove(id); }

  /** Serialization excludes history roots without changing live ownership. */
  serializationCandidates(modelId: string, dataStore: IfcDataStore, view: MutablePropertyView): Set<number> {
    const model = this.models.get(modelId);
    if (!model) return new Set();
    if (model.context.dataStore !== dataStore || model.context.view !== view || !model.context.isCurrent()) {
      throw new Error('Appearance resources belong to a different model revision.');
    }
    const result = new Set<number>();
    for (const command of model.commands.values()) for (const entity of command.created) result.add(entity.expressId);
    return result;
  }

  private schedule(modelId: string, model: Model): void {
    if (model.queued) return;
    model.queued = true;
    // History disposal runs inside Zustand publication. Reconcile afterward so
    // no housekeeping edit reenters Apply/replay's prepared IFC transaction.
    queueMicrotask(() => {
      model.queued = false;
      if (this.models.get(modelId) !== model) return;
      if (!model.context.isCurrent()) { this.remove(modelId); return; }
      model.reconciling = true;
      try { this.reconcile(modelId, model); }
      catch (error) { console.warn('[textures] Authored resource cleanup failed; resources retained:', error); }
      finally { model.reconciling = false; }
    });
  }
  private reconcile(modelId: string, model: Model): void {
    const { context } = model;
    if ([...model.commands.values()].every(command => command.history)) return;
    const candidates = new Set<number>();
    for (const command of model.commands.values()) {
      for (const entity of command.created) candidates.add(entity.expressId);
    }
    // Yield cheap creation-ID roots first, without flattening potentially large
    // history snapshots or passing their values as function arguments.
    function* protectedValues(): Iterable<IfcAttributeValue> {
      for (const command of model.commands.values()) if (command.history) {
        for (const entity of command.created) yield `#${entity.expressId}`;
      }
      for (const command of model.commands.values()) if (command.history) {
        yield* command.protectedValues;
      }
    }
    const plan = planAuthoredResourceCleanup(context.dataStore, context.view, candidates, protectedValues());
    const garbage = plan.entityIds;
    const retainedUris = new Set([...plan.retainedImageUris].map(textureUrlBasename));
    if (garbage.size) {
      const transaction = context.view.prepareAtomic(draft => {
        for (const id of garbage) draft.deleteEntity(id);
      });
      if (!context.isCurrent()) throw new Error('The model changed during authored resource cleanup.');
      transaction.commit();
    }
    // Release only after canonical IFC deletion succeeds. History owners are
    // independent and still retain undone commands' images for Redo.
    try {
      for (const [commandId, command] of model.commands) {
        const hasUri = [...this.registeredUris(modelId, commandId)].some(uri => retainedUris.has(textureUrlBasename(uri)));
        if (!hasUri) this.unregister(modelId, commandId);
        // An independently authored image can copy this URI without referencing
        // our original image ID. Keep tracking it until that final URI goes away.
        if (!command.history && !hasUri && !command.created.some(entity => context.view.getNewEntity(entity.expressId) !== null)) {
          model.commands.delete(commandId);
        }
      }
    } finally {
      // Publish only after IFC + asset ownership agree, even if bitmap disposal
      // itself failed. Never leave a changed IFC paired with an old revision.
      if (garbage.size) context.changed();
    }
    if (!model.commands.size) this.remove(modelId);
  }
}
