/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { selectHasModelsLoaded } from '@/hooks/model-presence';
import { collectChangedModels, totalChangeCount } from '@/lib/export/model-changes';
import { hasRetainedGeometryModel, hasRetainedShapeOnlyModel,
  RETAINED_EXACT_ONLY_REASON, RETAINED_SHAPE_ONLY_REASON } from '@/store/retainedGeometry';
import type { RegisteredExportCommand } from './toolbar/export-commands';
import type { PaletteAvailability } from './palette-availability';

/** Recheck the export registry's prerequisites before palette telemetry/recents (#8947).
 * Format-specific configuration remains in the existing runner and dialogs. */
export function paletteExportAvailability(command: RegisteredExportCommand): PaletteAvailability {
  const s = useViewerStore.getState();
  const disabled = (reasonKey: Extract<PaletteAvailability, { status: 'disabled' }>['reasonKey']): PaletteAvailability =>
    ({ status: 'disabled', reasonKey });
  if (hasRetainedShapeOnlyModel(s.models) && ['glb', 'kmz', 'ion', 'usd'].includes(command.id)) {
    return disabled(RETAINED_SHAPE_ONLY_REASON);
  }
  if (hasRetainedGeometryModel(s.models) && ['usd', 'energy', 'ion'].includes(command.id)) {
    return disabled(RETAINED_EXACT_ONLY_REASON);
  }
  if (command.requires === 'dataStore' && !s.ifcDataStore) return disabled('commandPalette.availability.ifc');
  if (command.id === 'csv' && !(s.ifcDataStore && s.ifcDataStore.source.byteLength > 0)) {
    return disabled('commandPalette.availability.ifc');
  }
  if (command.requires === 'changes' && totalChangeCount(collectChangedModels(s)) === 0) {
    return disabled('commandPalette.export.unavailable');
  }
  if (command.requires === 'model' && !selectHasModelsLoaded(s) && !s.ifcDataStore) {
    return disabled('commandPalette.availability.model');
  }
  return { status: 'available' };
}
