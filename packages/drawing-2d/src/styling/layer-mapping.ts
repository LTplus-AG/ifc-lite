/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer mapping for architectural drawings
 *
 * Maps IFC types and semantic line types to AIA-standard layers
 * for organized SVG/CAD export.
 */

import type {
  LayerDefinition,
  AIALayerCode,
  SemanticLineType,
  ArchitecturalLine,
  LineWeight,
} from '../types.js';

/**
 * Default layer definitions following AIA CAD Layer Guidelines
 */
export const DEFAULT_LAYERS: LayerDefinition[] = [
  {
    id: 'walls',
    aiaCode: 'A-WALL',
    label: 'Walls',
    visible: true,
    defaultWeight: 'heavy',
    color: '#000000',
  },
  {
    id: 'walls-full',
    aiaCode: 'A-WALL-FULL',
    label: 'Full Height Walls',
    visible: true,
    defaultWeight: 'heavy',
    color: '#000000',
  },
  {
    id: 'columns',
    aiaCode: 'A-COLS',
    label: 'Columns',
    visible: true,
    defaultWeight: 'heavy',
    color: '#000000',
  },
  {
    id: 'doors',
    aiaCode: 'A-DOOR',
    label: 'Doors',
    visible: true,
    defaultWeight: 'medium',
    color: '#000000',
  },
  {
    id: 'glazing',
    aiaCode: 'A-GLAZ',
    label: 'Windows/Glazing',
    visible: true,
    defaultWeight: 'medium',
    color: '#000000',
  },
  {
    id: 'stairs',
    aiaCode: 'A-STRS',
    label: 'Stairs',
    visible: true,
    defaultWeight: 'medium',
    color: '#000000',
  },
  {
    id: 'floor',
    aiaCode: 'A-FLOR',
    label: 'Floor',
    visible: true,
    defaultWeight: 'heavy',
    color: '#000000',
  },
  {
    id: 'ceiling',
    aiaCode: 'A-CLNG',
    label: 'Ceiling',
    visible: true,
    defaultWeight: 'light',
    color: '#666666',
  },
  {
    id: 'roof',
    aiaCode: 'A-ROOF',
    label: 'Roof',
    visible: true,
    defaultWeight: 'heavy',
    color: '#000000',
  },
  {
    id: 'furniture',
    aiaCode: 'A-FURN',
    label: 'Furniture',
    visible: true,
    defaultWeight: 'light',
    color: '#333333',
  },
  {
    id: 'equipment',
    aiaCode: 'A-EQPM',
    label: 'Equipment',
    visible: true,
    defaultWeight: 'light',
    color: '#333333',
  },
  {
    id: 'hatching',
    aiaCode: 'A-PATT',
    label: 'Hatching Patterns',
    visible: true,
    defaultWeight: 'hairline',
    color: '#808080',
  },
  {
    id: 'annotations',
    aiaCode: 'A-ANNO',
    label: 'Annotations',
    visible: true,
    defaultWeight: 'hairline',
    color: '#000000',
  },
  {
    id: 'dimensions',
    aiaCode: 'A-DIMS',
    label: 'Dimensions',
    visible: true,
    defaultWeight: 'hairline',
    color: '#000000',
  },
  {
    id: 'symbols',
    aiaCode: 'A-SYMB',
    label: 'Symbols',
    visible: true,
    defaultWeight: 'hairline',
    color: '#000000',
  },
  {
    id: 'hidden',
    aiaCode: 'A-HIDN',
    label: 'Hidden Lines',
    visible: true,
    defaultWeight: 'hairline',
    color: '#808080',
  },
];

/**
 * IFC type to AIA layer code mapping
 */
const IFC_TYPE_TO_LAYER: Record<string, AIALayerCode> = {
  // Walls
  IfcWall: 'A-WALL',
  IfcWallStandardCase: 'A-WALL',
  IfcCurtainWall: 'A-WALL',

  // Columns
  IfcColumn: 'A-COLS',
  IfcColumnStandardCase: 'A-COLS',

  // Doors
  IfcDoor: 'A-DOOR',
  IfcDoorStandardCase: 'A-DOOR',

  // Windows
  IfcWindow: 'A-GLAZ',
  IfcWindowStandardCase: 'A-GLAZ',

  // Stairs
  IfcStair: 'A-STRS',
  IfcStairFlight: 'A-STRS',
  IfcRamp: 'A-STRS',
  IfcRampFlight: 'A-STRS',
  IfcRailing: 'A-STRS',

  // Floor/Slab
  IfcSlab: 'A-FLOR',
  IfcFloor: 'A-FLOR',

  // Ceiling
  IfcCovering: 'A-CLNG',
  IfcCeiling: 'A-CLNG',

  // Roof
  IfcRoof: 'A-ROOF',
  IfcRoofSlab: 'A-ROOF',

  // Furniture
  IfcFurnishingElement: 'A-FURN',
  IfcFurniture: 'A-FURN',

  // Equipment
  IfcDistributionElement: 'A-EQPM',
  IfcFlowTerminal: 'A-EQPM',
  IfcFlowSegment: 'A-EQPM',
  IfcBuildingElementProxy: 'A-EQPM',

  // Openings (typically hidden or special handling)
  IfcOpeningElement: 'A-HIDN',

  // Spaces
  IfcSpace: 'A-ANNO',
};

