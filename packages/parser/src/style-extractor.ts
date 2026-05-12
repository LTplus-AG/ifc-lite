/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Style extractor - extracts IfcSurfaceStyle and related appearance entities
 */

import type { IfcEntity, EntityIndex } from './types.js';

export interface IFCMaterial {
    // Base color from IfcColourRgb
    baseColor: [number, number, number, number];

    // PBR-mapped properties
    metallic: number;      // Derived from ReflectanceMethod
    roughness: number;     // Derived from SpecularHighlight
    transparency: number;  // From Transparency attribute

    // IFC-specific
    reflectanceMethod?: 'BLINN' | 'PHONG' | 'METAL' | 'GLASS' | 'MATT' | 'PLASTIC' | 'STRAUSS' | 'MIRROR';
    specularColor?: [number, number, number];
    specularHighlight?: number;

    // Rendering hints
    doubleSided: boolean;  // From IfcSurfaceStyle Side attribute
    alphaMode: 'opaque' | 'mask' | 'blend';
}

export interface StyleMapping {
    geometryExpressId: number;
    material: IFCMaterial;
}

/**
 * Extract IFC surface styles and create material mappings
 */
export class StyleExtractor {
    private entities: Map<number, IfcEntity>;

    constructor(entities: Map<number, IfcEntity>, _entityIndex: EntityIndex) {
        this.entities = entities;
        // entityIndex reserved for future type-specific style lookups
        void _entityIndex;
    }

    /**
     * Extract all style mappings from IFC entities
     */
    extractStyles(): Map<number, IFCMaterial> {
        const styleMap = new Map<number, IFCMaterial>();

        // Find all IfcStyledItem entities
        const styledItems = this.findEntitiesByType('IFCSTYLEDITEM');

        for (const styledItem of styledItems) {
            try {
                const material = this.extractMaterialFromStyledItem(styledItem);
                if (material) {
                    // IfcStyledItem.Item references the geometry
                    const itemRef = this.getAttributeValue(styledItem, 0);
                    if (typeof itemRef === 'number') {
                        styleMap.set(itemRef, material);
                    }
                }
            } catch (e) {
                // Skip invalid styled items
                console.warn(`[StyleExtractor] Failed to extract style from #${styledItem.expressId}:`, e);
            }
        }

        return styleMap;
    }

    /**
     * Extract material from IfcStyledItem
     */
    private extractMaterialFromStyledItem(styledItem: IfcEntity): IFCMaterial | null {
        // IfcStyledItem structure:
        // Item (0) - reference to geometry
        // Styles (1) - SET OF IfcPresentationStyleAssignment
        // Name (2) - optional

        const stylesRef = this.getAttributeValue(styledItem, 1);
        if (!stylesRef) return null;

        // Handle SET OF (array)
        const styleAssignments = Array.isArray(stylesRef) ? stylesRef : [stylesRef];

        for (const styleAssignmentRef of styleAssignments) {
            if (typeof styleAssignmentRef !== 'number') continue;

            const styleAssignment = this.entities.get(styleAssignmentRef);
            if (!styleAssignment) continue;

            const material = this.extractMaterialFromStyleAssignment(styleAssignment);
            if (material) return material;
        }

        return null;
    }

    /**
     * Extract material from IfcPresentationStyleAssignment
     */
    private extractMaterialFromStyleAssignment(styleAssignment: IfcEntity): IFCMaterial | null {
        // IfcPresentationStyleAssignment structure:
        // Styles (0) - SET OF IfcSurfaceStyle

        const stylesRef = this.getAttributeValue(styleAssignment, 0);
        if (!stylesRef) return null;

        const styles = Array.isArray(stylesRef) ? stylesRef : [stylesRef];

        for (const styleRef of styles) {
            if (typeof styleRef !== 'number') continue;

            const style = this.entities.get(styleRef);
            if (!style) continue;

            const material = this.extractMaterialFromSurfaceStyle(style);
            if (material) return material;
        }

        return null;
    }

    /**
     * Extract material from IfcSurfaceStyle
     */
    private extractMaterialFromSurfaceStyle(surfaceStyle: IfcEntity): IFCMaterial | null {
        // IfcSurfaceStyle structure:
        // Name (0) - optional
        // Side (1) - .POSITIVE., .NEGATIVE., .BOTH.
        // Styles (2) - SET OF IfcSurfaceStyleElement

        const sideAttr = this.getAttributeValue(surfaceStyle, 1);
        const doubleSided = sideAttr === '.BOTH.' || sideAttr === 'BOTH';

        const stylesRef = this.getAttributeValue(surfaceStyle, 2);
        if (!stylesRef) return null;

        const styles = Array.isArray(stylesRef) ? stylesRef : [stylesRef];

        // Look for IfcSurfaceStyleRendering (most common)
        for (const styleRef of styles) {
            if (typeof styleRef !== 'number') continue;

            const styleElement = this.entities.get(styleRef);
            if (!styleElement) continue;

            const typeUpper = styleElement.type.toUpperCase();
            if (typeUpper === 'IFCSURFACESTYLERENDERING') {
                return this.extractMaterialFromRendering(styleElement, doubleSided);
            } else if (typeUpper === 'IFCSURFACESTYLESHADING') {
                return this.extractMaterialFromShading(styleElement, doubleSided);
            }
        }

        return null;
    }

