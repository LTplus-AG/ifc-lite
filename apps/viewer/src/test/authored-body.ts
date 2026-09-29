/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only reader for what a placing command wrote (#6232): the live overlay
 * elements of some IFC classes, each with its body representation walked
 * Product → IfcProductDefinitionShape → IfcShapeRepresentation →
 * IfcExtrudedAreaSolid → profile, so a test can assert the class and the
 * representation in one place.
 */

import { useViewerStore } from '@/store';

export interface AuthoredBody {
  readonly expressId: number;
  /** Upper-case IFC class, `IFCROOF`. */
  readonly cls: string;
  /** `Body` / `SweptSolid`. */
  readonly identifier: string;
  readonly representationType: string;
  /** The single body item's class, `IFCEXTRUDEDAREASOLID`. */
  readonly solid: string;
  /** Its profile's class, `IFCRECTANGLEPROFILEDEF` or `IFCARBITRARYCLOSEDPROFILEDEF`. */
  readonly profile: string;
  /** The extrusion depth, native units. */
  readonly depth: number;
}

/** Every live overlay element of `classes` (upper-case), in creation order. */
export function authoredBodies(modelId: string, classes: readonly string[]): AuthoredBody[] {
  const view = useViewerStore.getState().mutationViews.get(modelId)!;
  const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
  const ref = (v: unknown) => byId.get(Number(String(v).slice(1)))!;
  return view.getNewEntities()
    .filter((e) => classes.includes(e.type.toUpperCase()) && !view.isDeleted(e.expressId))
    .map((e) => {
      const shape = ref(e.attributes[6]);
      const items = shape.attributes[2] as string[];
      const rep = ref(items[0]);
      const solid = ref((rep.attributes[3] as string[])[0]);
      return {
        expressId: e.expressId,
        cls: e.type.toUpperCase(),
        identifier: String(rep.attributes[1]),
        representationType: String(rep.attributes[2]),
        solid: solid.type.toUpperCase(),
        profile: ref(solid.attributes[0]).type.toUpperCase(),
        depth: solid.attributes[3] as number,
      };
    });
}
