/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { ModelTranslations } from './model-translation.js';
import { extractEntityFromMergedMesh } from './merged-mesh-extract.js';

/** Links transient extracted/merged geometry back to its bucket-owned source. */
export class DerivedMeshProvenance {
  private sources = new WeakMap<MeshData, MeshData>();

  sourceFor(meshData: MeshData): MeshData {
    let source = meshData;
    let parent: MeshData | undefined;
    while ((parent = this.sources.get(source))) source = parent;
    return source;
  }

  /** Resolve before placement so the returned object is the identity stored in
   * Scene's live bucket reverse index, including after a model move/restore. */
  placedSourceFor(meshData: MeshData, translations: ModelTranslations): MeshData {
    return translations.placeMesh(this.sourceFor(meshData));
  }

  extract(merged: MeshData, expressId: number): MeshData | undefined {
    const extracted = extractEntityFromMergedMesh(merged, expressId);
    if (extracted) this.sources.set(extracted, this.sourceFor(merged));
    return extracted;
  }

  remember(derived: MeshData, source: MeshData): void {
    this.sources.set(derived, this.sourceFor(source));
  }
}