/**
 * Semantic line type to AIA layer code mapping
 */
const SEMANTIC_TYPE_TO_LAYER: Record<SemanticLineType, AIALayerCode> = {
  'wall-cut': 'A-WALL',
  'wall-projection': 'A-WALL',
  'column-cut': 'A-COLS',
  'slab-cut': 'A-FLOR',
  'opening-frame': 'A-DOOR',
  'door-swing': 'A-SYMB',
  'door-leaf': 'A-DOOR',
  'window-frame': 'A-GLAZ',
  'window-mullion': 'A-GLAZ',
  'stair-cut': 'A-STRS',
  'stair-nosing': 'A-STRS',
  furniture: 'A-FURN',
  equipment: 'A-EQPM',
  annotation: 'A-ANNO',
  dimension: 'A-DIMS',
  hidden: 'A-HIDN',
  centerline: 'A-ANNO',
};

/**
 * Layer mapper for organizing lines by layer
 */
export class LayerMapper {
  private layers: LayerDefinition[];
  private layerById: Map<string, LayerDefinition>;
  private layerByCode: Map<AIALayerCode, LayerDefinition>;

  constructor(layers: LayerDefinition[] = DEFAULT_LAYERS) {
    this.layers = layers;
    this.layerById = new Map(layers.map((l) => [l.id, l]));
    this.layerByCode = new Map(layers.map((l) => [l.aiaCode, l]));
  }

  /**
   * Get layer for an IFC type
   */
  getLayerForIfcType(ifcType: string): LayerDefinition | undefined {
    const code = IFC_TYPE_TO_LAYER[ifcType];
    if (code) {
      return this.layerByCode.get(code);
    }
    return undefined;
  }

  /**
   * Get layer for a semantic line type
   */
  getLayerForSemanticType(semanticType: SemanticLineType): LayerDefinition | undefined {
    const code = SEMANTIC_TYPE_TO_LAYER[semanticType];
    if (code) {
      return this.layerByCode.get(code);
    }
    return undefined;
  }

  /**
   * Get layer for an architectural line
   */
  getLayerForLine(line: ArchitecturalLine): LayerDefinition {
    // Hidden lines always go to hidden layer
    if (line.visibility === 'hidden' || line.lineStyle === 'dashed') {
      return this.layerByCode.get('A-HIDN') ?? this.layers[0];
    }

    // Try semantic type first
    const semanticLayer = this.getLayerForSemanticType(line.semanticType);
    if (semanticLayer) return semanticLayer;

    // Fall back to IFC type
    const ifcLayer = this.getLayerForIfcType(line.ifcType);
    if (ifcLayer) return ifcLayer;

    // Default to walls
    return this.layerByCode.get('A-WALL') ?? this.layers[0];
  }

  /**
   * Group lines by layer
   */
  groupLinesByLayer(lines: ArchitecturalLine[]): Map<LayerDefinition, ArchitecturalLine[]> {
    const grouped = new Map<LayerDefinition, ArchitecturalLine[]>();

    for (const line of lines) {
      const layer = this.getLayerForLine(line);
      const existing = grouped.get(layer);
      if (existing) {
        existing.push(line);
      } else {
        grouped.set(layer, [line]);
      }
    }

    return grouped;
  }

  /**
   * Get all layer definitions
   */
  getLayers(): LayerDefinition[] {
    return this.layers;
  }

  /**
   * Get layer by ID
   */
  getLayerById(id: string): LayerDefinition | undefined {
    return this.layerById.get(id);
  }

  /**
   * Get layer by AIA code
   */
  getLayerByCode(code: AIALayerCode): LayerDefinition | undefined {
    return this.layerByCode.get(code);
  }
}

/**
 * Get AIA layer code for an IFC type
 */
export function getLayerForIfcType(ifcType: string): AIALayerCode {
  return IFC_TYPE_TO_LAYER[ifcType] ?? 'A-WALL';
}

/**
 * Create a default layer mapper
 */
export function createLayerMapper(
  customLayers?: LayerDefinition[]
): LayerMapper {
  return new LayerMapper(customLayers ?? DEFAULT_LAYERS);
}
