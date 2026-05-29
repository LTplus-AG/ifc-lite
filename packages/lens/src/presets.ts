/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Lens } from './types.js';

/**
 * Built-in lens presets covering common BIM use-cases.
 *
 * These are immutable starter configurations that ship with the package.
 * The viewer marks them with `builtin: true` so they cannot be deleted.
 */
export const BUILTIN_LENSES: readonly Lens[] = [
  // Auto-color by IFC Class — colors ALL classes automatically from model data
  {
    id: 'lens-by-class',
    name: 'By IFC Class',
    builtin: true,
    rules: [],
    autoColor: { source: 'ifcType' },
  },
  {
    id: 'lens-structural',
    name: 'Structural',
    builtin: true,
    rules: [
      { id: 'col', name: 'Columns', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcColumn' }, action: 'colorize', color: '#E53935' },
      { id: 'beam', name: 'Beams', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcBeam' }, action: 'colorize', color: '#1E88E5' },
      { id: 'slab', name: 'Slabs', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcSlab' }, action: 'colorize', color: '#FDD835' },
      { id: 'footing', name: 'Footings', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcFooting' }, action: 'colorize', color: '#43A047' },
    ],
  },
  {
    id: 'lens-envelope',
    name: 'Building Envelope',
    builtin: true,
    rules: [
      { id: 'roof', name: 'Roofs', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcRoof' }, action: 'colorize', color: '#C62828' },
      { id: 'curtwall', name: 'Curtain Walls', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcCurtainWall' }, action: 'colorize', color: '#0277BD' },
      { id: 'window', name: 'Windows', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWindow' }, action: 'colorize', color: '#4FC3F7' },
      { id: 'door', name: 'Doors', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcDoor' }, action: 'colorize', color: '#00695C' },
      { id: 'wall', name: 'Walls', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'colorize', color: '#8D6E63' },
    ],
  },
  {
    id: 'lens-openings',
    name: 'Openings & Circulation',
    builtin: true,
    rules: [
      { id: 'door', name: 'Doors', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcDoor' }, action: 'colorize', color: '#00897B' },
      { id: 'window', name: 'Windows', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWindow' }, action: 'colorize', color: '#42A5F5' },
      { id: 'stair', name: 'Stairs', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcStairFlight' }, action: 'colorize', color: '#FF8F00' },
      { id: 'ramp', name: 'Ramps', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcRamp' }, action: 'colorize', color: '#7CB342' },
      { id: 'railing', name: 'Railings', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcRailing' }, action: 'colorize', color: '#78909C' },
    ],
  },
  // Auto-color by material
  {
    id: 'lens-auto-material',
    name: 'By Material',
    builtin: true,
    rules: [],
    autoColor: { source: 'material' },
  },
  // Auto-color by federated model
  {
    id: 'lens-by-model',
    name: 'By Model',
    builtin: true,
    rules: [],
    autoColor: { source: 'model' },
  },
];
