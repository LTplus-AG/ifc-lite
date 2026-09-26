/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * `PropertiesPanel.tsx`'s own chrome (#4918 slice: panel outer chrome), the
 * parts of that file that are not one of the card components catalogued in
 * `properties.en.ts`: the empty state, the entity header's merge-layers badge,
 * GlobalId copy and world-coordinates disclosure, the IFC Attributes /
 * Structure / Zones collapsible sections and their inline attribute editor,
 * the Properties/Quantities/bSDD/Raw STEP tabs, each tab's empty state, the
 * occurrence/type/material property section labels, and the unified-storey
 * multi-entity view. Entity type names, attribute names/values, and
 * property/quantity set names remain model content, not literals. Split out
 * of `properties.en.ts` (#5811) to keep both under the module-size rule.
 */
export const propertiesPanelEn = {
  // PropertiesPanel: empty state
  'properties.panel.title': 'Inspector',
  'properties.panel.emptyTitle': 'No Selection',
  'properties.panel.emptyHintMultiModel': 'Select a model or element to view details',
  'properties.panel.emptyHintSingleModel': 'Select an element to view details',

  // PropertiesPanel: entity header
  'properties.panel.layersMergedBadge': 'Layers merged',
  'properties.panel.layersMergedTooltip': 'Multilayer wall parts have been merged into the parent solid.',
  'properties.panel.associatedTypeFallback': 'Type',
  'properties.panel.worldCoordinates': 'World',
  'properties.panel.worldCoordinatesDetails': 'details',
  'properties.panel.sizeLabel': 'Size',
  'properties.panel.sizeDisplay': '{x} x {y} x {z}',

  // PropertiesPanel: IFC Attributes / Structure / Zones sections
  'properties.panel.attributesHeading': 'Attributes',
  'properties.panel.structureHeading': 'Structure',
  'properties.panel.zonesHeading': 'Zones',
  'properties.panel.attributeEditor.emptyValue': 'empty',
  'properties.panel.attributeEditor.editTooltip': 'Edit attribute',

  // PropertiesPanel: tabs
  'properties.panel.tab.properties': 'Properties',
  'properties.panel.tab.quantities': 'Quantities',
  'properties.panel.tab.bsdd': 'bSDD',
  'properties.panel.tab.rawStepTitle': 'Raw STEP — developer view of positional arguments',
  'properties.panel.tab.rawStepLabel': 'Raw STEP',

  // PropertiesPanel: tab empty states + section labels
  'properties.panel.noPropertySets': 'No property sets',
  'properties.panel.noQuantities': 'No quantities',
  'properties.panel.selectEntityForRawStep': 'Select an entity to inspect raw STEP arguments',
  'properties.panel.occurrencePropertiesHeading': 'Occurrence Properties:',
  'properties.panel.typePropertiesHeading': 'Type Properties:',
  'properties.panel.typePropertiesGroupHeading': 'Type Properties ({typeName})',
  'properties.panel.materialPropertiesGroupHeading': 'Material Properties ({materialName})',

  // MultiEntityPanel / EntityDataSection (unified-storey multi-entity view)
  'properties.panel.multiEntity.heading': 'Unified Storey',
  'properties.panel.multiEntity.modelCount': '{count} models',
  'properties.panel.multiEntity.loadFailed': 'Unable to load entity data',
  'properties.panel.multiEntity.elevationMeters': '{sign}{value}m',
  'properties.panel.multiEntity.attributesHeading': 'Attributes',
  'properties.panel.multiEntity.propertiesHeading': 'Properties',
  'properties.panel.multiEntity.propertySetsCount': '{count} sets',
  'properties.panel.multiEntity.quantitiesHeading': 'Quantities',
  'properties.panel.multiEntity.quantitySetsCount': '{count} sets',
  'properties.panel.copyGlobalIdLabel': 'Copy GlobalId',
  'properties.panel.saveAttributeLabel': 'Save {attrName}',
} as const satisfies Record<string, TranslationValue>;
