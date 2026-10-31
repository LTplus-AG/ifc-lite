/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Public declarations; the implementation lives in Rust (#8042).
export interface PropertyEntryInput {
  name: string;
  value: unknown;
}

export interface PropertySetInput {
  name: string;
  properties: PropertyEntryInput[];
}

export interface QuantitySetInput {
  name: string;
  quantities: PropertyEntryInput[];
}

export interface TypeAssignmentInput {
  /**
   * The type entity's `GlobalId`.
   *
   * **Not hashed, and not a stable key.** `IfcTypeObject` is an `IfcRoot`
   * subtype, so a from-scratch re-export regenerates the *type's* GlobalId
   * exactly as it regenerates every product's. Folding it into the fingerprint
   * made the content hash of every typed element — most of a real model —
   * change on a re-export where nothing substantive did, which defeats
   * `matchUnpairedByContent`, the pass that exists for precisely that
   * scenario. The assigned type is identified by {@link name} +
   * {@link type} instead; see {@link buildDataFingerprint}.
   *
   * The field is kept because callers already populate it and it is useful for
   * display and for resolving the type entity, but it does not participate in
   * any hash this module produces.
   */
  globalId?: string;
  /** Name of the assigned type (e.g. `WT-200`). Part of its hashed identity. */
  name?: string;
  /** IFC type name of the assigned type (e.g. `IfcWallType`). Part of its hashed identity. */
  type?: string;
}

export interface DataFingerprintInput {
  ifcType: string;
  name?: string;
  description?: string;
  objectType?: string;
  predefinedType?: string;
  /**
   * The entity's `Tag`, and **only for a type object** (issue #2021).
   *
   * A type object carries no geometry hash, so its data fingerprint is the
   * whole of the evidence a content match has about it. That was not enough on
   * real files: Duplex has eight `IfcFurnitureType` entities all named
   * `'800 mm'`, identical in every other attribute this hashes and separable
   * only by `Tag` (`'157200'`, `'157607'`, …), so they landed in one bucket and
   * the engine correctly abstained on all of them. Hashing `Tag` gives that
   * bucket the discriminator it was missing.
   *
   * **An occurrence's `Tag` must NOT be supplied here, and the shipped adapters
   * do not.** `IfcElement.Tag` is the authoring tool's own element id (Revit
   * writes its ElementId). It is not a property of the design, it is a property
   * of the file's producer — so two tools exporting one design disagree on it
   * for every element, and `dataHash` is the bucket key, which means an
   * occurrence whose `Tag` moved cannot content-match at all. That is exactly
   * the re-export scenario `matchUnpairedByContent` exists for, and an
   * occurrence has a geometry hash to be separated by anyway. The same argument
   * is why the assigned type's `GlobalId` is not hashed; see
   * {@link TypeAssignmentInput.globalId}.
   *
   * The blast radius is contained to the type object itself: type *assignments*
   * project only {@link TypeAssignmentInput.name} and
   * {@link TypeAssignmentInput.type}, so re-tagging a type does not move the
   * fingerprint of a single element assigned to it.
   */
  tag?: string;
  propertySets?: PropertySetInput[];
  quantitySets?: QuantitySetInput[];
  typeAssignments?: TypeAssignmentInput[];
  /**
   * The entity's **resolved material NAMES**. Missing from this projection
   * entirely before, so a re-specified element (measured: `Soil1` ->
   * `topsoil` on an infrastructure pair) read as unchanged in every channel.
   *
   * **Names, never entity references** — an `IfcMaterial`'s express id is
   * reassigned on every save, so comparing references flags every re-exported
   * element. Same argument that keeps {@link TypeAssignmentInput.globalId}
   * out of the hash, and a material is not even an `IfcRoot`, so its id is
   * the only thing a reference comparison could see.
   *
   * **Resolve through every indirection before supplying this**: the usage /
   * set / list wrappers (`IfcMaterialLayerSetUsage`, `IfcMaterialLayerSet`,
   * `IfcMaterialProfileSet`, `IfcMaterialConstituentSet`, `IfcMaterialList`,
   * and their layer/profile/constituent members), down to `IfcMaterial.Name`
   * at the leaf. The shipped viewer adapter does this via
   * `extractAllMaterialsOnDemand` + `lensMaterialNames`; reading only a
   * directly attached `IfcMaterial` silently under-reports on any layered
   * element. Order is irrelevant (sorted here), and an empty array is
   * identical to omitting the field: both say "no material named".
   */
  materials?: string[];
  /**
   * The entity's resolved **classification references**, each projected to a
   * single string (e.g. `system:identification`). Same reasoning as
   * {@link materials}: missing from this projection entirely was the prior
   * state, so a re-classified element (re-coded from one Uniclass group to
   * another, geometry and every property untouched) read as unchanged
   * everywhere — a classification edit touches none of `propertySets`,
   * `quantitySets` or `materials`. Resolve through the full
   * `IfcRelAssociatesClassification` -> `IfcClassificationReference` chain
   * before supplying this; order is irrelevant, and `[]` == omitted.
   */
  classifications?: string[];
}

/**
 * Per-component fingerprint keys. Aligned with the layer op model
 * (docs/architecture/layer-prs/02-layer-format.md §2.2) so diff keys and
 * op keys share one vocabulary:
 *
 * - `attr:core`        — direct attributes (Name, Description, ObjectType,
 *                        PredefinedType, Tag) + the IFC type itself
 * - `pset:<PsetName>`  — one hash per property set; a later set of the same
 *                        name is `pset#2:<PsetName>`, `pset#3:…` (#8136)
 * - `qset:<QsetName>`  — one hash per quantity set, numbered the same way
 * - `type-assignment`  — assigned type entities, by name + IFC class
 * - `material`         — resolved material names (see
 *                        {@link DataFingerprintInput.materials})
 * - `classification`   — resolved classification references (see
 *                        {@link DataFingerprintInput.classifications})
 */
export type ComponentKey = string;
