/**
 * IFC SELECT Types (Unions)
 * Generated from EXPRESS schema: IFC2X3
 *
 * DO NOT EDIT - This file is auto-generated
 */

import type {
  IfcAddress,
  IfcAnnotationCurveOccurrence,
  IfcAnnotationSymbolOccurrence,
  IfcAnnotationTextOccurrence,
  IfcAppliedValue,
  IfcAxis2Placement2D,
  IfcAxis2Placement3D,
  IfcBooleanResult,
  IfcBoundedCurve,
  IfcCalendarDate,
  IfcCartesianPoint,
  IfcClassificationNotation,
  IfcClassificationReference,
  IfcClosedShell,
  IfcColourRgb,
  IfcColourSpecification,
  IfcCostValue,
  IfcCsgPrimitive3D,
  IfcCurve,
  IfcCurveStyle,
  IfcCurveStyleFont,
  IfcCurveStyleFontAndScaling,
  IfcDateAndTime,
  IfcDerivedUnit,
  IfcDirection,
  IfcDocumentInformation,
  IfcDocumentReference,
  IfcEdgeCurve,
  IfcElement,
  IfcExternalReference,
  IfcExternallyDefinedHatchStyle,
  IfcExternallyDefinedSurfaceStyle,
  IfcExternallyDefinedSymbol,
  IfcExternallyDefinedTextFont,
  IfcFaceBasedSurfaceModel,
  IfcFaceSurface,
  IfcFillAreaStyle,
  IfcFillAreaStyleHatching,
  IfcFillAreaStyleTileSymbolWithStyle,
  IfcFillAreaStyleTiles,
  IfcHalfSpaceSolid,
  IfcLibraryInformation,
  IfcLibraryReference,
  IfcLightIntensityDistribution,
  IfcLocalTime,
  IfcMaterial,
  IfcMaterialLayer,
  IfcMaterialLayerSet,
  IfcMaterialLayerSetUsage,
  IfcMaterialList,
  IfcMeasureWithUnit,
  IfcMonetaryUnit,
  IfcNamedUnit,
  IfcOneDirectionRepeatFactor,
  IfcOpenShell,
  IfcOrganization,
  IfcPerson,
  IfcPersonAndOrganization,
  IfcPoint,
  IfcPreDefinedColour,
  IfcPreDefinedCurveFont,
  IfcPreDefinedSymbol,
  IfcPreDefinedTextFont,
  IfcRepresentation,
  IfcRepresentationItem,
  IfcSolidModel,
  IfcStructuralItem,
  IfcSurface,
  IfcSurfaceStyle,
  IfcSurfaceStyleLighting,
  IfcSurfaceStyleRefraction,
  IfcSurfaceStyleShading,
  IfcSurfaceStyleWithTextures,
  IfcSymbolStyle,
  IfcTable,
  IfcTextStyle,
  IfcTextStyleForDefinedFont,
  IfcTextStyleTextModel,
  IfcTextStyleWithBoxCharacteristics,
  IfcTimeSeries,
  IfcVector,
  IfcVertexPoint,
} from './entities.js';

import type {
  IfcBoolean,
  IfcComplexNumber,
  IfcIdentifier,
  IfcInteger,
  IfcLabel,
  IfcLogical,
  IfcParameterValue,
  IfcReal,
  IfcSpecularExponent,
  IfcSpecularRoughness,
  IfcText,
  IfcTimeStamp,
} from './types.js';

import type {
  IfcNullStyle,
} from './enums.js';

/** IfcActorSelect */
export type IfcActorSelect = IfcOrganization | IfcPerson | IfcPersonAndOrganization;

/** IfcAppliedValueSelect */
export type IfcAppliedValueSelect = number | IfcMeasureWithUnit | number;

/** IfcAxis2Placement */
export type IfcAxis2Placement = IfcAxis2Placement2D | IfcAxis2Placement3D;

/** IfcBooleanOperand */
export type IfcBooleanOperand = IfcSolidModel | IfcHalfSpaceSolid | IfcBooleanResult | IfcCsgPrimitive3D;

/** IfcCharacterStyleSelect */
export type IfcCharacterStyleSelect = IfcTextStyleForDefinedFont;

/** IfcClassificationNotationSelect */
export type IfcClassificationNotationSelect = IfcClassificationNotation | IfcClassificationReference;

/** IfcColour */
export type IfcColour = IfcColourSpecification | IfcPreDefinedColour;

/** IfcColourOrFactor */
export type IfcColourOrFactor = IfcColourRgb | number;

/** IfcConditionCriterionSelect */
export type IfcConditionCriterionSelect = IfcLabel | IfcMeasureWithUnit;

/** IfcCsgSelect */
export type IfcCsgSelect = IfcBooleanResult | IfcCsgPrimitive3D;

/** IfcCurveFontOrScaledCurveFontSelect */
export type IfcCurveFontOrScaledCurveFontSelect = IfcCurveStyleFontSelect | IfcCurveStyleFontAndScaling;

/** IfcCurveOrEdgeCurve */
export type IfcCurveOrEdgeCurve = IfcBoundedCurve | IfcEdgeCurve;

/** IfcCurveStyleFontSelect */
export type IfcCurveStyleFontSelect = IfcPreDefinedCurveFont | IfcCurveStyleFont;

