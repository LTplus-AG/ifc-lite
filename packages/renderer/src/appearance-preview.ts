/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { equivalentAppearanceGeometry } from './appearance-uvs.js';

/** expressId is already federation-resolved; modelIndex is the renderer model. */
export interface AppearanceOwner {
  readonly expressId: number;
  readonly modelIndex: number;
}
export interface AppearanceToken {
  readonly owner: AppearanceOwner;
}
export interface AppearanceChange {
  readonly owner: AppearanceOwner;
  readonly before: readonly MeshData[];
  readonly after: readonly MeshData[];
  readonly beforeInstanced?: true;
  readonly afterInstanced?: true;
  /** Explicit occurrence-local representation changes, captured before preview. */
  readonly geometryItemRemaps?: readonly { readonly from: number; readonly to: number }[];
}
export interface AppearancePreviewOptions extends Pick<AppearanceChange, 'geometryItemRemaps'> {
  /** Canonical native originals for an occurrence absent from flat scene geometry. */
  readonly materializedOriginals?: readonly MeshData[];
}
export interface AppearancePreview {
  /** Requires finalized resident geometry, or canonical materializedOriginals
   * for one retained GPU occurrence. */
  begin(owner: AppearanceOwner, options?: AppearancePreviewOptions): AppearanceToken;
  /** Full part list in source order. Geometry must preserve exact triangle corners.
   * Mesh arrays are borrowed immutable data, including image pixels and UVs. */
  update(token: AppearanceToken, parts: readonly MeshData[]): void;
  /** Current canonical parts, including retained originals when an instance is active. */
  getParts?(owner: AppearanceOwner): readonly MeshData[] | undefined;
  /** Retain an original occurrence for one host history command; release on disposal. */
  retainSource?(owner: AppearanceOwner): () => void;
  cancel(token: AppearanceToken): void;
  commit(token: AppearanceToken): AppearanceChange;
  /** Validate a whole command before consuming any owner; returned commit is idempotent. */
  prepareCommit(tokens: readonly AppearanceToken[]): () => AppearanceChange[];
}
export interface AppearanceAdapter<Resource> {
  capture(owner: AppearanceOwner, originals?: readonly MeshData[]): {
    parts: readonly MeshData[];
    resources: readonly Resource[];
    abandon?(): void;
  };
  instanced?(owner: AppearanceOwner, parts: readonly MeshData[]): boolean;
  parts?(owner: AppearanceOwner): readonly MeshData[] | undefined;
  retainSource?(owner: AppearanceOwner): () => void;
  stage(parts: readonly MeshData[]): readonly Resource[];
  install(
    owner: AppearanceOwner,
    parts: readonly MeshData[],
    resources: readonly Resource[],
  ): void;
  release(resources: readonly Resource[]): void;
  finished?(owner: AppearanceOwner): void;
  forget?(expressId?: number): void;
  prepareRebuild?(geometry: readonly MeshData[], models: ReadonlySet<number>): Set<number>;
  finishRebuild?(retained: ReadonlySet<number>): void;
  discardedForRebuild?(retained: ReadonlySet<number>): readonly number[];
}
interface Draft<Resource> {
  token: AppearanceToken;
  before: readonly MeshData[];
  original: readonly Resource[];
  after: readonly MeshData[];
  current: readonly Resource[];
  geometryItemRemaps: NonNullable<AppearanceChange['geometryItemRemaps']>;
}