    /**
     * Extract material from IfcSurfaceStyleRendering
     */
    private extractMaterialFromRendering(
        rendering: IfcEntity,
        doubleSided: boolean
    ): IFCMaterial {
        // IfcSurfaceStyleRendering structure:
        // SurfaceColour (0) - IfcColourRgb
        // Transparency (1) - OPTIONAL IfcNormalisedRatioMeasure
        // DiffuseColour (2) - OPTIONAL IfcColourOrFactor
        // TransmissionColour (3) - OPTIONAL
        // DiffuseTransmissionColour (4) - OPTIONAL
        // ReflectionColour (5) - OPTIONAL
        // SpecularColour (6) - OPTIONAL
        // SpecularHighlight (7) - OPTIONAL IfcSpecularHighlightSelect
        // ReflectanceMethod (8) - IfcReflectanceMethodEnum

        const surfaceColor = this.extractColorRgb(this.getAttributeValue(rendering, 0));
        const transparency = this.extractTransparency(this.getAttributeValue(rendering, 1));
        const specularHighlight = this.extractSpecularHighlight(this.getAttributeValue(rendering, 7));
        const reflectanceMethod = this.extractReflectanceMethod(this.getAttributeValue(rendering, 8));

        // Extract specular color if available
        const specularColorRef = this.getAttributeValue(rendering, 6);
        const specularColor = specularColorRef ? this.extractColorRgb(specularColorRef) : undefined;

        // Map reflectance method to PBR properties
        const { metallic, roughness } = this.mapReflectanceToPBR(reflectanceMethod, specularHighlight);

        return {
            baseColor: [...surfaceColor, 1.0 - transparency] as [number, number, number, number],
            metallic,
            roughness,
            transparency,
            reflectanceMethod,
            specularColor,
            specularHighlight,
            doubleSided,
            alphaMode: transparency > 0.01 ? 'blend' : 'opaque',
        };
    }

    /**
     * Extract material from IfcSurfaceStyleShading (simpler fallback)
     */
    private extractMaterialFromShading(
        shading: IfcEntity,
        doubleSided: boolean
    ): IFCMaterial {
        // IfcSurfaceStyleShading structure:
        // SurfaceColour (0) - IfcColourRgb
        // Transparency (1) - OPTIONAL

        const surfaceColor = this.extractColorRgb(this.getAttributeValue(shading, 0));
        const transparency = this.extractTransparency(this.getAttributeValue(shading, 1));

        return {
            baseColor: [...surfaceColor, 1.0 - transparency] as [number, number, number, number],
            metallic: 0.0,
            roughness: 0.6,
            transparency,
            doubleSided,
            alphaMode: transparency > 0.01 ? 'blend' : 'opaque',
        };
    }

    /**
     * Extract RGB color from IfcColourRgb
     */
    private extractColorRgb(colorRef: any): [number, number, number] {
        if (!colorRef) return [0.8, 0.8, 0.8];

        // If it's a reference, resolve it
        if (typeof colorRef === 'number') {
            const colorEntity = this.entities.get(colorRef);
            if (colorEntity) {
                // IfcColourRgb structure: Name (0), Red (1), Green (2), Blue (3)
                const r = this.getNumericValue(colorEntity, 1) ?? 0.8;
                const g = this.getNumericValue(colorEntity, 2) ?? 0.8;
                const b = this.getNumericValue(colorEntity, 3) ?? 0.8;
                return [r, g, b];
            }
        }

        // If it's already an array or object
        if (Array.isArray(colorRef) && colorRef.length >= 3) {
            return [colorRef[0], colorRef[1], colorRef[2]];
        }

        return [0.8, 0.8, 0.8];
    }

    /**
     * Extract transparency value
     */
    private extractTransparency(transparencyRef: any): number {
        if (transparencyRef === null || transparencyRef === undefined) return 0.0;

        // If it's wrapped in IFCNORMALISEDRATIOMEASURE, extract the value
        if (typeof transparencyRef === 'number') {
            return Math.max(0.0, Math.min(1.0, transparencyRef));
        }

        // If it's an object with a value property
        if (typeof transparencyRef === 'object' && 'value' in transparencyRef) {
            return Math.max(0.0, Math.min(1.0, Number(transparencyRef.value) || 0.0));
        }

        return 0.0;
    }

