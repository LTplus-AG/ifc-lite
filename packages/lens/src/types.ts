/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/lens — Rule-based 3D filtering and colorization
 *
 * A lens is a collection of rules that match entities by IFC class, property
 * value, material name, attribute, quantity, or classification, then apply a
 * visual action (colorize, hide, or make transparent). Unmatched entities are
 * ghosted for context.
 *
 * Auto-color mode: given a data source (e.g. property column, attribute),
 * automatically discovers distinct values and assigns a unique color to each.
 *
 * Multi-model support: evaluation works across federated models using
 * global IDs. The {@link LensDataProvider} abstracts data access so
 * consumers can bridge any data source.
 */

// ============================================================================
// Data Provider Interface
// ============================================================================

/**
 * Abstract interface for accessing IFC entity data during lens evaluation.
 *
 * Consumers implement this to bridge their data source (IfcDataStore,
 * server API, IndexedDB, etc.) to the lens engine.
 */
export interface LensDataProvider {
  /** Total entity count (used for pre-allocation hints) */
  getEntityCount(): number;

  /**
   * Iterate all entities. The callback receives the global ID and the
   * model identifier for each entity.
   */
  forEachEntity(callback: (globalId: number, modelId: string) => void): void;

  /** Get the IFC class name for an entity (e.g. "IfcWall") */
  getEntityType(globalId: number): string | undefined;

  /**
   * Get a single property value by property-set name and property name.
   * Returns `undefined` when the property does not exist.
   */
  getPropertyValue(
    globalId: number,
    propertySetName: string,
    propertyName: string,
  ): unknown;

  /**
   * Get all property sets for an entity.
   * Used for material matching (scans psets whose name contains "material").
   */
  getPropertySets(globalId: number): PropertySetInfo[];

  /**
   * Get a single entity attribute by name (e.g. "Name", "Description",
   * "ObjectType", "Tag"). Optional — engine skips attribute criteria
   * when not implemented.
   */
  getEntityAttribute?(globalId: number, attrName: string): string | undefined;

  /**
   * Get a quantity value by quantity-set name and quantity name.
   * Returns the numeric or string value, or `undefined` if not found.
   */
  getQuantityValue?(
    globalId: number,
    qsetName: string,
    quantName: string,
  ): number | string | undefined;

  /**
   * Get classification references for an entity.
   * Returns an empty array when the entity has no classifications.
   */
  getClassifications?(globalId: number): ClassificationInfo[];

  /**
   * Get the material name for an entity.
   * Returns the top-level material name, or the first layer/constituent name.
   */
  getMaterialName?(globalId: number): string | undefined;

  /**
   * Get every distinct *individual* material name for an entity — each layer /
   * constituent / profile material of a multi-material element, or the single
   * material for a simple one. Unlike {@link getMaterialName} this does NOT
   * return the layer-set / usage name, so "color/select by material" groups by
   * the real materials and a multi-layer element belongs to each of them. (#1366)
   */
  getMaterialNames?(globalId: number): string[];

  /**
   * Get quantity sets for an entity (used for discovery).
   * Returns quantity set names and their quantity names.
   */
  getQuantitySets?(globalId: number): ReadonlyArray<{
    name: string;
    quantities: ReadonlyArray<{ name: string }>;
  }>;

  /**
   * Get the federated model identifier for an entity.
   * Optional — engine skips model criteria when not implemented.
   */
  getModelId?(globalId: number): string | undefined;

  /**
   * Get the display name for a model identifier (for legends and UI).
   * Optional — falls back to the raw modelId when not implemented.
   */
  getModelName?(modelId: string): string | undefined;

  /**
   * Get the groups/zones an entity is assigned to via IfcRelAssignsToGroup
   * (IfcZone, IfcGroup, IfcSystem). Used by the "group" criterion / auto-color
   * source to colour or isolate by zone membership. Optional — the engine skips
   * group criteria when not implemented (#1075).
   */
  getEntityGroups?(globalId: number): ReadonlyArray<{ id: number; name?: string; type: string; objectType?: string }>;
}

/** Property set returned by {@link LensDataProvider.getPropertySets} */
export interface PropertySetInfo {
  name: string;
  properties: ReadonlyArray<{
    name: string;
    value: unknown;
  }>;
}

/** Classification reference returned by {@link LensDataProvider.getClassifications} */
export interface ClassificationInfo {
  system?: string;
  identification?: string;
  name?: string;
}

// ============================================================================
// Lens Configuration Types
// ============================================================================

/** A single rule within a Lens */
export interface LensRule {
  id: string;
  name: string;
  enabled: boolean;
  groups?: import('@ifc-lite/rules').FilterGroup[];
  unreadableLegacy?: { criteria: unknown; reason: string };
  action: 'colorize' | 'hide' | 'transparent';
  /** Hex color for colorize/transparent actions (e.g. "#E53935") */
  color: string;
}
/**
 * Data source specification for automatic coloring.
 *
 * In auto-color mode, the engine iterates all entities, extracts the
 * specified value, groups by distinct values, and assigns a unique color
 * to each group. No manual rule authoring needed.
 */