/** IfcDateTimeSelect */
export type IfcDateTimeSelect = IfcCalendarDate | IfcLocalTime | IfcDateAndTime;

/** IfcDefinedSymbolSelect */
export type IfcDefinedSymbolSelect = IfcPreDefinedSymbol | IfcExternallyDefinedSymbol;

/** IfcDerivedMeasureValue */
export type IfcDerivedMeasureValue = number | IfcTimeStamp | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number | number;

/** IfcDocumentSelect */
export type IfcDocumentSelect = IfcDocumentReference | IfcDocumentInformation;

/** IfcDraughtingCalloutElement */
export type IfcDraughtingCalloutElement = IfcAnnotationCurveOccurrence | IfcAnnotationTextOccurrence | IfcAnnotationSymbolOccurrence;

/** IfcFillAreaStyleTileShapeSelect */
export type IfcFillAreaStyleTileShapeSelect = IfcFillAreaStyleTileSymbolWithStyle;

/** IfcFillStyleSelect */
export type IfcFillStyleSelect = IfcFillAreaStyleHatching | IfcFillAreaStyleTiles | IfcColour | IfcExternallyDefinedHatchStyle;

/** IfcGeometricSetSelect */
export type IfcGeometricSetSelect = IfcPoint | IfcCurve | IfcSurface;

/** IfcHatchLineDistanceSelect */
export type IfcHatchLineDistanceSelect = IfcOneDirectionRepeatFactor | number;

/** IfcLayeredItem */
export type IfcLayeredItem = IfcRepresentationItem | IfcRepresentation;

/** IfcLibrarySelect */
export type IfcLibrarySelect = IfcLibraryReference | IfcLibraryInformation;

/** IfcLightDistributionDataSourceSelect */
export type IfcLightDistributionDataSourceSelect = IfcExternalReference | IfcLightIntensityDistribution;

/** IfcMaterialSelect */
export type IfcMaterialSelect = IfcMaterial | IfcMaterialList | IfcMaterialLayerSetUsage | IfcMaterialLayerSet | IfcMaterialLayer;

/** IfcMeasureValue */
export type IfcMeasureValue = number | number | number | number | number | number | number | number | IfcParameterValue | number | number | number | number | number | number | number | number | number | number | number | number | IfcComplexNumber;

/** IfcMetricValueSelect */
export type IfcMetricValueSelect = IfcDateTimeSelect | IfcMeasureWithUnit | IfcTable | IfcText | IfcTimeSeries | IfcCostValue;

/** IfcObjectReferenceSelect */
export type IfcObjectReferenceSelect = IfcMaterial | IfcPerson | IfcDateAndTime | IfcMaterialList | IfcOrganization | IfcCalendarDate | IfcLocalTime | IfcPersonAndOrganization | IfcMaterialLayer | IfcExternalReference | IfcTimeSeries | IfcAddress | IfcAppliedValue;

/** IfcOrientationSelect */
export type IfcOrientationSelect = number | IfcDirection;

/** IfcPointOrVertexPoint */
export type IfcPointOrVertexPoint = IfcPoint | IfcVertexPoint;

/** IfcPresentationStyleSelect */
export type IfcPresentationStyleSelect = IfcNullStyle | IfcCurveStyle | IfcSymbolStyle | IfcFillAreaStyle | IfcTextStyle | IfcSurfaceStyle;

/** IfcShell */
export type IfcShell = IfcClosedShell | IfcOpenShell;

/** IfcSimpleValue */
export type IfcSimpleValue = IfcInteger | IfcReal | IfcBoolean | IfcIdentifier | IfcText | IfcLabel | IfcLogical;

/** IfcSizeSelect */
export type IfcSizeSelect = number | number | number | number | number | number;

/** IfcSpecularHighlightSelect */
export type IfcSpecularHighlightSelect = IfcSpecularExponent | IfcSpecularRoughness;

/** IfcStructuralActivityAssignmentSelect */
export type IfcStructuralActivityAssignmentSelect = IfcStructuralItem | IfcElement;

/** IfcSurfaceOrFaceSurface */
export type IfcSurfaceOrFaceSurface = IfcSurface | IfcFaceSurface | IfcFaceBasedSurfaceModel;

/** IfcSurfaceStyleElementSelect */
export type IfcSurfaceStyleElementSelect = IfcSurfaceStyleShading | IfcSurfaceStyleLighting | IfcSurfaceStyleWithTextures | IfcExternallyDefinedSurfaceStyle | IfcSurfaceStyleRefraction;

/** IfcSymbolStyleSelect */
export type IfcSymbolStyleSelect = IfcColour;

/** IfcTextFontSelect */
export type IfcTextFontSelect = IfcPreDefinedTextFont | IfcExternallyDefinedTextFont;

/** IfcTextStyleSelect */
export type IfcTextStyleSelect = IfcTextStyleWithBoxCharacteristics | IfcTextStyleTextModel;

/** IfcTrimmingSelect */
export type IfcTrimmingSelect = IfcCartesianPoint | IfcParameterValue;

/** IfcUnit */
export type IfcUnit = IfcDerivedUnit | IfcNamedUnit | IfcMonetaryUnit;

/** IfcValue */
export type IfcValue = IfcMeasureValue | IfcSimpleValue | IfcDerivedMeasureValue;

/** IfcVectorOrDirection */
export type IfcVectorOrDirection = IfcDirection | IfcVector;

