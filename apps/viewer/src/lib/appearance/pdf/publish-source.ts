/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { appearanceAssets } from '../model-assets.js';
import type { AppearanceSourceOption } from '../draft-types.js';
import type { PdfDerivedAppearance } from './source-document.js';
import { getPdfDocument } from './documents.js';

/** Transfer raster ownership to the source catalog, retaining document identity
 * across page/DPI/crop changes even when two different recipes produce equal pixels. */
export function publishPdfRaster(documentKey: string, raster: PdfDerivedAppearance): AppearanceSourceOption {
  const document = getPdfDocument(documentKey);
  if (!document || document.id !== raster.documentId) throw new Error('The PDF document was removed. Import it again.');
  const previous = useViewerStore.getState().appearanceSources.find(source => source.id === documentKey);
  const owner = { kind: 'source' as const, id: `appearance:${documentKey}` };
  const assetId = raster.asset.id;
  let url: string | undefined;
  try {
    appearanceAssets.retain(assetId, owner);
    url = URL.createObjectURL(new Blob([appearanceAssets.encoded(assetId)], { type: raster.asset.mimeType }));
    const source: AppearanceSourceOption = {
      id: documentKey, assetId, name: `${document.name} · page ${raster.recipe.page.pageNumber}`,
      width: raster.asset.width, height: raster.asset.height, thumbnailUrl: url,
      pdf: { documentKey, recipe: raster.recipe,
        calibration: previous?.pdf?.recipe.page.pageNumber === raster.recipe.page.pageNumber
          ? previous.pdf.calibration : undefined },
    };
    if (previous) useViewerStore.getState().updateAppearanceSource(source);
    else useViewerStore.getState().addAppearanceSource(source);
    return source;
  } finally {
    // Zustand subscribers may throw after publication. Inspect adopted state before cleanup.
    const adopted = useViewerStore.getState().appearanceSources.find(source => source.id === documentKey);
    if (url && adopted?.thumbnailUrl === url) {
      if (previous?.thumbnailUrl && previous.thumbnailUrl !== url) URL.revokeObjectURL(previous.thumbnailUrl);
      const previousAssetId = previous?.assetId ?? previous?.id;
      if (previousAssetId && previousAssetId !== assetId) appearanceAssets.release(previousAssetId, owner);
    } else {
      if ((previous?.assetId ?? previous?.id) !== assetId) appearanceAssets.release(assetId, owner);
      if (url) URL.revokeObjectURL(url);
    }
    document.releaseRaster(assetId);
  }
}