export interface AutoColorSpec {
  source: 'ifcType' | 'attribute' | 'property' | 'quantity' | 'classification' | 'material' | 'model' | 'group';
  /**
   * Property/quantity set name — for source "property" or "quantity".
   * For source "classification" it acts as a classification-system filter
   * (case-insensitive substring match), selecting which reference to key off.
   */
  psetName?: string;
  /** Attribute, property, or quantity name */
  propertyName?: string;
  /**
   * Opt-in, `source: "classification"` only: give value-less entities a real
   * legend entry instead of silently ghosting them (#unclassified-bucket).
   *
   * Two absence reasons are distinguished whenever `psetName` (the
   * classification-system filter) is set, because they mean different things:
   * "No classification" (zero classification references at all) vs. "Not in
   * this system" (the entity has references, just none in the selected
   * system). Collapsing them would hide that distinction behind one number.
   * When `psetName` is unset there is no system to be "not in", so only "No
   * classification" is emitted.
   *
   * Default `false`/unset preserves the pre-existing behaviour exactly:
   * value-less entities are ghosted (`GHOST_COLOR`, no legend entry, no
   * count). This is deliberately opt-in, not a new default — an existing
   * saved lens (or a consumer relying on ghosted-and-invisible unclassified
   * elements) must not change appearance on upgrade.
   *
   * Forward compatibility: this field is additive. An engine build that
   * predates it does not read it, so an exported lens with
   * `includeUnclassified: true` opened in an older build silently falls back
   * to ghosting the absent entities — the pre-existing, safe behaviour —
   * rather than doing anything wrong with a field it doesn't understand.
   */
  includeUnclassified?: boolean;
}

/** A saved Lens configuration */
export interface Lens {
  id: string;
  name: string;
  rules: LensRule[];
  /** Built-in presets cannot be deleted */
  builtin?: boolean;
  /** Auto-color mode: color entities by distinct values from a data column */
  autoColor?: AutoColorSpec;
}

// ============================================================================
// Evaluation Result Types
// ============================================================================

/** RGBA color tuple with values in the 0–1 range */
export type RGBAColor = [number, number, number, number];

/** Result of lens evaluation */
export interface LensEvaluationResult {
  /** Global ID → RGBA color (includes ghost colors for unmatched entities) */
  colorMap: Map<number, RGBAColor>;
  /** Global IDs hidden by "hide" rules */
  hiddenIds: Set<number>;
  /** Rule ID → matched entity count */
  ruleCounts: Map<string, number>;
  /** Rule ID → matched entity global IDs (for isolation) */
  ruleEntityIds: Map<string, number[]>;
  /** Wall-clock evaluation time in milliseconds */
  executionTime: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Auto-color legend entry (synthetic rule for UI display) */
export interface AutoColorLegendEntry {
  id: string;
  name: string;
  color: string;
  count: number;
  /**
   * Set (`true`) only for a synthetic "absence" bucket — e.g. "No
   * classification" or "Not in this system" — rather than a real distinct
   * value drawn from the model. Consumers that group/filter/export values
   * should not treat `name` as a classification code, material name, etc.
   * when this is set.
   *
   * Forward compatibility: an older consumer that doesn't know this field
   * simply renders the entry like any other legend row. That's safe, not
   * silently wrong: the `name` text ("No classification") is self-describing
   * and the entry behaves like a normal clickable/isolatable row — it just
   * can't be told apart from a real value by an older UI's styling.
   */
  isAbsent?: boolean;
}

/** Supported auto-color data sources for display in UI */
export const AUTO_COLOR_SOURCES = [
  'ifcType', 'attribute', 'property', 'quantity', 'classification', 'material', 'model', 'group',
] as const;

/** Common entity attribute names for the lens rule editor */
export const ENTITY_ATTRIBUTE_NAMES = [
  'Name', 'Description', 'ObjectType', 'PredefinedType', 'Tag',
] as const;

/** Common IFC classes for lens rule editor UI */
export const COMMON_IFC_CLASSES = [
  'IfcWall', 'IfcWallStandardCase',
  'IfcSlab', 'IfcSlabStandardCase',
  'IfcColumn', 'IfcColumnStandardCase',
  'IfcBeam', 'IfcBeamStandardCase',
  'IfcDoor', 'IfcWindow',
  'IfcStairFlight', 'IfcStair',
  'IfcRoof', 'IfcRamp', 'IfcRampFlight',
  'IfcRailing', 'IfcCovering',
  'IfcCurtainWall', 'IfcPlate',
  'IfcFooting', 'IfcPile',
  'IfcMember', 'IfcBuildingElementProxy',
  'IfcFurnishingElement', 'IfcSpace', 'IfcSpatialZone', 'IfcZone',
  'IfcFlowSegment', 'IfcFlowTerminal', 'IfcFlowFitting',
  'IfcDistributionElement',
  'IfcOpeningElement',
] as const;

/** Preset colors for new lens rules — high contrast, perceptually distinct */
export const LENS_PALETTE = [
  '#E53935', '#1E88E5', '#FDD835', '#43A047',
  '#8E24AA', '#00ACC1', '#FF8F00', '#6D4C41',
  '#EC407A', '#5C6BC0', '#26A69A', '#78909C',
] as const;

/** IFC subclass -> base class map for hierarchy-aware matching: every `*StandardCase` entity plus the two `*Flight` types. */
export const IFC_SUBTYPE_TO_BASE: Readonly<Record<string, string>> = {
  IfcWallStandardCase: 'IfcWall', IfcSlabStandardCase: 'IfcSlab',
  IfcColumnStandardCase: 'IfcColumn', IfcBeamStandardCase: 'IfcBeam',
  IfcDoorStandardCase: 'IfcDoor', IfcWindowStandardCase: 'IfcWindow',
  IfcMemberStandardCase: 'IfcMember', IfcPlateStandardCase: 'IfcPlate',
  IfcOpeningStandardCase: 'IfcOpeningElement', IfcStairFlight: 'IfcStair',
  IfcRampFlight: 'IfcRamp' };