    /**
     * Extract specular highlight value
     */
    private extractSpecularHighlight(highlightRef: any): number | undefined {
        if (highlightRef === null || highlightRef === undefined) return undefined;

        // If it's wrapped in IFCSPECULAREXPONENT, extract the value
        if (typeof highlightRef === 'number') {
            return highlightRef;
        }

        // If it's an object with a value property
        if (typeof highlightRef === 'object' && 'value' in highlightRef) {
            return Number(highlightRef.value) || undefined;
        }

        return undefined;
    }

    /**
     * Extract reflectance method enum
     */
    private extractReflectanceMethod(methodRef: any): 'BLINN' | 'PHONG' | 'METAL' | 'GLASS' | 'MATT' | 'PLASTIC' | 'STRAUSS' | 'MIRROR' | undefined {
        if (!methodRef) return undefined;

        const methodStr = String(methodRef).toUpperCase().replace(/^\./, '').replace(/\.$/, '');

        const validMethods = ['BLINN', 'PHONG', 'METAL', 'GLASS', 'MATT', 'PLASTIC', 'STRAUSS', 'MIRROR'];
        if (validMethods.includes(methodStr)) {
            return methodStr as 'BLINN' | 'PHONG' | 'METAL' | 'GLASS' | 'MATT' | 'PLASTIC' | 'STRAUSS' | 'MIRROR';
        }

        return undefined;
    }

    /**
     * Map IFC reflectance method to PBR metallic/roughness
     */
    private mapReflectanceToPBR(
        method: string | undefined,
        specularHighlight: number | undefined
    ): { metallic: number; roughness: number } {
        // Default values
        let metallic = 0.0;
        let roughness = 0.6;

        if (!method) {
            // Use specular highlight to estimate roughness if available
            if (specularHighlight !== undefined) {
                // Higher specular exponent = smoother surface = lower roughness
                roughness = Math.max(0.1, Math.min(1.0, 1.0 - (specularHighlight / 128.0)));
            }
            return { metallic, roughness };
        }

        const methodUpper = method.toUpperCase();

        switch (methodUpper) {
            case 'MATT':
                metallic = 0.0;
                roughness = 0.9;
                break;
            case 'PLASTIC':
                metallic = 0.0;
                roughness = 0.5;
                break;
            case 'PHONG':
            case 'BLINN':
                metallic = 0.0;
                roughness = specularHighlight ? Math.max(0.1, Math.min(0.8, 1.0 - (specularHighlight / 128.0))) : 0.4;
                break;
            case 'METAL':
                metallic = 0.9;
                roughness = 0.4;
                break;
            case 'MIRROR':
                metallic = 1.0;
                roughness = 0.1;
                break;
            case 'GLASS':
                metallic = 0.0;
                roughness = 0.05;
                break;
            case 'STRAUSS':
                metallic = 0.5;
                roughness = 0.5;
                break;
            default:
                metallic = 0.0;
                roughness = 0.6;
        }

        return { metallic, roughness };
    }

    /**
     * Find entities by type name (case-insensitive)
     */
    private findEntitiesByType(typeName: string): IfcEntity[] {
        const result: IfcEntity[] = [];
        const typeUpper = typeName.toUpperCase();

        for (const entity of this.entities.values()) {
            if (entity.type.toUpperCase() === typeUpper) {
                result.push(entity);
            }
        }

        return result;
    }

    /**
     * Get attribute value from entity
     */
    private getAttributeValue(entity: IfcEntity, index: number): any {
        if (index < 0 || index >= entity.attributes.length) {
            return null;
        }
        return entity.attributes[index];
    }

    /**
     * Get numeric value from entity attribute
     * Also handles TypedValue wrappers like [typeName, numericValue]
     */
    private getNumericValue(entity: IfcEntity, index: number): number | null {
        const value = this.getAttributeValue(entity, index);
        if (typeof value === 'number') {
            return value;
        }
        if (typeof value === 'string') {
            const parsed = parseFloat(value);
            return isNaN(parsed) ? null : parsed;
        }
        // Handle TypedValue wrappers: [typeName, numericValue]
        // e.g., ["IFCNORMALISEDRATIOMEASURE", 0.5]
        if (Array.isArray(value) && value.length >= 2) {
            if (typeof value[0] === 'string' && typeof value[1] === 'number') {
                return value[1];
            }
            // Nested case: recursively try to extract numeric from second element
            if (typeof value[0] === 'string') {
                if (typeof value[1] === 'number') {
                    return value[1];
                }
                if (typeof value[1] === 'string') {
                    const parsed = parseFloat(value[1]);
                    return isNaN(parsed) ? null : parsed;
                }
            }
        }
        return null;
    }
}
