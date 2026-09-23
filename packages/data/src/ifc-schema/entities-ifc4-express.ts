/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IFC4 entity table checked against the IFC4 EXPRESS schema (#5204).
 *
 * `ENTITIES_IFC4` is generated from buildingSMART's C# `SchemaInfo` source,
 * which files the draft alignment-extension entities (`IfcAlignment2DHorizontal`,
 * `IfcLinearPlacement`, `IfcOffsetCurve`, …) under IFC4 and gives
 * `IfcCartesianPointList2D`/`3D` an IFC4X3-only `TagList`. This table:
 *  - drops the rows that carry attributes but that IFC4 EXPRESS does not declare;
 *  - takes the EXPRESS attribute list, parent and abstractness where the two
 *    disagree (the C# table parents `IfcOffsetCurve2D` under the IFC4X3-only
 *    `IfcOffsetCurve`; IFC4 parents it under `IfcCurve`);
 *  - keeps everything else, including the attribute-less defined-type and
 *    select rows, which are not the EXPRESS entity registry's to confirm.
 *
 * The corrections are generated from `@ifc-lite/parser`'s EXPRESS-derived
 * registry (`scripts/generate-ifc4-express-corrections.mjs`, `--check` in CI),
 * because this package cannot import parser at runtime.
 *
 * Every schema-specific IFC4 reader uses this table, including this package's
 * own `getEntities('IFC4')` / `findEntity('IFC4', …)`. An oxlint
 * `no-restricted-imports` rule (`.oxlintrc.json`) keeps new code off the raw
 * `ENTITIES_IFC4`.
 */

import type { IfcEntityInfo } from './types.js';
import { ENTITIES_IFC4 } from './generated/entities-ifc4.js';
import { IFC4_EXPRESS_OVERRIDES, IFC4_UNDECLARED_ENTITIES } from './ifc4-express-corrections.js';

export const ENTITIES_IFC4_EXPRESS: readonly IfcEntityInfo[] = ENTITIES_IFC4
  .filter((entity) => !IFC4_UNDECLARED_ENTITIES.has(entity.name))
  .map((entity) => (Object.hasOwn(IFC4_EXPRESS_OVERRIDES, entity.name) ? { ...entity, ...IFC4_EXPRESS_OVERRIDES[entity.name] } : entity));