/** Owns detached GPU originals until cancellation/commit; never exports GPU handles. */
export class AppearancePreviewController<Resource>
  implements AppearancePreview
{
  private drafts = new Map<number, Draft<Resource>>();
  private issued = new WeakSet<AppearanceToken>();
  constructor(private readonly adapter: AppearanceAdapter<Resource>) {}

  begin(owner: AppearanceOwner, options?: AppearancePreviewOptions): AppearanceToken {
    if (this.drafts.has(owner.expressId))
      throw new Error('An appearance preview already owns this entity');
    const captured = this.adapter.capture(owner, options?.materializedOriginals);
    try {
      const remaps = options?.geometryItemRemaps ?? [];
      if (remaps.length > captured.parts.length) throw new Error('Appearance item remap exceeds the original part count');
      const originals = new Set(captured.parts.map(part => part.geometryItemId));
      const from = new Set<number>(), to = new Set<number>();
      for (const pair of remaps) {
        if (!Number.isSafeInteger(pair.from) || !Number.isSafeInteger(pair.to)
          || pair.from <= 0 || pair.to <= 0 || pair.from === pair.to
          || !originals.has(pair.from) || from.has(pair.from) || to.has(pair.to)
          || originals.has(pair.to)) throw new Error('Invalid occurrence geometry item remap');
        from.add(pair.from); to.add(pair.to);
      }
      const geometryItemRemaps = Object.freeze(remaps.map(pair => Object.freeze({ ...pair })));
      const token = Object.freeze({ owner: Object.freeze({ ...owner }) });
      const before = Object.freeze(
        captured.parts.map((part) => Object.freeze({ ...part })),
      );
      this.issued.add(token);
      this.drafts.set(owner.expressId, {
        token,
        before,
        original: captured.resources,
        after: before,
        current: captured.resources,
        geometryItemRemaps,
      });
      return token;
    } catch (error) { captured.abandon?.(); throw error; }
  }

  getParts(owner: AppearanceOwner): readonly MeshData[] | undefined { return this.adapter.parts?.(owner); }
  retainSource(owner: AppearanceOwner): () => void { return this.adapter.retainSource?.(owner) ?? (() => {}); }

  private draft(token: AppearanceToken): Draft<Resource> {
    const draft = this.drafts.get(token.owner.expressId);
    if (!draft || draft.token !== token)
      throw new Error('Stale or foreign appearance preview token');
    return draft;
  }

  update(token: AppearanceToken, parts: readonly MeshData[]): void {
    const draft = this.draft(token);
    if (parts.length !== draft.before.length)
      throw new Error('Appearance preview requires every original mesh part');
    const bitmapIds = new Map<number, ImageBitmap | undefined>();
    for (const old of draft.before)
      if (old.textureRef)
        bitmapIds.set(old.textureRef.textureId, old.textureBitmap);
    for (const old of draft.after)
      if (old.textureRef)
        bitmapIds.set(old.textureRef.textureId, old.textureBitmap);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i],
        b = draft.before[i];
      if (
        p.expressId !== b.expressId ||
        p.modelIndex !== b.modelIndex ||
        !equivalentAppearanceGeometry(p, b, { allowNormalChanges: true }) ||
        p.entityIds !== b.entityIds ||
        p.geometryItemId !== (draft.geometryItemRemaps.find(pair => pair.from === b.geometryItemId)?.to ?? b.geometryItemId) ||
        p.normals.length !== p.positions.length ||
        !p.normals.every(Number.isFinite)
      ) {
        throw new Error(
          'Appearance preview cannot change geometry or ownership',
        );
      }
      if (
        !p.texture &&
        p.textureRef &&
        p.textureBitmap &&
        bitmapIds.has(p.textureRef.textureId) &&
        bitmapIds.get(p.textureRef.textureId) !== p.textureBitmap
      ) {
        throw new Error('A replacement bitmap needs a new texture identity');
      }
      if (p.textureRef) bitmapIds.set(p.textureRef.textureId, p.textureBitmap);
      if (
        (p.texture || p.textureRef || p.textureBitmap) &&
        (!p.uvs ||
          p.uvs.length !== (p.positions.length / 3) * 2 ||
          !p.uvs.every(Number.isFinite) ||
          !(p.texture || (p.textureRef && p.textureBitmap)))
      ) {
        throw new Error(
          'Appearance preview requires finite UVs and a resolved image for every part',
        );
      }
    }
    const after = Object.freeze(
      parts.map((part, index) =>
        Object.freeze({
          ...draft.before[index],
          geometryItemId: part.geometryItemId,
          positions: part.positions,
          normals: part.normals,
          indices: part.indices,
          appearanceSource: part.appearanceSource,
          color: part.color,
          shadingColor: part.shadingColor,
          uvs: part.uvs,
          texture: part.texture,
          textureRef: part.textureRef,
          textureBitmap: part.textureBitmap,
        }),
      ),
    );
    // Stage may throw: no scene state has changed and originals remain alive.
    const resources = this.adapter.stage(after);
    try {
      this.adapter.install(token.owner, after, resources);
    } catch (error) {
      this.adapter.release(resources);
      throw error;
    }
    if (draft.current !== draft.original) this.adapter.release(draft.current);
    draft.after = after;
    draft.current = resources;
  }

  cancel(token: AppearanceToken): void {
    if (!this.issued.has(token))
      throw new Error('Foreign appearance preview token');
    if (this.drafts.get(token.owner.expressId)?.token !== token) return;
    const draft = this.draft(token);
    this.adapter.install(token.owner, draft.before, draft.original);
    if (draft.current !== draft.original) this.adapter.release(draft.current);
    this.drafts.delete(token.owner.expressId);
    this.finished(token.owner);
  }

  commit(token: AppearanceToken): AppearanceChange {
    return this.prepareCommit([token])()[0];
  }

  prepareCommit(tokens: readonly AppearanceToken[]): () => AppearanceChange[] {
    if (new Set(tokens).size !== tokens.length)
      throw new Error('Appearance commit repeats a token');
    const prepared = tokens.map((token) => {
      const draft = this.draft(token);
      return { draft, current: draft.current, after: draft.after };
    });
    const changes = prepared.map(({ draft, after }) =>
      Object.freeze({
        owner: draft.token.owner,
        before: draft.before,
        after,
        ...(this.adapter.instanced?.(draft.token.owner, draft.before) ? { beforeInstanced: true as const } : {}),
        ...(this.adapter.instanced?.(draft.token.owner, after) ? { afterInstanced: true as const } : {}),
        ...(draft.geometryItemRemaps.length ? { geometryItemRemaps: draft.geometryItemRemaps } : {}),
      }),
    );
    let committed = false;
    return () => {
      if (committed) return changes;
      // Every stale/reentrant change is rejected BEFORE consuming any token.
      for (const { draft, current, after } of prepared) {
        if (
          this.draft(draft.token) !== draft ||
          draft.current !== current ||
          draft.after !== after
        ) {
          throw new Error('Appearance changed after preparing the commit');
        }
      }
      for (const { draft } of prepared)
        this.drafts.delete(draft.token.owner.expressId);
      committed = true;
      // Resource disposal cannot roll back a committed model command. Report a
      // failed disposal independently and continue releasing the other owners.
      for (const { draft, current } of prepared) {
        if (current === draft.original) continue;
        try {
          this.adapter.release(draft.original);
        } catch (error) {
          console.warn(
            '[Appearance] failed to release committed preview resources',
            error,
          );
        }
      }
      for (const { draft } of prepared) this.finished(draft.token.owner);
      return changes;
    };
  }

  private finished(owner: AppearanceOwner): void {
    try {
      this.adapter.finished?.(owner);
    } catch (error) {
      console.warn(
        '[Appearance] batch restoration failed; split geometry remains active',
        error,
      );
    }
  }

  owns(expressId: number): boolean {
    return this.drafts.has(expressId);
  }

  /** End drafts, then validate every surviving history owner before GPU reset. */
  prepareRebuild(geometry: readonly MeshData[], models: ReadonlySet<number>): Set<number> {
    for (const draft of [...this.drafts.values()]) this.cancel(draft.token);
    return this.adapter.prepareRebuild?.(geometry, models) ?? new Set();
  }
  finishRebuild(retained: ReadonlySet<number>): void { this.adapter.finishRebuild?.(retained); }
  discardedForRebuild(retained: ReadonlySet<number>): readonly number[] { return this.adapter.discardedForRebuild?.(retained) ?? []; }

  /** Geometry edits supersede an uncommitted appearance draft. */
  cancelFor(expressId: number): void {
    const draft = this.drafts.get(expressId);
    if (draft) this.cancel(draft.token);
  }

  /** Scene deletion/teardown invalidates tokens and releases detached originals. */
  forget(expressId?: number): void {
    this.adapter.forget?.(expressId);
    for (const [id, draft] of this.drafts) {
      if (expressId !== undefined && expressId !== id) continue;
      if (draft.current !== draft.original)
        this.adapter.release(draft.original);
      this.drafts.delete(id);
    }
  }
}
