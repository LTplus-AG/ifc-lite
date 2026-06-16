/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Built-in list presets / templates
 */

import { IfcTypeEnum } from '@ifc-lite/data';
import type { ListDefinition } from './types.js';

function makePreset(
  name: string,
  description: string,
  entityTypes: IfcTypeEnum[],
  columns: ListDefinition['columns'],
): ListDefinition {
  return {
    id: `preset-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    description,
    createdAt: 0,
    updatedAt: 0,
    entityTypes,
    conditions: [],
    columns,
  };
}

function attr(name: string): ListDefinition['columns'][0] {
  return { id: `attr-${name.toLowerCase()}`, source: 'attribute', propertyName: name };
}

function prop(psetName: string, propName: string): ListDefinition['columns'][0] {
  return {
    id: `prop-${psetName}-${propName}`.toLowerCase().replace(/\s+/g, '-'),
    source: 'property',
    psetName,
    propertyName: propName,
    label: propName,
  };
}

function quant(qsetName: string, quantName: string): ListDefinition['columns'][0] {
  return {
    id: `quant-${qsetName}-${quantName}`.toLowerCase().replace(/\s+/g, '-'),
    source: 'quantity',
    psetName: qsetName,
    propertyName: quantName,
    label: quantName,
  };
}

export const LIST_PRESETS: ListDefinition[] = [
  makePreset(
    'Wall Schedule',
    'All walls with common properties and base quantities',
    [IfcTypeEnum.IfcWall, IfcTypeEnum.IfcWallStandardCase],
    [
      attr('Name'),
      attr('Class'),
      attr('ObjectType'),
      prop('Pset_WallCommon', 'IsExternal'),
      prop('Pset_WallCommon', 'FireRating'),
      prop('Pset_WallCommon', 'LoadBearing'),
      quant('Qto_WallBaseQuantities', 'Length'),
      quant('Qto_WallBaseQuantities', 'Height'),
      quant('Qto_WallBaseQuantities', 'Width'),
      quant('Qto_WallBaseQuantities', 'GrossVolume'),
      quant('Qto_WallBaseQuantities', 'NetArea'),
    ],
  ),

  makePreset(
    'Door Schedule',
    'All doors with dimensions',
    [IfcTypeEnum.IfcDoor],
    [
      attr('Name'),
      attr('Class'),
      attr('ObjectType'),
      prop('Pset_DoorCommon', 'FireRating'),
      prop('Pset_DoorCommon', 'IsExternal'),
      prop('Pset_DoorCommon', 'AcousticRating'),
      quant('Qto_DoorBaseQuantities', 'Width'),
      quant('Qto_DoorBaseQuantities', 'Height'),
      quant('Qto_DoorBaseQuantities', 'Area'),
    ],
  ),

  makePreset(
    'Window Schedule',
    'All windows with dimensions',
    [IfcTypeEnum.IfcWindow],
    [
      attr('Name'),
      attr('Class'),
      attr('ObjectType'),
      prop('Pset_WindowCommon', 'IsExternal'),
      prop('Pset_WindowCommon', 'FireRating'),
      prop('Pset_WindowCommon', 'ThermalTransmittance'),
      quant('Qto_WindowBaseQuantities', 'Width'),
      quant('Qto_WindowBaseQuantities', 'Height'),
      quant('Qto_WindowBaseQuantities', 'Area'),
    ],
  ),

  makePreset(
    'Space Areas',
    'All spaces with areas and volumes',
    [IfcTypeEnum.IfcSpace],
    [
      attr('Name'),
      attr('Description'),
      attr('ObjectType'),
      prop('Pset_SpaceCommon', 'Category'),
      prop('Pset_SpaceCommon', 'IsExternal'),
      quant('Qto_SpaceBaseQuantities', 'GrossFloorArea'),
      quant('Qto_SpaceBaseQuantities', 'NetFloorArea'),
      quant('Qto_SpaceBaseQuantities', 'GrossVolume'),
      quant('Qto_SpaceBaseQuantities', 'FinishCeilingHeight'),
    ],
  ),

  makePreset(
    'Zones & Systems',
    'All spatial zones, zones and systems with their names',
    [
      IfcTypeEnum.IfcSpatialZone, IfcTypeEnum.IfcZone,
      IfcTypeEnum.IfcSystem, IfcTypeEnum.IfcDistributionSystem,
    ],
    [
      attr('Name'),
      attr('Class'),
      attr('Description'),
      attr('ObjectType'),
      attr('GlobalId'),
    ],
  ),

  makePreset(
    'All Elements',
    'Overview of all building elements',
    [
      IfcTypeEnum.IfcWall, IfcTypeEnum.IfcWallStandardCase,
      IfcTypeEnum.IfcDoor, IfcTypeEnum.IfcWindow,
      IfcTypeEnum.IfcSlab, IfcTypeEnum.IfcColumn, IfcTypeEnum.IfcBeam,
      IfcTypeEnum.IfcStair, IfcTypeEnum.IfcRoof, IfcTypeEnum.IfcCovering,
      IfcTypeEnum.IfcCurtainWall, IfcTypeEnum.IfcRailing,
    ],
    [
      attr('Name'),
      attr('Class'),
      attr('GlobalId'),
      attr('Description'),
      attr('ObjectType'),
    ],
  ),
];
