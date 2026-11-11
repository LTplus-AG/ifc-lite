/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AlignGeometryProvider } from '@ifc-lite/sdk';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { StepExporter } from '@ifc-lite/export';
import { IfcParser } from '@ifc-lite/parser';
import { planBoxOf, storeyPlanFrame, roomFramePlanOffsets, roomFrameToModelWorld, toStoreyLocal, type PlanBox } from '@ifc-lite/create';

/** Prepare actual current-overlay meshes, including cuts and placements. */
export const provideCliAlignGeometry: AlignGeometryProvider = async (model, storeyId, ids) => {
  const bytes = new StepExporter(model.store, model.mutationView).export({ schema: model.store.schemaVersion ?? 'IFC4', applyMutations: true }).content;
  const source = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const plan = storeyPlanFrame(source, storeyId);
  if (!plan) throw new Error('Align storey placement is not a supported upright plane');
  const processor = new GeometryProcessor({ enableInstancing: false });
  try {
    await processor.init();
    const { meshes, coordinateInfo } = await processor.process(bytes);
    const { cx, cy } = roomFramePlanOffsets(coordinateInfo), { dx, dy } = roomFrameToModelWorld(coordinateInfo);
    const boxes = new Map<number, PlanBox>();
    for (const id of ids) {
      const box = planBoxOf(meshes, id, { renderToLocal: ([x, y, z]) => {
        const [u, v] = toStoreyLocal(plan, [x + cx + dx, -z + cy + dy]);
        return [u, v, y];
      } });
      if (box) boxes.set(id, box);
    }
    return boxes;
  } finally { processor.dispose(); }
};
