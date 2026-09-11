/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { textureUrlBasename } from '@/utils/textureResources.js';
import { AuthoredResourceLifecycle } from './authored-resource-lifecycle.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import { AppearanceAssetInventory, AppearanceAssetError, type AppearanceBitmap } from './assets.js';

interface ArchiveImages {
  originalResources: Map<string, Uint8Array>;
  modelPath?: string;
  resourcesIncomplete?: boolean;
}
interface ModelImages {
  paths: Map<string, string>;
  modelPath?: string;
  refused: string[];
  incomplete: boolean;
}

// Strip file-supplied control bytes before placing archive paths in notices.
// eslint-disable-next-line no-control-regex
function displayPath(path: string): string { return path.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160); }

/** Original bytes belong to the model, independently of uploaded GPU copies. */
export class ModelAppearanceAssets<B extends AppearanceBitmap = ImageBitmap> {
  private models = new Map<string, ModelImages>();
  private authored = new Map<string, Map<string, Set<string>>>();
  readonly authoredLifecycle = new AuthoredResourceLifecycle(
    (modelId, commandId) => this.unregisterAuthored(modelId, commandId),
    (modelId, commandId) => [...this.authored.get(modelId)?.get(commandId) ?? []].map(id => this.getAuthoredUri(modelId, id)),
  );
  private pending = new Map<string, { cancel(): void }>();
  private settling = new Map<string, Array<() => void>>();
  constructor(readonly inventory: AppearanceAssetInventory<B>) {}

  /**
   * The in-flight source decode for a model, if any: resolves once it finishes
   * or is cancelled. The loader publishes a model before its images settle, so
   * a panel that saw "still loading" can retry instead of staying stuck (#4477).
   */
  pendingDecode(modelId: string): Promise<void> | undefined {
    if (!this.pending.has(modelId)) return undefined;
    return new Promise(resolve => {
      const waiters = this.settling.get(modelId) ?? [];
      waiters.push(resolve);
      this.settling.set(modelId, waiters);
    });
  }

