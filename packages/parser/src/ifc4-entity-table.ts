/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one sanctioned read of `@ifc-lite/data`'s `ENTITIES_IFC4` (#5204).
 *
 * `ENTITIES_IFC4` is generated from buildingSMART's C# `SchemaInfo` source,
 * and that source is wrong for IFC4 in two ways:
 *  - it files 24 entities from a draft alignment extension under IFC4
 *    (`IfcAlignment2DHorizontal`, `IfcLinearPlacement`, `IfcOffsetCurve`, …).
 *    IFC4's EXPRESS schema declares none of them;
 *  - it gives `IfcCartesianPointList2D`/`3D` an IFC4X3-only `TagList`.
 *
 * `ENTITIES_IFC4_EXPRESS` is that table checked against the EXPRESS-derived
 * IFC4 registry (`getSchemaRegistryForVersion('IFC4')`):
 *  - a row the registry declares keeps its C# metadata (`predefinedTypes`,
 *    `parent`, …) but takes its attribute list from the registry;
 *  - a row the registry does not declare is dropped when it carries
 *    attributes, because it describes an entity IFC4 does not have;
 *  - a row with no attributes is kept. These are the ~130 STEP defined types
 *    and selects the C# source lists alongside entities, which never appear as
 *    `#N=` records and are not the registry's to confirm.
 *
 * An oxlint `no-restricted-imports` rule (`.oxlintrc.json`) makes this the
 * only production import of `ENTITIES_IFC4`, so a new consumer cannot read the
 * uncorrected table by accident.
 */

import { ENTITIES_IFC4, type IfcEntityInfo } from '@ifc-lite/data';
import { getSchemaRegistryForVersion } from './generated/schema-registry-by-version.js';

export const ENTITIES_IFC4_EXPRESS: readonly IfcEntityInfo[] = (() => {
  const registry = getSchemaRegistryForVersion('IFC4').entities;
  const checked: IfcEntityInfo[] = [];
  for (const entity of ENTITIES_IFC4) {
    const meta = Object.hasOwn(registry, entity.name) ? registry[entity.name] : undefined;
    if (meta === undefined) {
      if (entity.attributes.length === 0) checked.push(entity);
      continue;
    }
    checked.push({ ...entity, attributes: (meta.allAttributes ?? meta.attributes).map((a) => a.name) });
  }
  return checked;
})();
