/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { resolveScheduleSourceModelId } from '@/store/slices/schedule-edit-helpers';
import type { FederatedModel } from '@/store/types';
import type { GenerateModelContext } from './generate-schedule.js';

/** Mesh inputs for the geometry-slice schedule strategy, scoped to one model. */
export function useScheduleGeometryContext(
  models: ReadonlyMap<string, FederatedModel>,
  activeModelId: string | null,
): GenerateModelContext | null {
  return useMemo(() => {
    const sourceModelId = resolveScheduleSourceModelId(models, activeModelId);
    if (!sourceModelId) return null;
    const model = models.get(sourceModelId);
    const meshes = model?.geometryResult?.meshes;
    if (!meshes || meshes.length === 0) return null;
    return { meshes, idOffset: model?.idOffset ?? 0 };
  }, [models, activeModelId]);
}