  /** Begin before decode so model removal can cancel a late decoder. */
  begin(modelId: string) {
    this.pending.get(modelId)?.cancel();
    const owner = { kind: 'source' as const, id: crypto.randomUUID() };
    const controller = new AbortController();
    const images: ModelImages = { paths: new Map(), refused: [], incomplete: false };
    let finished = false;
    let finalizing: Promise<void> | undefined;
    const cancel = () => {
      if (finished) return;
      finished = true;
      controller.abort();
      this.inventory.releaseOwner(owner);
      if (this.pending.get(modelId) === lease) {
        this.pending.delete(modelId);
        const waiters = this.settling.get(modelId) ?? [];
        this.settling.delete(modelId);
        for (const resolve of waiters) resolve();
      }
    };
    const lease = {
      cancel,
      decode: async (archive: ArchiveImages): Promise<Map<string, B> | null> => {
        images.modelPath = archive.modelPath;
        images.incomplete = archive.resourcesIncomplete === true;
        const bitmaps = new Map<string, B>();
        const seenBasenames = new Set<string>();
        // Sequential decode bounds the number of pending browser allocations.
        for (const [path, bytes] of archive.originalResources) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const basename = path.split('/').pop()!.toLowerCase();
          const useBitmap = !seenBasenames.has(basename);
          seenBasenames.add(basename);
          try {
            const asset = await this.inventory.add(bytes, { owner, signal: controller.signal });
            images.paths.set(path, asset.id);
            if (useBitmap) {
              bitmaps.set(basename, await this.inventory.decode(asset.id, owner, controller.signal));
            }
          } catch (error) {
            if (controller.signal.aborted || (error instanceof AppearanceAssetError && error.code === 'budget')) throw error;
            // Retained but undecodable originals are still exportable.
            if (!images.paths.has(path)) images.refused.push(path);
            console.warn(`[textures] Cannot use IFCZIP image "${displayPath(path)}"`, error);
          }
        }
        return bitmaps.size ? bitmaps : null;
      },
      /** The primary loader returns before its background metadata finalizer. */
      finishAfter: (finalization: Promise<unknown>, getModel: () => { ifcDataStore: IfcDataStore | null } | undefined): Promise<void> => {
        if (finalizing) return finalizing;
        if (finished) return Promise.resolve();
        const finishCurrentModel = () => {
          if (!finished) lease.finish(getModel()?.ifcDataStore != null);
        };
        finalizing = finalization.then(finishCurrentModel, error => {
          console.warn('[textures] Appearance load finalization failed:', error);
          finishCurrentModel(); // A retained partial IFC source is still exportable.
        }).catch(error => {
          console.warn('[textures] Cannot retain finalized appearance resources:', error);
          cancel();
        });
        return finalizing;
      },
      /** Model-local parsed source remains exportable without any flat meshes. */
      finishForModel: (model: { ifcDataStore: IfcDataStore | null } | undefined) => {
        if (!finalizing) lease.finish(model?.ifcDataStore != null);
      },
      /** Retain only while a loaded model owns it. */
      finish: (modelExists: boolean) => {
        if (finished) return;
        if (modelExists) {
          const modelOwner = { kind: 'model' as const, id: modelId };
          // A replacement source may share assets with the old source: retain
          // first, then release only ids no longer referenced by this model.
          const old = this.models.get(modelId);
          for (const id of images.paths.values()) this.inventory.retain(id, modelOwner);
          const retained = new Set(images.paths.values());
          for (const id of old?.paths.values() ?? []) {
            if (!retained.has(id) && ![...this.authored.get(modelId)?.values() ?? []].some(ids => ids.has(id))) this.inventory.release(id, modelOwner);
          }
          this.models.set(modelId, images);
        }
        cancel();
      },
    };
    this.pending.set(modelId, lease);
    return lease;
  }

  /** Cheap output-label hint; exportResources still validates readiness/completeness. */
  hasResources(modelId: string): boolean {
    if (this.models.get(modelId)?.paths.size) return true;
    for (const ids of this.authored.get(modelId)?.values() ?? []) if (ids.size) return true;
    return false;
  }

  /** The IFC entry must keep modelPath so its relative URLReferences resolve. */
  exportOriginals(modelId: string): { modelPath?: string; resources: Map<string, Uint8Array> } {
    if (this.pending.has(modelId)) throw new AppearanceAssetError('missing', 'Texture images are still loading. Wait for model loading to finish before exporting.');
    const images = this.models.get(modelId);
    if (images?.incomplete) {
      throw new AppearanceAssetError('missing', 'Cannot export all original textures: the archive exceeded image extraction limits. Reduce image count or size and reload the archive.');
    }
    if (images?.refused.length) {
      throw new AppearanceAssetError('missing', `Cannot export all original textures: ${images.refused.slice(0, 8).map(displayPath).join(', ')}. Reload smaller supported PNG/JPEG images.`);
    }
    const resources = new Map<string, Uint8Array>();
    for (const [path, id] of images?.paths ?? []) resources.set(path, this.inventory.encoded(id));
    return { modelPath: images?.modelPath, resources };
  }
  /** Resolve the original image used by a loaded mesh before copying a capture.
   * Ambiguous basename matches cannot certify which original was displayed. */
  resolveImageAsset(modelId: string, imageUri: string): string {
    if (this.pending.has(modelId)) throw new AppearanceAssetError('missing', 'Texture images are still loading.');
    const basename = textureUrlBasename(imageUri);
    const candidates = new Set<string>();
    for (const [path, id] of this.models.get(modelId)?.paths ?? []) {
      if (textureUrlBasename(path) === basename) candidates.add(id);
    }
    for (const ids of this.authored.get(modelId)?.values() ?? []) for (const id of ids) {
      if (textureUrlBasename(this.getAuthoredUri(modelId, id)) === basename) candidates.add(id);
    }
    if (candidates.size !== 1) throw new AppearanceAssetError('missing', candidates.size
      ? 'This texture filename matches different original images. Reload the capture with unique image filenames.'
      : 'The original texture image is missing. Reload the capture with its embedded or packaged images.');
    return candidates.values().next().value!;
  }

  /** Pure preparation: the IFC URL is relative to its entry directory. */
  getAuthoredUri(modelId: string, assetId: string): string {
    const asset = this.inventory.get(assetId);
    if (!asset) throw new AppearanceAssetError('missing', 'This image was released. Choose the source image again.');
    const basename = asset.exportName.split('/').pop()!;
    for (const [path, id] of this.models.get(modelId)?.paths ?? []) {
      if (path.split('/').pop()?.toLowerCase() === basename && id !== assetId) {
        throw new AppearanceAssetError('format', 'An imported texture uses this image filename for different content. Rename that archive resource before applying appearance.');
      }
    }
    return asset.exportName;
  }

  /** One lease per active appearance command; history owns its own redo lease. */
  registerAuthored(modelId: string, commandId: string, assetIds: Iterable<string>): void {
    if (!commandId) throw new AppearanceAssetError('owner', 'Appearance changes need a command identifier.');
    const ids = new Set(assetIds);
    for (const id of ids) this.getAuthoredUri(modelId, id);
    const commands = this.authored.get(modelId) ?? new Map<string, Set<string>>();
    const previous = commands.get(commandId) ?? new Set<string>();
    for (const id of ids) this.inventory.retain(id, { kind: 'model', id: modelId });
    commands.set(commandId, ids);
    this.authored.set(modelId, commands);
    for (const id of previous) this.releaseUnused(modelId, id);
  }
  hasAuthoredRegistration(modelId: string, commandId: string): boolean {
    return this.authored.get(modelId)?.has(commandId) ?? false;
  }
  releaseAuthoredIfUnreferenced(modelId: string, commandId: string, imageUris: ReadonlySet<string>): void {
    const retained = new Set([...imageUris].map(textureUrlBasename));
    for (const id of this.authored.get(modelId)?.get(commandId) ?? []) {
      if (retained.has(textureUrlBasename(this.getAuthoredUri(modelId, id)))) return;
    }
    this.unregisterAuthored(modelId, commandId);
  }
  unregisterAuthored(modelId: string, commandId: string): void {
    const commands = this.authored.get(modelId);
    const ids = commands?.get(commandId);
    commands?.delete(commandId);
    if (commands?.size === 0) this.authored.delete(modelId);
    for (const id of ids ?? []) this.releaseUnused(modelId, id);
  }
  exportResources(modelId: string, retainedImageUris?: ReadonlySet<string>): { modelPath?: string; resources: Map<string, Uint8Array> } {
    const result = this.exportOriginals(modelId);
    const retained = retainedImageUris && new Set([...retainedImageUris].map(textureUrlBasename));
    const folder = result.modelPath?.slice(0, result.modelPath.lastIndexOf('/') + 1) ?? '';
    for (const ids of this.authored.get(modelId)?.values() ?? []) {
      for (const id of ids) {
        const uri = this.getAuthoredUri(modelId, id);
        if (retained && !retained.has(textureUrlBasename(uri))) continue;
        const path = folder + uri;
        if (!result.resources.has(path)) result.resources.set(path, this.inventory.encoded(id));
      }
    }
    return result;
  }
  private releaseUnused(modelId: string, assetId: string): void {
    if ([...this.models.get(modelId)?.paths.values() ?? []].includes(assetId)) return;
    for (const ids of this.authored.get(modelId)?.values() ?? []) if (ids.has(assetId)) return;
    this.inventory.release(assetId, { kind: 'model', id: modelId });
  }
  remove(modelId: string): void {
    this.authoredLifecycle.remove(modelId);
    this.pending.get(modelId)?.cancel();
    this.models.delete(modelId);
    this.authored.delete(modelId);
    this.inventory.releaseOwner({ kind: 'model', id: modelId });
  }
  clear(): void {
    this.authoredLifecycle.clear();
    for (const pending of this.pending.values()) pending.cancel();
    for (const modelId of new Set([...this.models.keys(), ...this.authored.keys()])) this.remove(modelId);
  }
}

export const appearanceAssets = new AppearanceAssetInventory();
export const modelAppearanceAssets = new ModelAppearanceAssets(appearanceAssets);
