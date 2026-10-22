/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react';
import { exportSectionedStep, StepExporter, type SectionExportOptions, type MergeModelInput, type IfcSchemaVersion } from '@ifc-lite/export';
import { IfcParser } from '@ifc-lite/parser';
import { federationFrameInfo, renderFrameWorldOffset, viewerToIfcAxes } from '@ifc-lite/geometry/world-frame';
import { useViewerStore } from '@/store';
import { resolveClippingSectionInputs } from '@/lib/section/section-plane-inputs';
import { resolveKeptHalfSpace } from './view-pdf/view-section-plane';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from '@/i18n';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { rotateWorkspacePoint, workspacePointToModelFrame } from '@/lib/model-placement/rotation';

type State = ReturnType<typeof useViewerStore.getState>;

/** The renderer's complete half-space set, restored through the shared federation frame. */
export function sectionExportOptions(state: State, mode: 'trim' | 'whole', modelId?: string): SectionExportOptions | undefined {
  const inputs = resolveClippingSectionInputs(state);
  if (!inputs.length) return undefined;
  const frame = federationFrameInfo(state.models.values(), state.geometryResult);
  const planes = inputs.map(input => {
    const half = resolveKeptHalfSpace(input);
    const n = viewerToIfcAxes(half.normal);
    const placement = modelId ? { ...placementFor(state.modelPlacement, modelId), translation: displayedTranslation(state.modelPlacement, modelId) } : null;
    const sourceNormal = placement ? rotateWorkspacePoint([n.x,n.y,n.z], {angle:-placement.rotation.angle,pivot:[0,0,0]}) : [n.x,n.y,n.z] as const;
    const point = [n.x*half.offset,n.y*half.offset,n.z*half.offset] as const;
    const sourcePoint = placement ? workspacePointToModelFrame(point, placement) : point;
    const origin = renderFrameWorldOffset(frame);
    const offset = sourceNormal[0]*(sourcePoint[0]+origin.x) + sourceNormal[1]*(sourcePoint[1]+origin.y) + sourceNormal[2]*(sourcePoint[2]+origin.z);
    return { normal: sourceNormal, offset };
  });
  return { planes, mode };
}

export function useSectionExport(enabled: boolean) {
  const { t } = useTranslation();
  const [trim, setTrim] = useState(true);
  useViewerStore(state => state.sectionPlane);
  useViewerStore(state => state.inactiveSectionPlanes);
  useViewerStore(state => state.sceneState);
  const state = useViewerStore.getState();
  const active = enabled && sectionExportOptions(state, 'trim') !== undefined;
  return {
    options: (modelId?: string) => enabled ? sectionExportOptions(useViewerStore.getState(), trim ? 'trim' : 'whole', modelId) : undefined,
    control: active ? <div className="flex items-center justify-between">
      <div><Label htmlFor="trim-section-export">{t('exportDialog.trimSectionLabel')}</Label>
        <p className="text-xs text-muted-foreground">{t('exportDialog.trimSectionHint')}</p></div>
      <Switch id="trim-section-export" checked={trim} onCheckedChange={setTrim} />
    </div> : null,
  };
}

type MergeVisibility = { hidden: Map<string, Set<number>>; isolated: Map<string, Set<number> | null> };

/** Crop each source before merging; visibility is consumed in the original source namespace. */
export async function sectionMergeInputs(
  inputs: MergeModelInput[],
  visibility: MergeVisibility,
  schema: IfcSchemaVersion,
  optionsFor: (modelId: string) => SectionExportOptions | undefined,
): Promise<{ inputs: MergeModelInput[]; visibility: MergeVisibility }> {
  const result: MergeModelInput[] = [];
  const remainingVisibility = { hidden: new Map(visibility.hidden), isolated: new Map(visibility.isolated) };
  for (const input of inputs) {
    const options = optionsFor(input.id);
    if (!options) { result.push(input); continue; }
    const source = await new StepExporter(input.dataStore, input.mutationView).exportAsync({
      schema, visibleOnly: true, hiddenEntityIds: visibility.hidden.get(input.id), isolatedEntityIds: visibility.isolated.get(input.id),
    });
    const cropped = await exportSectionedStep(source.content, options);
    const buffer = new ArrayBuffer(cropped.content.byteLength);
    new Uint8Array(buffer).set(cropped.content);
    result.push({ ...input, mutationView: undefined, dataStore: await new IfcParser().parseColumnar(buffer, { disableWorkerScan: true }) });
    // The cropped store may reuse a removed product id for new geometry.
    // Its original selection was applied above and cannot filter this namespace.
    remainingVisibility.hidden.delete(input.id);
    remainingVisibility.isolated.delete(input.id);
  }
  return { inputs: result, visibility: remainingVisibility };
}
