/**
 * IFC Entity Interfaces
 * Generated from EXPRESS schema: IFC2X3
 *
 * DO NOT EDIT - This file is auto-generated
 */

import type {
  IfcAbsorbedDoseMeasure,
  IfcAccelerationMeasure,
  IfcAmountOfSubstanceMeasure,
  IfcAngularVelocityMeasure,
  IfcAreaMeasure,
  IfcBoolean,
  IfcBoxAlignment,
  IfcComplexNumber,
  IfcCompoundPlaneAngleMeasure,
  IfcContextDependentMeasure,
  IfcCountMeasure,
  IfcCurvatureMeasure,
  IfcDayInMonthNumber,
  IfcDaylightSavingHour,
  IfcDescriptiveMeasure,
  IfcDimensionCount,
  IfcDoseEquivalentMeasure,
  IfcDynamicViscosityMeasure,
  IfcElectricCapacitanceMeasure,
  IfcElectricChargeMeasure,
  IfcElectricConductanceMeasure,
  IfcElectricCurrentMeasure,
  IfcElectricResistanceMeasure,
  IfcElectricVoltageMeasure,
  IfcEnergyMeasure,
  IfcFontStyle,
  IfcFontVariant,
  IfcFontWeight,
  IfcForceMeasure,
  IfcFrequencyMeasure,
  IfcGloballyUniqueId,
  IfcHeatFluxDensityMeasure,
  IfcHeatingValueMeasure,
  IfcHourInDay,
  IfcIdentifier,
  IfcIlluminanceMeasure,
  IfcInductanceMeasure,
  IfcInteger,
  IfcIntegerCountRateMeasure,
  IfcIonConcentrationMeasure,
  IfcIsothermalMoistureCapacityMeasure,
  IfcKinematicViscosityMeasure,
  IfcLabel,
  IfcLengthMeasure,
  IfcLinearForceMeasure,
  IfcLinearMomentMeasure,
  IfcLinearStiffnessMeasure,
  IfcLinearVelocityMeasure,
  IfcLogical,
  IfcLuminousFluxMeasure,
  IfcLuminousIntensityDistributionMeasure,
  IfcLuminousIntensityMeasure,
  IfcMagneticFluxDensityMeasure,
  IfcMagneticFluxMeasure,
  IfcMassDensityMeasure,
  IfcMassFlowRateMeasure,
  IfcMassMeasure,
  IfcMassPerLengthMeasure,
  IfcMinuteInHour,
  IfcModulusOfElasticityMeasure,
  IfcModulusOfLinearSubgradeReactionMeasure,
  IfcModulusOfRotationalSubgradeReactionMeasure,
  IfcModulusOfSubgradeReactionMeasure,
  IfcMoistureDiffusivityMeasure,
  IfcMolecularWeightMeasure,
  IfcMomentOfInertiaMeasure,
  IfcMonetaryMeasure,
  IfcMonthInYearNumber,
  IfcNormalisedRatioMeasure,
  IfcNumericMeasure,
  IfcPHMeasure,
  IfcParameterValue,
  IfcPlanarForceMeasure,
  IfcPlaneAngleMeasure,
  IfcPositiveLengthMeasure,
  IfcPositivePlaneAngleMeasure,
  IfcPositiveRatioMeasure,
  IfcPowerMeasure,
  IfcPresentableText,
  IfcPressureMeasure,
  IfcRadioActivityMeasure,
  IfcRatioMeasure,
  IfcReal,
  IfcRotationalFrequencyMeasure,
  IfcRotationalMassMeasure,
  IfcRotationalStiffnessMeasure,
  IfcSecondInMinute,
  IfcSectionModulusMeasure,
  IfcSectionalAreaIntegralMeasure,
  IfcShearModulusMeasure,
  IfcSolidAngleMeasure,
  IfcSoundPowerMeasure,
  IfcSoundPressureMeasure,
  IfcSpecificHeatCapacityMeasure,
  IfcSpecularExponent,
  IfcSpecularRoughness,
  IfcTemperatureGradientMeasure,
  IfcText,
  IfcTextAlignment,
  IfcTextDecoration,
  IfcTextFontName,
  IfcTextTransformation,
  IfcThermalAdmittanceMeasure,
  IfcThermalConductivityMeasure,
  IfcThermalExpansionCoefficientMeasure,
  IfcThermalResistanceMeasure,
  IfcThermalTransmittanceMeasure,
  IfcThermodynamicTemperatureMeasure,
  IfcTimeMeasure,
  IfcTimeStamp,
  IfcTorqueMeasure,
  IfcVaporPermeabilityMeasure,
  IfcVolumeMeasure,
  IfcVolumetricFlowRateMeasure,
  IfcWarpingConstantMeasure,
  IfcWarpingMomentMeasure,
  IfcYearNumber,
} from './types.js';

import type {
  IfcActionSourceTypeEnum,
  IfcActionTypeEnum,
  IfcActuatorTypeEnum,
  IfcAddressTypeEnum,
  IfcAheadOrBehind,
  IfcAirTerminalBoxTypeEnum,
  IfcAirTerminalTypeEnum,
  IfcAirToAirHeatRecoveryTypeEnum,
  IfcAlarmTypeEnum,
  IfcAnalysisModelTypeEnum,
  IfcAnalysisTheoryTypeEnum,
  IfcArithmeticOperatorEnum,
  IfcAssemblyPlaceEnum,
  IfcBSplineCurveForm,
  IfcBeamTypeEnum,
  IfcBenchmarkEnum,
  IfcBoilerTypeEnum,
  IfcBooleanOperator,
  IfcBuildingElementProxyTypeEnum,
  IfcCableCarrierFittingTypeEnum,
  IfcCableCarrierSegmentTypeEnum,
  IfcCableSegmentTypeEnum,
  IfcChangeActionEnum,
  IfcChillerTypeEnum,
  IfcCoilTypeEnum,
  IfcColumnTypeEnum,
  IfcCompressorTypeEnum,
  IfcCondenserTypeEnum,
  IfcConnectionTypeEnum,
  IfcConstraintEnum,
  IfcControllerTypeEnum,
  IfcCooledBeamTypeEnum,
  IfcCoolingTowerTypeEnum,
  IfcCostScheduleTypeEnum,
  IfcCoveringTypeEnum,
  IfcCurrencyEnum,
  IfcCurtainWallTypeEnum,
  IfcDamperTypeEnum,
  IfcDataOriginEnum,
  IfcDerivedUnitEnum,
  IfcDimensionExtentUsage,
  IfcDirectionSenseEnum,
  IfcDistributionChamberElementTypeEnum,
  IfcDocumentConfidentialityEnum,
  IfcDocumentStatusEnum,
  IfcDoorPanelOperationEnum,
  IfcDoorPanelPositionEnum,
  IfcDoorStyleConstructionEnum,
  IfcDoorStyleOperationEnum,
  IfcDuctFittingTypeEnum,
  IfcDuctSegmentTypeEnum,
  IfcDuctSilencerTypeEnum,
  IfcElectricApplianceTypeEnum,
  IfcElectricCurrentEnum,
  IfcElectricDistributionPointFunctionEnum,
  IfcElectricFlowStorageDeviceTypeEnum,
  IfcElectricGeneratorTypeEnum,
  IfcElectricHeaterTypeEnum,
  IfcElectricMotorTypeEnum,
  IfcElectricTimeControlTypeEnum,
  IfcElementAssemblyTypeEnum,
  IfcElementCompositionEnum,
  IfcEnergySequenceEnum,
  IfcEnvironmentalImpactCategoryEnum,
  IfcEvaporativeCoolerTypeEnum,
  IfcEvaporatorTypeEnum,
  IfcFanTypeEnum,
  IfcFilterTypeEnum,
  IfcFireSuppressionTerminalTypeEnum,
  IfcFlowDirectionEnum,
  IfcFlowInstrumentTypeEnum,
  IfcFlowMeterTypeEnum,
  IfcFootingTypeEnum,
  IfcGasTerminalTypeEnum,
  IfcGeometricProjectionEnum,
  IfcGlobalOrLocalEnum,
  IfcHeatExchangerTypeEnum,
  IfcHumidifierTypeEnum,
  IfcInternalOrExternalEnum,
  IfcInventoryTypeEnum,
  IfcJunctionBoxTypeEnum,
  IfcLampTypeEnum,
  IfcLayerSetDirectionEnum,
  IfcLightDistributionCurveEnum,
  IfcLightEmissionSourceEnum,
  IfcLightFixtureTypeEnum,
  IfcLoadGroupTypeEnum,
  IfcLogicalOperatorEnum,
  IfcMemberTypeEnum,
  IfcMotorConnectionTypeEnum,
  IfcNullStyle,
  IfcObjectTypeEnum,
  IfcObjectiveEnum,
  IfcOccupantTypeEnum,
  IfcOutletTypeEnum,
  IfcPermeableCoveringOperationEnum,
  IfcPhysicalOrVirtualEnum,
  IfcPileConstructionEnum,
  IfcPileTypeEnum,
  IfcPipeFittingTypeEnum,
  IfcPipeSegmentTypeEnum,
  IfcPlateTypeEnum,
  IfcProcedureTypeEnum,
  IfcProfileTypeEnum,
  IfcProjectOrderRecordTypeEnum,
  IfcProjectOrderTypeEnum,
  IfcProjectedOrTrueLengthEnum,
  IfcPropertySourceEnum,
  IfcProtectiveDeviceTypeEnum,
  IfcPumpTypeEnum,
  IfcRailingTypeEnum,
  IfcRampFlightTypeEnum,
  IfcRampTypeEnum,
  IfcReflectanceMethodEnum,
  IfcReinforcingBarRoleEnum,
  IfcReinforcingBarSurfaceEnum,
  IfcResourceConsumptionEnum,
  IfcRibPlateDirectionEnum,
  IfcRoleEnum,
  IfcRoofTypeEnum,
  IfcSIPrefix,
  IfcSIUnitName,
  IfcSanitaryTerminalTypeEnum,
  IfcSectionTypeEnum,
  IfcSensorTypeEnum,
  IfcSequenceEnum,
  IfcServiceLifeFactorTypeEnum,
  IfcServiceLifeTypeEnum,
  IfcSlabTypeEnum,
  IfcSoundScaleEnum,
  IfcSpaceHeaterTypeEnum,
  IfcSpaceTypeEnum,
  IfcStackTerminalTypeEnum,
  IfcStairFlightTypeEnum,
  IfcStairTypeEnum,
  IfcStateEnum,
  IfcStructuralCurveTypeEnum,
  IfcStructuralSurfaceTypeEnum,
  IfcSurfaceSide,
  IfcSurfaceTextureEnum,
  IfcSwitchingDeviceTypeEnum,
  IfcTankTypeEnum,
  IfcTendonTypeEnum,
  IfcTextPath,
  IfcThermalLoadSourceEnum,
  IfcThermalLoadTypeEnum,
  IfcTimeSeriesDataTypeEnum,
  IfcTimeSeriesScheduleTypeEnum,
  IfcTransformerTypeEnum,
  IfcTransitionCode,
  IfcTransportElementTypeEnum,
  IfcTrimmingPreference,
  IfcTubeBundleTypeEnum,
  IfcUnitEnum,
  IfcUnitaryEquipmentTypeEnum,
  IfcValveTypeEnum,
  IfcVibrationIsolatorTypeEnum,
  IfcWallTypeEnum,
  IfcWasteTerminalTypeEnum,
  IfcWindowPanelOperationEnum,
  IfcWindowPanelPositionEnum,
  IfcWindowStyleConstructionEnum,
  IfcWindowStyleOperationEnum,
  IfcWorkControlTypeEnum,
} from './enums.js';

import type {
  IfcActorSelect,
  IfcAppliedValueSelect,
  IfcAxis2Placement,
  IfcBooleanOperand,
  IfcCharacterStyleSelect,
  IfcClassificationNotationSelect,
  IfcColour,
  IfcColourOrFactor,
  IfcConditionCriterionSelect,
  IfcCsgSelect,
  IfcCurveFontOrScaledCurveFontSelect,
  IfcCurveOrEdgeCurve,
  IfcCurveStyleFontSelect,
  IfcDateTimeSelect,
  IfcDefinedSymbolSelect,
  IfcDerivedMeasureValue,
  IfcDocumentSelect,
  IfcDraughtingCalloutElement,
  IfcFillAreaStyleTileShapeSelect,
  IfcFillStyleSelect,
  IfcGeometricSetSelect,
  IfcHatchLineDistanceSelect,
  IfcLayeredItem,
  IfcLibrarySelect,
  IfcLightDistributionDataSourceSelect,
  IfcMaterialSelect,
  IfcMeasureValue,
  IfcMetricValueSelect,
  IfcObjectReferenceSelect,
  IfcOrientationSelect,
  IfcPointOrVertexPoint,
  IfcPresentationStyleSelect,
  IfcShell,
  IfcSimpleValue,
  IfcSizeSelect,
  IfcSpecularHighlightSelect,
  IfcStructuralActivityAssignmentSelect,
  IfcSurfaceOrFaceSurface,
  IfcSurfaceStyleElementSelect,
  IfcSymbolStyleSelect,
  IfcTextFontSelect,
  IfcTextStyleSelect,
  IfcTrimmingSelect,
  IfcUnit,
  IfcValue,
  IfcVectorOrDirection,
} from './selects.js';

/**
 * IfcRepresentationItem
 * @abstract
 */
export interface IfcRepresentationItem {
}

/**
 * IfcGeometricRepresentationItem
 * @abstract
 * @extends IfcRepresentationItem
 */
export interface IfcGeometricRepresentationItem extends IfcRepresentationItem {
}

/**
 * IfcCurve
 * @abstract
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcCurve extends IfcGeometricRepresentationItem {
}

/**
 * IfcBoundedCurve
 * @abstract
 * @extends IfcCurve
 */
export interface IfcBoundedCurve extends IfcCurve {
}

/**
 * IfcCompositeCurve
 * @extends IfcBoundedCurve
 */
export interface IfcCompositeCurve extends IfcBoundedCurve {
  Segments: IfcCompositeCurveSegment[];
  SelfIntersect: boolean | null;
}

/**
 * Ifc2DCompositeCurve
 * @extends IfcCompositeCurve
 */
export interface Ifc2DCompositeCurve extends IfcCompositeCurve {
}

/**
 * IfcRoot
 * @abstract
 */
export interface IfcRoot {
  GlobalId: IfcGloballyUniqueId;
  OwnerHistory: IfcOwnerHistory;
  Name?: IfcLabel;
  Description?: IfcText;
}

/**
 * IfcObjectDefinition
 * @abstract
 * @extends IfcRoot
 */
export interface IfcObjectDefinition extends IfcRoot {
}

/**
 * IfcObject
 * @abstract
 * @extends IfcObjectDefinition
 */
export interface IfcObject extends IfcObjectDefinition {
  ObjectType?: IfcLabel;
}

/**
 * IfcControl
 * @abstract
 * @extends IfcObject
 */
export interface IfcControl extends IfcObject {
}

/**
 * IfcActionRequest
 * @extends IfcControl
 */
export interface IfcActionRequest extends IfcControl {
  RequestID: IfcIdentifier;
}

/**
 * IfcActor
 * @extends IfcObject
 */
export interface IfcActor extends IfcObject {
  TheActor: IfcActorSelect;
}

/**
 * IfcActorRole
 */
export interface IfcActorRole {
  Role: IfcRoleEnum;
  UserDefinedRole?: IfcLabel;
  Description?: IfcText;
}

/**
 * IfcTypeObject
 * @extends IfcObjectDefinition
 */
export interface IfcTypeObject extends IfcObjectDefinition {
  ApplicableOccurrence?: IfcLabel;
  HasPropertySets?: IfcPropertySetDefinition[];
}

/**
 * IfcTypeProduct
 * @extends IfcTypeObject
 */
export interface IfcTypeProduct extends IfcTypeObject {
  RepresentationMaps?: IfcRepresentationMap[];
  Tag?: IfcLabel;
}

/**
 * IfcElementType
 * @abstract
 * @extends IfcTypeProduct
 */
export interface IfcElementType extends IfcTypeProduct {
  ElementType?: IfcLabel;
}

/**
 * IfcDistributionElementType
 * @extends IfcElementType
 */
export interface IfcDistributionElementType extends IfcElementType {
}

/**
 * IfcDistributionControlElementType
 * @abstract
 * @extends IfcDistributionElementType
 */
export interface IfcDistributionControlElementType extends IfcDistributionElementType {
}

/**
 * IfcActuatorType
 * @extends IfcDistributionControlElementType
 */
export interface IfcActuatorType extends IfcDistributionControlElementType {
  PredefinedType: IfcActuatorTypeEnum;
}

/**
 * IfcAddress
 * @abstract
 */
export interface IfcAddress {
  Purpose?: IfcAddressTypeEnum;
  Description?: IfcText;
  UserDefinedPurpose?: IfcLabel;
}

/**
 * IfcDistributionFlowElementType
 * @abstract
 * @extends IfcDistributionElementType
 */
export interface IfcDistributionFlowElementType extends IfcDistributionElementType {
}

/**
 * IfcFlowControllerType
 * @abstract
 * @extends IfcDistributionFlowElementType
 */
export interface IfcFlowControllerType extends IfcDistributionFlowElementType {
}

/**
 * IfcAirTerminalBoxType
 * @extends IfcFlowControllerType
 */
export interface IfcAirTerminalBoxType extends IfcFlowControllerType {
  PredefinedType: IfcAirTerminalBoxTypeEnum;
}

/**
 * IfcFlowTerminalType
 * @abstract
 * @extends IfcDistributionFlowElementType
 */
export interface IfcFlowTerminalType extends IfcDistributionFlowElementType {
}

/**
 * IfcAirTerminalType
 * @extends IfcFlowTerminalType
 */
export interface IfcAirTerminalType extends IfcFlowTerminalType {
  PredefinedType: IfcAirTerminalTypeEnum;
}

/**
 * IfcEnergyConversionDeviceType
 * @abstract
 * @extends IfcDistributionFlowElementType
 */
export interface IfcEnergyConversionDeviceType extends IfcDistributionFlowElementType {
}

/**
 * IfcAirToAirHeatRecoveryType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcAirToAirHeatRecoveryType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcAirToAirHeatRecoveryTypeEnum;
}

/**
 * IfcAlarmType
 * @extends IfcDistributionControlElementType
 */
export interface IfcAlarmType extends IfcDistributionControlElementType {
  PredefinedType: IfcAlarmTypeEnum;
}

/**
 * IfcDraughtingCallout
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcDraughtingCallout extends IfcGeometricRepresentationItem {
  Contents: IfcDraughtingCalloutElement[];
}

/**
 * IfcDimensionCurveDirectedCallout
 * @extends IfcDraughtingCallout
 */
export interface IfcDimensionCurveDirectedCallout extends IfcDraughtingCallout {
}

/**
 * IfcAngularDimension
 * @extends IfcDimensionCurveDirectedCallout
 */
export interface IfcAngularDimension extends IfcDimensionCurveDirectedCallout {
}

/**
 * IfcProduct
 * @abstract
 * @extends IfcObject
 */
export interface IfcProduct extends IfcObject {
  ObjectPlacement?: IfcObjectPlacement;
  Representation?: IfcProductRepresentation;
}

/**
 * IfcAnnotation
 * @extends IfcProduct
 */
export interface IfcAnnotation extends IfcProduct {
}

/**
 * IfcStyledItem
 * @extends IfcRepresentationItem
 */
export interface IfcStyledItem extends IfcRepresentationItem {
  Item?: IfcRepresentationItem;
  Styles: IfcPresentationStyleAssignment[];
  Name?: IfcLabel;
}

/**
 * IfcAnnotationOccurrence
 * @abstract
 * @extends IfcStyledItem
 */
export interface IfcAnnotationOccurrence extends IfcStyledItem {
}

/**
 * IfcAnnotationCurveOccurrence
 * @extends IfcAnnotationOccurrence
 */
export interface IfcAnnotationCurveOccurrence extends IfcAnnotationOccurrence {
}

/**
 * IfcAnnotationFillArea
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcAnnotationFillArea extends IfcGeometricRepresentationItem {
  OuterBoundary: IfcCurve;
  InnerBoundaries?: IfcCurve[];
}

/**
 * IfcAnnotationFillAreaOccurrence
 * @extends IfcAnnotationOccurrence
 */
export interface IfcAnnotationFillAreaOccurrence extends IfcAnnotationOccurrence {
  FillStyleTarget?: IfcPoint;
  GlobalOrLocal?: IfcGlobalOrLocalEnum;
}

/**
 * IfcAnnotationSurface
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcAnnotationSurface extends IfcGeometricRepresentationItem {
  Item: IfcGeometricRepresentationItem;
  TextureCoordinates?: IfcTextureCoordinate;
}

/**
 * IfcAnnotationSurfaceOccurrence
 * @extends IfcAnnotationOccurrence
 */
export interface IfcAnnotationSurfaceOccurrence extends IfcAnnotationOccurrence {
}

/**
 * IfcAnnotationSymbolOccurrence
 * @extends IfcAnnotationOccurrence
 */
export interface IfcAnnotationSymbolOccurrence extends IfcAnnotationOccurrence {
}

/**
 * IfcAnnotationTextOccurrence
 * @extends IfcAnnotationOccurrence
 */
export interface IfcAnnotationTextOccurrence extends IfcAnnotationOccurrence {
}

/**
 * IfcApplication
 */
export interface IfcApplication {
  ApplicationDeveloper: IfcOrganization;
  Version: IfcLabel;
  ApplicationFullName: IfcLabel;
  ApplicationIdentifier: IfcIdentifier;
}

/**
 * IfcAppliedValue
 * @abstract
 */
export interface IfcAppliedValue {
  Name?: IfcLabel;
  Description?: IfcText;
  AppliedValue?: IfcAppliedValueSelect;
  UnitBasis?: IfcMeasureWithUnit;
  ApplicableDate?: IfcDateTimeSelect;
  FixedUntilDate?: IfcDateTimeSelect;
}

/**
 * IfcAppliedValueRelationship
 */
export interface IfcAppliedValueRelationship {
  ComponentOfTotal: IfcAppliedValue;
  Components: IfcAppliedValue[];
  ArithmeticOperator: IfcArithmeticOperatorEnum;
  Name?: IfcLabel;
  Description?: IfcText;
}

/**
 * IfcApproval
 */
export interface IfcApproval {
  Description?: IfcText;
  ApprovalDateTime: IfcDateTimeSelect;
  ApprovalStatus?: IfcLabel;
  ApprovalLevel?: IfcLabel;
  ApprovalQualifier?: IfcText;
  Name: IfcLabel;
  Identifier: IfcIdentifier;
}

/**
 * IfcApprovalActorRelationship
 */
export interface IfcApprovalActorRelationship {
  Actor: IfcActorSelect;
  Approval: IfcApproval;
  Role: IfcActorRole;
}

/**
 * IfcApprovalPropertyRelationship
 */
export interface IfcApprovalPropertyRelationship {
  ApprovedProperties: IfcProperty[];
  Approval: IfcApproval;
}

/**
 * IfcApprovalRelationship
 */
export interface IfcApprovalRelationship {
  RelatedApproval: IfcApproval;
  RelatingApproval: IfcApproval;
  Description?: IfcText;
  Name: IfcLabel;
}

/**
 * IfcProfileDef
 * @abstract
 */
export interface IfcProfileDef {
  ProfileType: IfcProfileTypeEnum;
  ProfileName?: IfcLabel;
}

/**
 * IfcArbitraryClosedProfileDef
 * @extends IfcProfileDef
 */
export interface IfcArbitraryClosedProfileDef extends IfcProfileDef {
  OuterCurve: IfcCurve;
}

/**
 * IfcArbitraryOpenProfileDef
 * @extends IfcProfileDef
 */
export interface IfcArbitraryOpenProfileDef extends IfcProfileDef {
  Curve: IfcBoundedCurve;
}

/**
 * IfcArbitraryProfileDefWithVoids
 * @extends IfcArbitraryClosedProfileDef
 */
export interface IfcArbitraryProfileDefWithVoids extends IfcArbitraryClosedProfileDef {
  InnerCurves: IfcCurve[];
}

/**
 * IfcGroup
 * @extends IfcObject
 */
export interface IfcGroup extends IfcObject {
}

/**
 * IfcAsset
 * @extends IfcGroup
 */
export interface IfcAsset extends IfcGroup {
  AssetID: IfcIdentifier;
  OriginalValue: IfcCostValue;
  CurrentValue: IfcCostValue;
  TotalReplacementCost: IfcCostValue;
  Owner: IfcActorSelect;
  User: IfcActorSelect;
  ResponsiblePerson: IfcPerson;
  IncorporationDate: IfcCalendarDate;
  DepreciatedValue: IfcCostValue;
}

/**
 * IfcParameterizedProfileDef
 * @abstract
 * @extends IfcProfileDef
 */
export interface IfcParameterizedProfileDef extends IfcProfileDef {
  Position: IfcAxis2Placement2D;
}

/**
 * IfcIShapeProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcIShapeProfileDef extends IfcParameterizedProfileDef {
  OverallWidth: number;
  OverallDepth: number;
  WebThickness: number;
  FlangeThickness: number;
  FilletRadius?: number;
}

/**
 * IfcAsymmetricIShapeProfileDef
 * @extends IfcIShapeProfileDef
 */
export interface IfcAsymmetricIShapeProfileDef extends IfcIShapeProfileDef {
  TopFlangeWidth: number;
  TopFlangeThickness?: number;
  TopFlangeFilletRadius?: number;
  CentreOfGravityInY?: number;
}

/**
 * IfcPlacement
 * @abstract
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcPlacement extends IfcGeometricRepresentationItem {
  Location: IfcCartesianPoint;
}

/**
 * IfcAxis1Placement
 * @extends IfcPlacement
 */
export interface IfcAxis1Placement extends IfcPlacement {
  Axis?: IfcDirection;
}

/**
 * IfcAxis2Placement2D
 * @extends IfcPlacement
 */
export interface IfcAxis2Placement2D extends IfcPlacement {
  RefDirection?: IfcDirection;
}

/**
 * IfcAxis2Placement3D
 * @extends IfcPlacement
 */
export interface IfcAxis2Placement3D extends IfcPlacement {
  Axis?: IfcDirection;
  RefDirection?: IfcDirection;
}

/**
 * IfcBSplineCurve
 * @abstract
 * @extends IfcBoundedCurve
 */
export interface IfcBSplineCurve extends IfcBoundedCurve {
  Degree: number;
  ControlPointsList: IfcCartesianPoint[];
  CurveForm: IfcBSplineCurveForm;
  ClosedCurve: boolean | null;
  SelfIntersect: boolean | null;
}

/**
 * IfcElement
 * @abstract
 * @extends IfcProduct
 */
export interface IfcElement extends IfcProduct {
  Tag?: IfcIdentifier;
}

/**
 * IfcBuildingElement
 * @abstract
 * @extends IfcElement
 */
export interface IfcBuildingElement extends IfcElement {
}

/**
 * IfcBeam
 * @extends IfcBuildingElement
 */
export interface IfcBeam extends IfcBuildingElement {
}

/**
 * IfcBuildingElementType
 * @abstract
 * @extends IfcElementType
 */
export interface IfcBuildingElementType extends IfcElementType {
}

/**
 * IfcBeamType
 * @extends IfcBuildingElementType
 */
export interface IfcBeamType extends IfcBuildingElementType {
  PredefinedType: IfcBeamTypeEnum;
}

/**
 * IfcBezierCurve
 * @extends IfcBSplineCurve
 */
export interface IfcBezierCurve extends IfcBSplineCurve {
}

/**
 * IfcSurfaceTexture
 * @abstract
 */
export interface IfcSurfaceTexture {
  RepeatS: boolean;
  RepeatT: boolean;
  TextureType: IfcSurfaceTextureEnum;
  TextureTransform?: IfcCartesianTransformationOperator2D;
}

/**
 * IfcBlobTexture
 * @extends IfcSurfaceTexture
 */
export interface IfcBlobTexture extends IfcSurfaceTexture {
  RasterFormat: IfcIdentifier;
  RasterCode: boolean;
}

/**
 * IfcCsgPrimitive3D
 * @abstract
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcCsgPrimitive3D extends IfcGeometricRepresentationItem {
  Position: IfcAxis2Placement3D;
}

/**
 * IfcBlock
 * @extends IfcCsgPrimitive3D
 */
export interface IfcBlock extends IfcCsgPrimitive3D {
  XLength: number;
  YLength: number;
  ZLength: number;
}

/**
 * IfcBoilerType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcBoilerType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcBoilerTypeEnum;
}

/**
 * IfcBooleanResult
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcBooleanResult extends IfcGeometricRepresentationItem {
  Operator: IfcBooleanOperator;
  FirstOperand: IfcBooleanOperand;
  SecondOperand: IfcBooleanOperand;
}

/**
 * IfcBooleanClippingResult
 * @extends IfcBooleanResult
 */
export interface IfcBooleanClippingResult extends IfcBooleanResult {
}

/**
 * IfcBoundaryCondition
 * @abstract
 */
export interface IfcBoundaryCondition {
  Name?: IfcLabel;
}

/**
 * IfcBoundaryEdgeCondition
 * @extends IfcBoundaryCondition
 */
export interface IfcBoundaryEdgeCondition extends IfcBoundaryCondition {
  LinearStiffnessByLengthX?: number;
  LinearStiffnessByLengthY?: number;
  LinearStiffnessByLengthZ?: number;
  RotationalStiffnessByLengthX?: number;
  RotationalStiffnessByLengthY?: number;
  RotationalStiffnessByLengthZ?: number;
}

/**
 * IfcBoundaryFaceCondition
 * @extends IfcBoundaryCondition
 */
export interface IfcBoundaryFaceCondition extends IfcBoundaryCondition {
  LinearStiffnessByAreaX?: number;
  LinearStiffnessByAreaY?: number;
  LinearStiffnessByAreaZ?: number;
}

/**
 * IfcBoundaryNodeCondition
 * @extends IfcBoundaryCondition
 */
export interface IfcBoundaryNodeCondition extends IfcBoundaryCondition {
  LinearStiffnessX?: number;
  LinearStiffnessY?: number;
  LinearStiffnessZ?: number;
  RotationalStiffnessX?: number;
  RotationalStiffnessY?: number;
  RotationalStiffnessZ?: number;
}

/**
 * IfcBoundaryNodeConditionWarping
 * @extends IfcBoundaryNodeCondition
 */
export interface IfcBoundaryNodeConditionWarping extends IfcBoundaryNodeCondition {
  WarpingStiffness?: number;
}

/**
 * IfcSurface
 * @abstract
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcSurface extends IfcGeometricRepresentationItem {
}

/**
 * IfcBoundedSurface
 * @extends IfcSurface
 */
export interface IfcBoundedSurface extends IfcSurface {
}

/**
 * IfcBoundingBox
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcBoundingBox extends IfcGeometricRepresentationItem {
  Corner: IfcCartesianPoint;
  XDim: number;
  YDim: number;
  ZDim: number;
}

/**
 * IfcHalfSpaceSolid
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcHalfSpaceSolid extends IfcGeometricRepresentationItem {
  BaseSurface: IfcSurface;
  AgreementFlag: boolean;
}

/**
 * IfcBoxedHalfSpace
 * @extends IfcHalfSpaceSolid
 */
export interface IfcBoxedHalfSpace extends IfcHalfSpaceSolid {
  Enclosure: IfcBoundingBox;
}

/**
 * IfcSpatialStructureElement
 * @abstract
 * @extends IfcProduct
 */
export interface IfcSpatialStructureElement extends IfcProduct {
  LongName?: IfcLabel;
  CompositionType: IfcElementCompositionEnum;
}

/**
 * IfcBuilding
 * @extends IfcSpatialStructureElement
 */
export interface IfcBuilding extends IfcSpatialStructureElement {
  ElevationOfRefHeight?: number;
  ElevationOfTerrain?: number;
  BuildingAddress?: IfcPostalAddress;
}

/**
 * IfcBuildingElementComponent
 * @abstract
 * @extends IfcBuildingElement
 */
export interface IfcBuildingElementComponent extends IfcBuildingElement {
}

/**
 * IfcBuildingElementPart
 * @extends IfcBuildingElementComponent
 */
export interface IfcBuildingElementPart extends IfcBuildingElementComponent {
}

/**
 * IfcBuildingElementProxy
 * @extends IfcBuildingElement
 */
export interface IfcBuildingElementProxy extends IfcBuildingElement {
  CompositionType?: IfcElementCompositionEnum;
}

/**
 * IfcBuildingElementProxyType
 * @extends IfcBuildingElementType
 */
export interface IfcBuildingElementProxyType extends IfcBuildingElementType {
  PredefinedType: IfcBuildingElementProxyTypeEnum;
}

/**
 * IfcBuildingStorey
 * @extends IfcSpatialStructureElement
 */
export interface IfcBuildingStorey extends IfcSpatialStructureElement {
  Elevation?: number;
}

/**
 * IfcCShapeProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcCShapeProfileDef extends IfcParameterizedProfileDef {
  Depth: number;
  Width: number;
  WallThickness: number;
  Girth: number;
  InternalFilletRadius?: number;
  CentreOfGravityInX?: number;
}

/**
 * IfcFlowFittingType
 * @abstract
 * @extends IfcDistributionFlowElementType
 */
export interface IfcFlowFittingType extends IfcDistributionFlowElementType {
}

/**
 * IfcCableCarrierFittingType
 * @extends IfcFlowFittingType
 */
export interface IfcCableCarrierFittingType extends IfcFlowFittingType {
  PredefinedType: IfcCableCarrierFittingTypeEnum;
}

/**
 * IfcFlowSegmentType
 * @abstract
 * @extends IfcDistributionFlowElementType
 */
export interface IfcFlowSegmentType extends IfcDistributionFlowElementType {
}

/**
 * IfcCableCarrierSegmentType
 * @extends IfcFlowSegmentType
 */
export interface IfcCableCarrierSegmentType extends IfcFlowSegmentType {
  PredefinedType: IfcCableCarrierSegmentTypeEnum;
}

/**
 * IfcCableSegmentType
 * @extends IfcFlowSegmentType
 */
export interface IfcCableSegmentType extends IfcFlowSegmentType {
  PredefinedType: IfcCableSegmentTypeEnum;
}

/**
 * IfcCalendarDate
 */
export interface IfcCalendarDate {
  DayComponent: IfcDayInMonthNumber;
  MonthComponent: IfcMonthInYearNumber;
  YearComponent: IfcYearNumber;
}

/**
 * IfcPoint
 * @abstract
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcPoint extends IfcGeometricRepresentationItem {
}

/**
 * IfcCartesianPoint
 * @extends IfcPoint
 */
export interface IfcCartesianPoint extends IfcPoint {
  Coordinates: number[];
}

/**
 * IfcCartesianTransformationOperator
 * @abstract
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcCartesianTransformationOperator extends IfcGeometricRepresentationItem {
  Axis1?: IfcDirection;
  Axis2?: IfcDirection;
  LocalOrigin: IfcCartesianPoint;
  Scale?: number;
}

/**
 * IfcCartesianTransformationOperator2D
 * @extends IfcCartesianTransformationOperator
 */
export interface IfcCartesianTransformationOperator2D extends IfcCartesianTransformationOperator {
}

/**
 * IfcCartesianTransformationOperator2DnonUniform
 * @extends IfcCartesianTransformationOperator2D
 */
export interface IfcCartesianTransformationOperator2DnonUniform extends IfcCartesianTransformationOperator2D {
  Scale2?: number;
}

/**
 * IfcCartesianTransformationOperator3D
 * @extends IfcCartesianTransformationOperator
 */
export interface IfcCartesianTransformationOperator3D extends IfcCartesianTransformationOperator {
  Axis3?: IfcDirection;
}

/**
 * IfcCartesianTransformationOperator3DnonUniform
 * @extends IfcCartesianTransformationOperator3D
 */
export interface IfcCartesianTransformationOperator3DnonUniform extends IfcCartesianTransformationOperator3D {
  Scale2?: number;
  Scale3?: number;
}

/**
 * IfcCenterLineProfileDef
 * @extends IfcArbitraryOpenProfileDef
 */
export interface IfcCenterLineProfileDef extends IfcArbitraryOpenProfileDef {
  Thickness: number;
}

/**
 * IfcFeatureElement
 * @abstract
 * @extends IfcElement
 */
export interface IfcFeatureElement extends IfcElement {
}

/**
 * IfcFeatureElementSubtraction
 * @abstract
 * @extends IfcFeatureElement
 */
export interface IfcFeatureElementSubtraction extends IfcFeatureElement {
}

/**
 * IfcEdgeFeature
 * @abstract
 * @extends IfcFeatureElementSubtraction
 */
export interface IfcEdgeFeature extends IfcFeatureElementSubtraction {
  FeatureLength?: number;
}

/**
 * IfcChamferEdgeFeature
 * @extends IfcEdgeFeature
 */
export interface IfcChamferEdgeFeature extends IfcEdgeFeature {
  Width?: number;
  Height?: number;
}

/**
 * IfcChillerType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcChillerType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcChillerTypeEnum;
}

/**
 * IfcConic
 * @abstract
 * @extends IfcCurve
 */
export interface IfcConic extends IfcCurve {
  Position: IfcAxis2Placement;
}

/**
 * IfcCircle
 * @extends IfcConic
 */
export interface IfcCircle extends IfcConic {
  Radius: number;
}

/**
 * IfcCircleProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcCircleProfileDef extends IfcParameterizedProfileDef {
  Radius: number;
}

/**
 * IfcCircleHollowProfileDef
 * @extends IfcCircleProfileDef
 */
export interface IfcCircleHollowProfileDef extends IfcCircleProfileDef {
  WallThickness: number;
}

/**
 * IfcClassification
 */
export interface IfcClassification {
  Source: IfcLabel;
  Edition: IfcLabel;
  EditionDate?: IfcCalendarDate;
  Name: IfcLabel;
}

/**
 * IfcClassificationItem
 */
export interface IfcClassificationItem {
  Notation: IfcClassificationNotationFacet;
  ItemOf?: IfcClassification;
  Title: IfcLabel;
}

/**
 * IfcClassificationItemRelationship
 */
export interface IfcClassificationItemRelationship {
  RelatingItem: IfcClassificationItem;
  RelatedItems: IfcClassificationItem[];
}

/**
 * IfcClassificationNotation
 */
export interface IfcClassificationNotation {
  NotationFacets: IfcClassificationNotationFacet[];
}

/**
 * IfcClassificationNotationFacet
 */
export interface IfcClassificationNotationFacet {
  NotationValue: IfcLabel;
}

/**
 * IfcExternalReference
 * @abstract
 */
export interface IfcExternalReference {
  Location?: IfcLabel;
  ItemReference?: IfcIdentifier;
  Name?: IfcLabel;
}

/**
 * IfcClassificationReference
 * @extends IfcExternalReference
 */
export interface IfcClassificationReference extends IfcExternalReference {
  ReferencedSource?: IfcClassification;
}

/**
 * IfcTopologicalRepresentationItem
 * @abstract
 * @extends IfcRepresentationItem
 */
export interface IfcTopologicalRepresentationItem extends IfcRepresentationItem {
}

/**
 * IfcConnectedFaceSet
 * @extends IfcTopologicalRepresentationItem
 */
export interface IfcConnectedFaceSet extends IfcTopologicalRepresentationItem {
  CfsFaces: IfcFace[];
}

/**
 * IfcClosedShell
 * @extends IfcConnectedFaceSet
 */
export interface IfcClosedShell extends IfcConnectedFaceSet {
}

/**
 * IfcCoilType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcCoilType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcCoilTypeEnum;
}

/**
 * IfcColourSpecification
 * @abstract
 */
export interface IfcColourSpecification {
  Name?: IfcLabel;
}

/**
 * IfcColourRgb
 * @extends IfcColourSpecification
 */
export interface IfcColourRgb extends IfcColourSpecification {
  Red: number;
  Green: number;
  Blue: number;
}

/**
 * IfcColumn
 * @extends IfcBuildingElement
 */
export interface IfcColumn extends IfcBuildingElement {
}

/**
 * IfcColumnType
 * @extends IfcBuildingElementType
 */
export interface IfcColumnType extends IfcBuildingElementType {
  PredefinedType: IfcColumnTypeEnum;
}

/**
 * IfcProperty
 * @abstract
 */
export interface IfcProperty {
  Name: IfcIdentifier;
  Description?: IfcText;
}

/**
 * IfcComplexProperty
 * @extends IfcProperty
 */
export interface IfcComplexProperty extends IfcProperty {
  UsageName: IfcIdentifier;
  HasProperties: IfcProperty[];
}

/**
 * IfcCompositeCurveSegment
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcCompositeCurveSegment extends IfcGeometricRepresentationItem {
  Transition: IfcTransitionCode;
  SameSense: boolean;
  ParentCurve: IfcCurve;
}

/**
 * IfcCompositeProfileDef
 * @extends IfcProfileDef
 */
export interface IfcCompositeProfileDef extends IfcProfileDef {
  Profiles: IfcProfileDef[];
  Label?: IfcLabel;
}

/**
 * IfcFlowMovingDeviceType
 * @abstract
 * @extends IfcDistributionFlowElementType
 */
export interface IfcFlowMovingDeviceType extends IfcDistributionFlowElementType {
}

/**
 * IfcCompressorType
 * @extends IfcFlowMovingDeviceType
 */
export interface IfcCompressorType extends IfcFlowMovingDeviceType {
  PredefinedType: IfcCompressorTypeEnum;
}

/**
 * IfcCondenserType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcCondenserType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcCondenserTypeEnum;
}

/**
 * IfcCondition
 * @extends IfcGroup
 */
export interface IfcCondition extends IfcGroup {
}

/**
 * IfcConditionCriterion
 * @extends IfcControl
 */
export interface IfcConditionCriterion extends IfcControl {
  Criterion: IfcConditionCriterionSelect;
  CriterionDateTime: IfcDateTimeSelect;
}

/**
 * IfcConnectionGeometry
 * @abstract
 */
export interface IfcConnectionGeometry {
}

/**
 * IfcConnectionCurveGeometry
 * @extends IfcConnectionGeometry
 */
export interface IfcConnectionCurveGeometry extends IfcConnectionGeometry {
  CurveOnRelatingElement: IfcCurveOrEdgeCurve;
  CurveOnRelatedElement?: IfcCurveOrEdgeCurve;
}

/**
 * IfcConnectionPointGeometry
 * @extends IfcConnectionGeometry
 */
export interface IfcConnectionPointGeometry extends IfcConnectionGeometry {
  PointOnRelatingElement: IfcPointOrVertexPoint;
  PointOnRelatedElement?: IfcPointOrVertexPoint;
}

/**
 * IfcConnectionPointEccentricity
 * @extends IfcConnectionPointGeometry
 */
export interface IfcConnectionPointEccentricity extends IfcConnectionPointGeometry {
  EccentricityInX?: number;
  EccentricityInY?: number;
  EccentricityInZ?: number;
}

/**
 * IfcConnectionPortGeometry
 * @extends IfcConnectionGeometry
 */
export interface IfcConnectionPortGeometry extends IfcConnectionGeometry {
  LocationAtRelatingElement: IfcAxis2Placement;
  LocationAtRelatedElement?: IfcAxis2Placement;
  ProfileOfPort: IfcProfileDef;
}

/**
 * IfcConnectionSurfaceGeometry
 * @extends IfcConnectionGeometry
 */
export interface IfcConnectionSurfaceGeometry extends IfcConnectionGeometry {
  SurfaceOnRelatingElement: IfcSurfaceOrFaceSurface;
  SurfaceOnRelatedElement?: IfcSurfaceOrFaceSurface;
}

/**
 * IfcConstraint
 * @abstract
 */
export interface IfcConstraint {
  Name: IfcLabel;
  Description?: IfcText;
  ConstraintGrade: IfcConstraintEnum;
  ConstraintSource?: IfcLabel;
  CreatingActor?: IfcActorSelect;
  CreationTime?: IfcDateTimeSelect;
  UserDefinedGrade?: IfcLabel;
}

/**
 * IfcConstraintAggregationRelationship
 */
export interface IfcConstraintAggregationRelationship {
  Name?: IfcLabel;
  Description?: IfcText;
  RelatingConstraint: IfcConstraint;
  RelatedConstraints: IfcConstraint[];
  LogicalAggregator: IfcLogicalOperatorEnum;
}

/**
 * IfcConstraintClassificationRelationship
 */
export interface IfcConstraintClassificationRelationship {
  ClassifiedConstraint: IfcConstraint;
  RelatedClassifications: IfcClassificationNotationSelect[];
}

/**
 * IfcConstraintRelationship
 */
export interface IfcConstraintRelationship {
  Name?: IfcLabel;
  Description?: IfcText;
  RelatingConstraint: IfcConstraint;
  RelatedConstraints: IfcConstraint[];
}

/**
 * IfcResource
 * @abstract
 * @extends IfcObject
 */
export interface IfcResource extends IfcObject {
}

/**
 * IfcConstructionResource
 * @abstract
 * @extends IfcResource
 */
export interface IfcConstructionResource extends IfcResource {
  ResourceIdentifier?: IfcIdentifier;
  ResourceGroup?: IfcLabel;
  ResourceConsumption?: IfcResourceConsumptionEnum;
  BaseQuantity?: IfcMeasureWithUnit;
}

/**
 * IfcConstructionEquipmentResource
 * @extends IfcConstructionResource
 */
export interface IfcConstructionEquipmentResource extends IfcConstructionResource {
}

/**
 * IfcConstructionMaterialResource
 * @extends IfcConstructionResource
 */
export interface IfcConstructionMaterialResource extends IfcConstructionResource {
  Suppliers?: IfcActorSelect[];
  UsageRatio?: number;
}

/**
 * IfcConstructionProductResource
 * @extends IfcConstructionResource
 */
export interface IfcConstructionProductResource extends IfcConstructionResource {
}

/**
 * IfcNamedUnit
 * @abstract
 */
export interface IfcNamedUnit {
  Dimensions: IfcDimensionalExponents;
  UnitType: IfcUnitEnum;
}

/**
 * IfcContextDependentUnit
 * @extends IfcNamedUnit
 */
export interface IfcContextDependentUnit extends IfcNamedUnit {
  Name: IfcLabel;
}

/**
 * IfcControllerType
 * @extends IfcDistributionControlElementType
 */
export interface IfcControllerType extends IfcDistributionControlElementType {
  PredefinedType: IfcControllerTypeEnum;
}

/**
 * IfcConversionBasedUnit
 * @extends IfcNamedUnit
 */
export interface IfcConversionBasedUnit extends IfcNamedUnit {
  Name: IfcLabel;
  ConversionFactor: IfcMeasureWithUnit;
}

/**
 * IfcCooledBeamType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcCooledBeamType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcCooledBeamTypeEnum;
}

/**
 * IfcCoolingTowerType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcCoolingTowerType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcCoolingTowerTypeEnum;
}

/**
 * IfcCoordinatedUniversalTimeOffset
 */
export interface IfcCoordinatedUniversalTimeOffset {
  HourOffset: IfcHourInDay;
  MinuteOffset?: IfcMinuteInHour;
  Sense: IfcAheadOrBehind;
}

/**
 * IfcCostItem
 * @extends IfcControl
 */
export interface IfcCostItem extends IfcControl {
}

/**
 * IfcCostSchedule
 * @extends IfcControl
 */
export interface IfcCostSchedule extends IfcControl {
  SubmittedBy?: IfcActorSelect;
  PreparedBy?: IfcActorSelect;
  SubmittedOn?: IfcDateTimeSelect;
  Status?: IfcLabel;
  TargetUsers?: IfcActorSelect[];
  UpdateDate?: IfcDateTimeSelect;
  ID: IfcIdentifier;
  PredefinedType: IfcCostScheduleTypeEnum;
}

/**
 * IfcCostValue
 * @extends IfcAppliedValue
 */
export interface IfcCostValue extends IfcAppliedValue {
  CostType: IfcLabel;
  Condition?: IfcText;
}

/**
 * IfcCovering
 * @extends IfcBuildingElement
 */
export interface IfcCovering extends IfcBuildingElement {
  PredefinedType?: IfcCoveringTypeEnum;
}

/**
 * IfcCoveringType
 * @extends IfcBuildingElementType
 */
export interface IfcCoveringType extends IfcBuildingElementType {
  PredefinedType: IfcCoveringTypeEnum;
}

/**
 * IfcCraneRailAShapeProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcCraneRailAShapeProfileDef extends IfcParameterizedProfileDef {
  OverallHeight: number;
  BaseWidth2: number;
  Radius?: number;
  HeadWidth: number;
  HeadDepth2: number;
  HeadDepth3: number;
  WebThickness: number;
  BaseWidth4: number;
  BaseDepth1: number;
  BaseDepth2: number;
  BaseDepth3: number;
  CentreOfGravityInY?: number;
}

/**
 * IfcCraneRailFShapeProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcCraneRailFShapeProfileDef extends IfcParameterizedProfileDef {
  OverallHeight: number;
  HeadWidth: number;
  Radius?: number;
  HeadDepth2: number;
  HeadDepth3: number;
  WebThickness: number;
  BaseDepth1: number;
  BaseDepth2: number;
  CentreOfGravityInY?: number;
}

/**
 * IfcCrewResource
 * @extends IfcConstructionResource
 */
export interface IfcCrewResource extends IfcConstructionResource {
}

/**
 * IfcSolidModel
 * @abstract
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcSolidModel extends IfcGeometricRepresentationItem {
}

/**
 * IfcCsgSolid
 * @extends IfcSolidModel
 */
export interface IfcCsgSolid extends IfcSolidModel {
  TreeRootExpression: IfcCsgSelect;
}

/**
 * IfcCurrencyRelationship
 */
export interface IfcCurrencyRelationship {
  RelatingMonetaryUnit: IfcMonetaryUnit;
  RelatedMonetaryUnit: IfcMonetaryUnit;
  ExchangeRate: number;
  RateDateTime: IfcDateAndTime;
  RateSource?: IfcLibraryInformation;
}

/**
 * IfcCurtainWall
 * @extends IfcBuildingElement
 */
export interface IfcCurtainWall extends IfcBuildingElement {
}

/**
 * IfcCurtainWallType
 * @extends IfcBuildingElementType
 */
export interface IfcCurtainWallType extends IfcBuildingElementType {
  PredefinedType: IfcCurtainWallTypeEnum;
}

/**
 * IfcCurveBoundedPlane
 * @extends IfcBoundedSurface
 */
export interface IfcCurveBoundedPlane extends IfcBoundedSurface {
  BasisSurface: IfcPlane;
  OuterBoundary: IfcCurve;
  InnerBoundaries: IfcCurve[];
}

/**
 * IfcPresentationStyle
 * @abstract
 */
export interface IfcPresentationStyle {
  Name?: IfcLabel;
}

/**
 * IfcCurveStyle
 * @extends IfcPresentationStyle
 */
export interface IfcCurveStyle extends IfcPresentationStyle {
  CurveFont?: IfcCurveFontOrScaledCurveFontSelect;
  CurveWidth?: IfcSizeSelect;
  CurveColour?: IfcColour;
}

/**
 * IfcCurveStyleFont
 */
export interface IfcCurveStyleFont {
  Name?: IfcLabel;
  PatternList: IfcCurveStyleFontPattern[];
}

/**
 * IfcCurveStyleFontAndScaling
 */
export interface IfcCurveStyleFontAndScaling {
  Name?: IfcLabel;
  CurveFont: IfcCurveStyleFontSelect;
  CurveFontScaling: number;
}

/**
 * IfcCurveStyleFontPattern
 */
export interface IfcCurveStyleFontPattern {
  VisibleSegmentLength: number;
  InvisibleSegmentLength: number;
}

/**
 * IfcDamperType
 * @extends IfcFlowControllerType
 */
export interface IfcDamperType extends IfcFlowControllerType {
  PredefinedType: IfcDamperTypeEnum;
}

/**
 * IfcDateAndTime
 */
export interface IfcDateAndTime {
  DateComponent: IfcCalendarDate;
  TimeComponent: IfcLocalTime;
}

/**
 * IfcDefinedSymbol
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcDefinedSymbol extends IfcGeometricRepresentationItem {
  Definition: IfcDefinedSymbolSelect;
  Target: IfcCartesianTransformationOperator2D;
}

/**
 * IfcDerivedProfileDef
 * @extends IfcProfileDef
 */
export interface IfcDerivedProfileDef extends IfcProfileDef {
  ParentProfile: IfcProfileDef;
  Operator: IfcCartesianTransformationOperator2D;
  Label?: IfcLabel;
}

/**
 * IfcDerivedUnit
 */
export interface IfcDerivedUnit {
  Elements: IfcDerivedUnitElement[];
  UnitType: IfcDerivedUnitEnum;
  UserDefinedType?: IfcLabel;
}

/**
 * IfcDerivedUnitElement
 */
export interface IfcDerivedUnitElement {
  Unit: IfcNamedUnit;
  Exponent: number;
}

/**
 * IfcDiameterDimension
 * @extends IfcDimensionCurveDirectedCallout
 */
export interface IfcDiameterDimension extends IfcDimensionCurveDirectedCallout {
}

/**
 * IfcDraughtingCalloutRelationship
 */
export interface IfcDraughtingCalloutRelationship {
  Name?: IfcLabel;
  Description?: IfcText;
  RelatingDraughtingCallout: IfcDraughtingCallout;
  RelatedDraughtingCallout: IfcDraughtingCallout;
}

/**
 * IfcDimensionCalloutRelationship
 * @extends IfcDraughtingCalloutRelationship
 */
export interface IfcDimensionCalloutRelationship extends IfcDraughtingCalloutRelationship {
}

/**
 * IfcDimensionCurve
 * @extends IfcAnnotationCurveOccurrence
 */
export interface IfcDimensionCurve extends IfcAnnotationCurveOccurrence {
}

/**
 * IfcTerminatorSymbol
 * @extends IfcAnnotationSymbolOccurrence
 */
export interface IfcTerminatorSymbol extends IfcAnnotationSymbolOccurrence {
  AnnotatedCurve: IfcAnnotationCurveOccurrence;
}

/**
 * IfcDimensionCurveTerminator
 * @extends IfcTerminatorSymbol
 */
export interface IfcDimensionCurveTerminator extends IfcTerminatorSymbol {
  Role: IfcDimensionExtentUsage;
}

/**
 * IfcDimensionPair
 * @extends IfcDraughtingCalloutRelationship
 */
export interface IfcDimensionPair extends IfcDraughtingCalloutRelationship {
}

/**
 * IfcDimensionalExponents
 */
export interface IfcDimensionalExponents {
  LengthExponent: number;
  MassExponent: number;
  TimeExponent: number;
  ElectricCurrentExponent: number;
  ThermodynamicTemperatureExponent: number;
  AmountOfSubstanceExponent: number;
  LuminousIntensityExponent: number;
}

/**
 * IfcDirection
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcDirection extends IfcGeometricRepresentationItem {
  DirectionRatios: number[];
}

/**
 * IfcElementComponent
 * @abstract
 * @extends IfcElement
 */
export interface IfcElementComponent extends IfcElement {
}

/**
 * IfcDiscreteAccessory
 * @extends IfcElementComponent
 */
export interface IfcDiscreteAccessory extends IfcElementComponent {
}

/**
 * IfcElementComponentType
 * @abstract
 * @extends IfcElementType
 */
export interface IfcElementComponentType extends IfcElementType {
}

/**
 * IfcDiscreteAccessoryType
 * @extends IfcElementComponentType
 */
export interface IfcDiscreteAccessoryType extends IfcElementComponentType {
}

/**
 * IfcDistributionElement
 * @extends IfcElement
 */
export interface IfcDistributionElement extends IfcElement {
}

/**
 * IfcDistributionFlowElement
 * @extends IfcDistributionElement
 */
export interface IfcDistributionFlowElement extends IfcDistributionElement {
}

/**
 * IfcDistributionChamberElement
 * @extends IfcDistributionFlowElement
 */
export interface IfcDistributionChamberElement extends IfcDistributionFlowElement {
}

/**
 * IfcDistributionChamberElementType
 * @extends IfcDistributionFlowElementType
 */
export interface IfcDistributionChamberElementType extends IfcDistributionFlowElementType {
  PredefinedType: IfcDistributionChamberElementTypeEnum;
}

/**
 * IfcDistributionControlElement
 * @extends IfcDistributionElement
 */
export interface IfcDistributionControlElement extends IfcDistributionElement {
  ControlElementId?: IfcIdentifier;
}

/**
 * IfcPort
 * @abstract
 * @extends IfcProduct
 */
export interface IfcPort extends IfcProduct {
}

/**
 * IfcDistributionPort
 * @extends IfcPort
 */
export interface IfcDistributionPort extends IfcPort {
  FlowDirection?: IfcFlowDirectionEnum;
}

/**
 * IfcDocumentElectronicFormat
 */
export interface IfcDocumentElectronicFormat {
  FileExtension?: IfcLabel;
  MimeContentType?: IfcLabel;
  MimeSubtype?: IfcLabel;
}

/**
 * IfcDocumentInformation
 */
export interface IfcDocumentInformation {
  DocumentId: IfcIdentifier;
  Name: IfcLabel;
  Description?: IfcText;
  DocumentReferences?: IfcDocumentReference[];
  Purpose?: IfcText;
  IntendedUse?: IfcText;
  Scope?: IfcText;
  Revision?: IfcLabel;
  DocumentOwner?: IfcActorSelect;
  Editors?: IfcActorSelect[];
  CreationTime?: IfcDateAndTime;
  LastRevisionTime?: IfcDateAndTime;
  ElectronicFormat?: IfcDocumentElectronicFormat;
  ValidFrom?: IfcCalendarDate;
  ValidUntil?: IfcCalendarDate;
  Confidentiality?: IfcDocumentConfidentialityEnum;
  Status?: IfcDocumentStatusEnum;
}

/**
 * IfcDocumentInformationRelationship
 */
export interface IfcDocumentInformationRelationship {
  RelatingDocument: IfcDocumentInformation;
  RelatedDocuments: IfcDocumentInformation[];
  RelationshipType?: IfcLabel;
}

/**
 * IfcDocumentReference
 * @extends IfcExternalReference
 */
export interface IfcDocumentReference extends IfcExternalReference {
}

/**
 * IfcDoor
 * @extends IfcBuildingElement
 */
export interface IfcDoor extends IfcBuildingElement {
  OverallHeight?: number;
  OverallWidth?: number;
}

/**
 * IfcPropertyDefinition
 * @abstract
 * @extends IfcRoot
 */
export interface IfcPropertyDefinition extends IfcRoot {
}

/**
 * IfcPropertySetDefinition
 * @abstract
 * @extends IfcPropertyDefinition
 */
export interface IfcPropertySetDefinition extends IfcPropertyDefinition {
}

/**
 * IfcDoorLiningProperties
 * @extends IfcPropertySetDefinition
 */
export interface IfcDoorLiningProperties extends IfcPropertySetDefinition {
  LiningDepth?: number;
  LiningThickness?: number;
  ThresholdDepth?: number;
  ThresholdThickness?: number;
  TransomThickness?: number;
  TransomOffset?: number;
  LiningOffset?: number;
  ThresholdOffset?: number;
  CasingThickness?: number;
  CasingDepth?: number;
  ShapeAspectStyle?: IfcShapeAspect;
}

/**
 * IfcDoorPanelProperties
 * @extends IfcPropertySetDefinition
 */
export interface IfcDoorPanelProperties extends IfcPropertySetDefinition {
  PanelDepth?: number;
  PanelOperation: IfcDoorPanelOperationEnum;
  PanelWidth?: number;
  PanelPosition: IfcDoorPanelPositionEnum;
  ShapeAspectStyle?: IfcShapeAspect;
}

/**
 * IfcDoorStyle
 * @extends IfcTypeProduct
 */
export interface IfcDoorStyle extends IfcTypeProduct {
  OperationType: IfcDoorStyleOperationEnum;
  ConstructionType: IfcDoorStyleConstructionEnum;
  ParameterTakesPrecedence: boolean;
  Sizeable: boolean;
}

/**
 * IfcPreDefinedItem
 * @abstract
 */
export interface IfcPreDefinedItem {
  Name: IfcLabel;
}

/**
 * IfcPreDefinedColour
 * @abstract
 * @extends IfcPreDefinedItem
 */
export interface IfcPreDefinedColour extends IfcPreDefinedItem {
}

/**
 * IfcDraughtingPreDefinedColour
 * @extends IfcPreDefinedColour
 */
export interface IfcDraughtingPreDefinedColour extends IfcPreDefinedColour {
}

/**
 * IfcPreDefinedCurveFont
 * @abstract
 * @extends IfcPreDefinedItem
 */
export interface IfcPreDefinedCurveFont extends IfcPreDefinedItem {
}

/**
 * IfcDraughtingPreDefinedCurveFont
 * @extends IfcPreDefinedCurveFont
 */
export interface IfcDraughtingPreDefinedCurveFont extends IfcPreDefinedCurveFont {
}

/**
 * IfcPreDefinedTextFont
 * @abstract
 * @extends IfcPreDefinedItem
 */
export interface IfcPreDefinedTextFont extends IfcPreDefinedItem {
}

/**
 * IfcDraughtingPreDefinedTextFont
 * @extends IfcPreDefinedTextFont
 */
export interface IfcDraughtingPreDefinedTextFont extends IfcPreDefinedTextFont {
}

/**
 * IfcDuctFittingType
 * @extends IfcFlowFittingType
 */
export interface IfcDuctFittingType extends IfcFlowFittingType {
  PredefinedType: IfcDuctFittingTypeEnum;
}

/**
 * IfcDuctSegmentType
 * @extends IfcFlowSegmentType
 */
export interface IfcDuctSegmentType extends IfcFlowSegmentType {
  PredefinedType: IfcDuctSegmentTypeEnum;
}

/**
 * IfcFlowTreatmentDeviceType
 * @abstract
 * @extends IfcDistributionFlowElementType
 */
export interface IfcFlowTreatmentDeviceType extends IfcDistributionFlowElementType {
}

/**
 * IfcDuctSilencerType
 * @extends IfcFlowTreatmentDeviceType
 */
export interface IfcDuctSilencerType extends IfcFlowTreatmentDeviceType {
  PredefinedType: IfcDuctSilencerTypeEnum;
}

/**
 * IfcEdge
 * @extends IfcTopologicalRepresentationItem
 */
export interface IfcEdge extends IfcTopologicalRepresentationItem {
  EdgeStart: IfcVertex;
  EdgeEnd: IfcVertex;
}

/**
 * IfcEdgeCurve
 * @extends IfcEdge
 */
export interface IfcEdgeCurve extends IfcEdge {
  EdgeGeometry: IfcCurve;
  SameSense: boolean;
}

/**
 * IfcLoop
 * @extends IfcTopologicalRepresentationItem
 */
export interface IfcLoop extends IfcTopologicalRepresentationItem {
}

/**
 * IfcEdgeLoop
 * @extends IfcLoop
 */
export interface IfcEdgeLoop extends IfcLoop {
  EdgeList: IfcOrientedEdge[];
}

/**
 * IfcElectricApplianceType
 * @extends IfcFlowTerminalType
 */
export interface IfcElectricApplianceType extends IfcFlowTerminalType {
  PredefinedType: IfcElectricApplianceTypeEnum;
}

/**
 * IfcFlowController
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowController extends IfcDistributionFlowElement {
}

/**
 * IfcElectricDistributionPoint
 * @extends IfcFlowController
 */
export interface IfcElectricDistributionPoint extends IfcFlowController {
  DistributionPointFunction: IfcElectricDistributionPointFunctionEnum;
  UserDefinedFunction?: IfcLabel;
}

/**
 * IfcFlowStorageDeviceType
 * @abstract
 * @extends IfcDistributionFlowElementType
 */
export interface IfcFlowStorageDeviceType extends IfcDistributionFlowElementType {
}

/**
 * IfcElectricFlowStorageDeviceType
 * @extends IfcFlowStorageDeviceType
 */
export interface IfcElectricFlowStorageDeviceType extends IfcFlowStorageDeviceType {
  PredefinedType: IfcElectricFlowStorageDeviceTypeEnum;
}

/**
 * IfcElectricGeneratorType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcElectricGeneratorType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcElectricGeneratorTypeEnum;
}

/**
 * IfcElectricHeaterType
 * @extends IfcFlowTerminalType
 */
export interface IfcElectricHeaterType extends IfcFlowTerminalType {
  PredefinedType: IfcElectricHeaterTypeEnum;
}

/**
 * IfcElectricMotorType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcElectricMotorType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcElectricMotorTypeEnum;
}

/**
 * IfcElectricTimeControlType
 * @extends IfcFlowControllerType
 */
export interface IfcElectricTimeControlType extends IfcFlowControllerType {
  PredefinedType: IfcElectricTimeControlTypeEnum;
}

/**
 * IfcEnergyProperties
 * @extends IfcPropertySetDefinition
 */
export interface IfcEnergyProperties extends IfcPropertySetDefinition {
  EnergySequence?: IfcEnergySequenceEnum;
  UserDefinedEnergySequence?: IfcLabel;
}

/**
 * IfcElectricalBaseProperties
 * @extends IfcEnergyProperties
 */
export interface IfcElectricalBaseProperties extends IfcEnergyProperties {
  ElectricCurrentType?: IfcElectricCurrentEnum;
  InputVoltage: number;
  InputFrequency: number;
  FullLoadCurrent?: number;
  MinimumCircuitCurrent?: number;
  MaximumPowerInput?: number;
  RatedPowerInput?: number;
  InputPhase: number;
}

/**
 * IfcSystem
 * @extends IfcGroup
 */
export interface IfcSystem extends IfcGroup {
}

/**
 * IfcElectricalCircuit
 * @extends IfcSystem
 */
export interface IfcElectricalCircuit extends IfcSystem {
}

/**
 * IfcElectricalElement
 * @extends IfcElement
 */
export interface IfcElectricalElement extends IfcElement {
}

/**
 * IfcElementAssembly
 * @extends IfcElement
 */
export interface IfcElementAssembly extends IfcElement {
  AssemblyPlace?: IfcAssemblyPlaceEnum;
  PredefinedType: IfcElementAssemblyTypeEnum;
}

/**
 * IfcElementQuantity
 * @extends IfcPropertySetDefinition
 */
export interface IfcElementQuantity extends IfcPropertySetDefinition {
  MethodOfMeasurement?: IfcLabel;
  Quantities: IfcPhysicalQuantity[];
}

/**
 * IfcElementarySurface
 * @abstract
 * @extends IfcSurface
 */
export interface IfcElementarySurface extends IfcSurface {
  Position: IfcAxis2Placement3D;
}

/**
 * IfcEllipse
 * @extends IfcConic
 */
export interface IfcEllipse extends IfcConic {
  SemiAxis1: number;
  SemiAxis2: number;
}

/**
 * IfcEllipseProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcEllipseProfileDef extends IfcParameterizedProfileDef {
  SemiAxis1: number;
  SemiAxis2: number;
}

/**
 * IfcEnergyConversionDevice
 * @extends IfcDistributionFlowElement
 */
export interface IfcEnergyConversionDevice extends IfcDistributionFlowElement {
}

/**
 * IfcEnvironmentalImpactValue
 * @extends IfcAppliedValue
 */
export interface IfcEnvironmentalImpactValue extends IfcAppliedValue {
  ImpactType: IfcLabel;
  Category: IfcEnvironmentalImpactCategoryEnum;
  UserDefinedCategory?: IfcLabel;
}

/**
 * IfcEquipmentElement
 * @extends IfcElement
 */
export interface IfcEquipmentElement extends IfcElement {
}

/**
 * IfcEquipmentStandard
 * @extends IfcControl
 */
export interface IfcEquipmentStandard extends IfcControl {
}

/**
 * IfcEvaporativeCoolerType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcEvaporativeCoolerType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcEvaporativeCoolerTypeEnum;
}

/**
 * IfcEvaporatorType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcEvaporatorType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcEvaporatorTypeEnum;
}

/**
 * IfcMaterialProperties
 * @abstract
 */
export interface IfcMaterialProperties {
  Material: IfcMaterial;
}

/**
 * IfcExtendedMaterialProperties
 * @extends IfcMaterialProperties
 */
export interface IfcExtendedMaterialProperties extends IfcMaterialProperties {
  ExtendedProperties: IfcProperty[];
  Description?: IfcText;
  Name: IfcLabel;
}

/**
 * IfcExternallyDefinedHatchStyle
 * @extends IfcExternalReference
 */
export interface IfcExternallyDefinedHatchStyle extends IfcExternalReference {
}

/**
 * IfcExternallyDefinedSurfaceStyle
 * @extends IfcExternalReference
 */
export interface IfcExternallyDefinedSurfaceStyle extends IfcExternalReference {
}

/**
 * IfcExternallyDefinedSymbol
 * @extends IfcExternalReference
 */
export interface IfcExternallyDefinedSymbol extends IfcExternalReference {
}

/**
 * IfcExternallyDefinedTextFont
 * @extends IfcExternalReference
 */
export interface IfcExternallyDefinedTextFont extends IfcExternalReference {
}

/**
 * IfcSweptAreaSolid
 * @abstract
 * @extends IfcSolidModel
 */
export interface IfcSweptAreaSolid extends IfcSolidModel {
  SweptArea: IfcProfileDef;
  Position: IfcAxis2Placement3D;
}

/**
 * IfcExtrudedAreaSolid
 * @extends IfcSweptAreaSolid
 */
export interface IfcExtrudedAreaSolid extends IfcSweptAreaSolid {
  ExtrudedDirection: IfcDirection;
  Depth: number;
}

/**
 * IfcFace
 * @extends IfcTopologicalRepresentationItem
 */
export interface IfcFace extends IfcTopologicalRepresentationItem {
  Bounds: IfcFaceBound[];
}

/**
 * IfcFaceBasedSurfaceModel
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcFaceBasedSurfaceModel extends IfcGeometricRepresentationItem {
  FbsmFaces: IfcConnectedFaceSet[];
}

/**
 * IfcFaceBound
 * @extends IfcTopologicalRepresentationItem
 */
export interface IfcFaceBound extends IfcTopologicalRepresentationItem {
  Bound: IfcLoop;
  Orientation: boolean;
}

/**
 * IfcFaceOuterBound
 * @extends IfcFaceBound
 */
export interface IfcFaceOuterBound extends IfcFaceBound {
}

/**
 * IfcFaceSurface
 * @extends IfcFace
 */
export interface IfcFaceSurface extends IfcFace {
  FaceSurface: IfcSurface;
  SameSense: boolean;
}

/**
 * IfcManifoldSolidBrep
 * @abstract
 * @extends IfcSolidModel
 */
export interface IfcManifoldSolidBrep extends IfcSolidModel {
  Outer: IfcClosedShell;
}

/**
 * IfcFacetedBrep
 * @extends IfcManifoldSolidBrep
 */
export interface IfcFacetedBrep extends IfcManifoldSolidBrep {
}

/**
 * IfcFacetedBrepWithVoids
 * @extends IfcManifoldSolidBrep
 */
export interface IfcFacetedBrepWithVoids extends IfcManifoldSolidBrep {
  Voids: IfcClosedShell[];
}

/**
 * IfcStructuralConnectionCondition
 * @abstract
 */
export interface IfcStructuralConnectionCondition {
  Name?: IfcLabel;
}

/**
 * IfcFailureConnectionCondition
 * @extends IfcStructuralConnectionCondition
 */
export interface IfcFailureConnectionCondition extends IfcStructuralConnectionCondition {
  TensionFailureX?: number;
  TensionFailureY?: number;
  TensionFailureZ?: number;
  CompressionFailureX?: number;
  CompressionFailureY?: number;
  CompressionFailureZ?: number;
}

/**
 * IfcFanType
 * @extends IfcFlowMovingDeviceType
 */
export interface IfcFanType extends IfcFlowMovingDeviceType {
  PredefinedType: IfcFanTypeEnum;
}

/**
 * IfcFastener
 * @extends IfcElementComponent
 */
export interface IfcFastener extends IfcElementComponent {
}

/**
 * IfcFastenerType
 * @extends IfcElementComponentType
 */
export interface IfcFastenerType extends IfcElementComponentType {
}

/**
 * IfcFeatureElementAddition
 * @abstract
 * @extends IfcFeatureElement
 */
export interface IfcFeatureElementAddition extends IfcFeatureElement {
}

/**
 * IfcFillAreaStyle
 * @extends IfcPresentationStyle
 */
export interface IfcFillAreaStyle extends IfcPresentationStyle {
  FillStyles: IfcFillStyleSelect[];
}

/**
 * IfcFillAreaStyleHatching
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcFillAreaStyleHatching extends IfcGeometricRepresentationItem {
  HatchLineAppearance: IfcCurveStyle;
  StartOfNextHatchLine: IfcHatchLineDistanceSelect;
  PointOfReferenceHatchLine?: IfcCartesianPoint;
  PatternStart?: IfcCartesianPoint;
  HatchLineAngle: number;
}

/**
 * IfcFillAreaStyleTileSymbolWithStyle
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcFillAreaStyleTileSymbolWithStyle extends IfcGeometricRepresentationItem {
  Symbol: IfcAnnotationSymbolOccurrence;
}

/**
 * IfcFillAreaStyleTiles
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcFillAreaStyleTiles extends IfcGeometricRepresentationItem {
  TilingPattern: IfcOneDirectionRepeatFactor;
  Tiles: IfcFillAreaStyleTileShapeSelect[];
  TilingScale: number;
}

/**
 * IfcFilterType
 * @extends IfcFlowTreatmentDeviceType
 */
export interface IfcFilterType extends IfcFlowTreatmentDeviceType {
  PredefinedType: IfcFilterTypeEnum;
}

/**
 * IfcFireSuppressionTerminalType
 * @extends IfcFlowTerminalType
 */
export interface IfcFireSuppressionTerminalType extends IfcFlowTerminalType {
  PredefinedType: IfcFireSuppressionTerminalTypeEnum;
}

/**
 * IfcFlowFitting
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowFitting extends IfcDistributionFlowElement {
}

/**
 * IfcFlowInstrumentType
 * @extends IfcDistributionControlElementType
 */
export interface IfcFlowInstrumentType extends IfcDistributionControlElementType {
  PredefinedType: IfcFlowInstrumentTypeEnum;
}

/**
 * IfcFlowMeterType
 * @extends IfcFlowControllerType
 */
export interface IfcFlowMeterType extends IfcFlowControllerType {
  PredefinedType: IfcFlowMeterTypeEnum;
}

/**
 * IfcFlowMovingDevice
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowMovingDevice extends IfcDistributionFlowElement {
}

/**
 * IfcFlowSegment
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowSegment extends IfcDistributionFlowElement {
}

/**
 * IfcFlowStorageDevice
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowStorageDevice extends IfcDistributionFlowElement {
}

/**
 * IfcFlowTerminal
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowTerminal extends IfcDistributionFlowElement {
}

/**
 * IfcFlowTreatmentDevice
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowTreatmentDevice extends IfcDistributionFlowElement {
}

/**
 * IfcFluidFlowProperties
 * @extends IfcPropertySetDefinition
 */
export interface IfcFluidFlowProperties extends IfcPropertySetDefinition {
  PropertySource: IfcPropertySourceEnum;
  FlowConditionTimeSeries?: IfcTimeSeries;
  VelocityTimeSeries?: IfcTimeSeries;
  FlowrateTimeSeries?: IfcTimeSeries;
  Fluid: IfcMaterial;
  PressureTimeSeries?: IfcTimeSeries;
  UserDefinedPropertySource?: IfcLabel;
  TemperatureSingleValue?: number;
  WetBulbTemperatureSingleValue?: number;
  WetBulbTemperatureTimeSeries?: IfcTimeSeries;
  TemperatureTimeSeries?: IfcTimeSeries;
  FlowrateSingleValue?: IfcDerivedMeasureValue;
  FlowConditionSingleValue?: number;
  VelocitySingleValue?: number;
  PressureSingleValue?: number;
}

/**
 * IfcFooting
 * @extends IfcBuildingElement
 */
export interface IfcFooting extends IfcBuildingElement {
  PredefinedType: IfcFootingTypeEnum;
}

/**
 * IfcFuelProperties
 * @extends IfcMaterialProperties
 */
export interface IfcFuelProperties extends IfcMaterialProperties {
  CombustionTemperature?: number;
  CarbonContent?: number;
  LowerHeatingValue?: number;
  HigherHeatingValue?: number;
}

/**
 * IfcFurnishingElement
 * @extends IfcElement
 */
export interface IfcFurnishingElement extends IfcElement {
}

/**
 * IfcFurnishingElementType
 * @extends IfcElementType
 */
export interface IfcFurnishingElementType extends IfcElementType {
}

/**
 * IfcFurnitureStandard
 * @extends IfcControl
 */
export interface IfcFurnitureStandard extends IfcControl {
}

/**
 * IfcFurnitureType
 * @extends IfcFurnishingElementType
 */
export interface IfcFurnitureType extends IfcFurnishingElementType {
  AssemblyPlace: IfcAssemblyPlaceEnum;
}

/**
 * IfcGasTerminalType
 * @extends IfcFlowTerminalType
 */
export interface IfcGasTerminalType extends IfcFlowTerminalType {
  PredefinedType: IfcGasTerminalTypeEnum;
}

/**
 * IfcGeneralMaterialProperties
 * @extends IfcMaterialProperties
 */
export interface IfcGeneralMaterialProperties extends IfcMaterialProperties {
  MolecularWeight?: number;
  Porosity?: number;
  MassDensity?: number;
}

/**
 * IfcProfileProperties
 * @abstract
 */
export interface IfcProfileProperties {
  ProfileName?: IfcLabel;
  ProfileDefinition?: IfcProfileDef;
}

/**
 * IfcGeneralProfileProperties
 * @extends IfcProfileProperties
 */
export interface IfcGeneralProfileProperties extends IfcProfileProperties {
  PhysicalWeight?: number;
  Perimeter?: number;
  MinimumPlateThickness?: number;
  MaximumPlateThickness?: number;
  CrossSectionArea?: number;
}

/**
 * IfcGeometricSet
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcGeometricSet extends IfcGeometricRepresentationItem {
  Elements: IfcGeometricSetSelect[];
}

/**
 * IfcGeometricCurveSet
 * @extends IfcGeometricSet
 */
export interface IfcGeometricCurveSet extends IfcGeometricSet {
}

/**
 * IfcRepresentationContext
 */
export interface IfcRepresentationContext {
  ContextIdentifier?: IfcLabel;
  ContextType?: IfcLabel;
}

/**
 * IfcGeometricRepresentationContext
 * @extends IfcRepresentationContext
 */
export interface IfcGeometricRepresentationContext extends IfcRepresentationContext {
  CoordinateSpaceDimension: IfcDimensionCount;
  Precision?: number;
  WorldCoordinateSystem: IfcAxis2Placement;
  TrueNorth?: IfcDirection;
}

/**
 * IfcGeometricRepresentationSubContext
 * @extends IfcGeometricRepresentationContext
 */
export interface IfcGeometricRepresentationSubContext extends IfcGeometricRepresentationContext {
  ParentContext: IfcGeometricRepresentationContext;
  TargetScale?: number;
  TargetView: IfcGeometricProjectionEnum;
  UserDefinedTargetView?: IfcLabel;
}

/**
 * IfcGrid
 * @extends IfcProduct
 */
export interface IfcGrid extends IfcProduct {
  UAxes: IfcGridAxis[];
  VAxes: IfcGridAxis[];
  WAxes?: IfcGridAxis[];
}

/**
 * IfcGridAxis
 */
export interface IfcGridAxis {
  AxisTag?: IfcLabel;
  AxisCurve: IfcCurve;
  SameSense: IfcBoolean;
}

/**
 * IfcObjectPlacement
 * @abstract
 */
export interface IfcObjectPlacement {
}

/**
 * IfcGridPlacement
 * @extends IfcObjectPlacement
 */
export interface IfcGridPlacement extends IfcObjectPlacement {
  PlacementLocation: IfcVirtualGridIntersection;
  PlacementRefDirection?: IfcVirtualGridIntersection;
}

/**
 * IfcHeatExchangerType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcHeatExchangerType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcHeatExchangerTypeEnum;
}

/**
 * IfcHumidifierType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcHumidifierType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcHumidifierTypeEnum;
}

/**
 * IfcHygroscopicMaterialProperties
 * @extends IfcMaterialProperties
 */
export interface IfcHygroscopicMaterialProperties extends IfcMaterialProperties {
  UpperVaporResistanceFactor?: number;
  LowerVaporResistanceFactor?: number;
  IsothermalMoistureCapacity?: number;
  VaporPermeability?: number;
  MoistureDiffusivity?: number;
}

/**
 * IfcImageTexture
 * @extends IfcSurfaceTexture
 */
export interface IfcImageTexture extends IfcSurfaceTexture {
  UrlReference: IfcIdentifier;
}

/**
 * IfcInventory
 * @extends IfcGroup
 */
export interface IfcInventory extends IfcGroup {
  InventoryType: IfcInventoryTypeEnum;
  Jurisdiction: IfcActorSelect;
  ResponsiblePersons: IfcPerson[];
  LastUpdateDate: IfcCalendarDate;
  CurrentValue?: IfcCostValue;
  OriginalValue?: IfcCostValue;
}

/**
 * IfcTimeSeries
 * @abstract
 */
export interface IfcTimeSeries {
  Name: IfcLabel;
  Description?: IfcText;
  StartTime: IfcDateTimeSelect;
  EndTime: IfcDateTimeSelect;
  TimeSeriesDataType: IfcTimeSeriesDataTypeEnum;
  DataOrigin: IfcDataOriginEnum;
  UserDefinedDataOrigin?: IfcLabel;
  Unit?: IfcUnit;
}

/**
 * IfcIrregularTimeSeries
 * @extends IfcTimeSeries
 */
export interface IfcIrregularTimeSeries extends IfcTimeSeries {
  Values: IfcIrregularTimeSeriesValue[];
}

/**
 * IfcIrregularTimeSeriesValue
 */
export interface IfcIrregularTimeSeriesValue {
  TimeStamp: IfcDateTimeSelect;
  ListValues: IfcValue[];
}

/**
 * IfcJunctionBoxType
 * @extends IfcFlowFittingType
 */
export interface IfcJunctionBoxType extends IfcFlowFittingType {
  PredefinedType: IfcJunctionBoxTypeEnum;
}

/**
 * IfcLShapeProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcLShapeProfileDef extends IfcParameterizedProfileDef {
  Depth: number;
  Width?: number;
  Thickness: number;
  FilletRadius?: number;
  EdgeRadius?: number;
  LegSlope?: number;
  CentreOfGravityInX?: number;
  CentreOfGravityInY?: number;
}

/**
 * IfcLaborResource
 * @extends IfcConstructionResource
 */
export interface IfcLaborResource extends IfcConstructionResource {
  SkillSet?: IfcText;
}

/**
 * IfcLampType
 * @extends IfcFlowTerminalType
 */
export interface IfcLampType extends IfcFlowTerminalType {
  PredefinedType: IfcLampTypeEnum;
}

/**
 * IfcLibraryInformation
 */
export interface IfcLibraryInformation {
  Name: IfcLabel;
  Version?: IfcLabel;
  Publisher?: IfcOrganization;
  VersionDate?: IfcCalendarDate;
  LibraryReference?: IfcLibraryReference[];
}

/**
 * IfcLibraryReference
 * @extends IfcExternalReference
 */
export interface IfcLibraryReference extends IfcExternalReference {
}

/**
 * IfcLightDistributionData
 */
export interface IfcLightDistributionData {
  MainPlaneAngle: number;
  SecondaryPlaneAngle: number[];
  LuminousIntensity: number[];
}

/**
 * IfcLightFixtureType
 * @extends IfcFlowTerminalType
 */
export interface IfcLightFixtureType extends IfcFlowTerminalType {
  PredefinedType: IfcLightFixtureTypeEnum;
}

/**
 * IfcLightIntensityDistribution
 */
export interface IfcLightIntensityDistribution {
  LightDistributionCurve: IfcLightDistributionCurveEnum;
  DistributionData: IfcLightDistributionData[];
}

/**
 * IfcLightSource
 * @abstract
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcLightSource extends IfcGeometricRepresentationItem {
  Name?: IfcLabel;
  LightColour: IfcColourRgb;
  AmbientIntensity?: number;
  Intensity?: number;
}

/**
 * IfcLightSourceAmbient
 * @extends IfcLightSource
 */
export interface IfcLightSourceAmbient extends IfcLightSource {
}

/**
 * IfcLightSourceDirectional
 * @extends IfcLightSource
 */
export interface IfcLightSourceDirectional extends IfcLightSource {
  Orientation: IfcDirection;
}

/**
 * IfcLightSourceGoniometric
 * @extends IfcLightSource
 */
export interface IfcLightSourceGoniometric extends IfcLightSource {
  Position: IfcAxis2Placement3D;
  ColourAppearance?: IfcColourRgb;
  ColourTemperature: number;
  LuminousFlux: number;
  LightEmissionSource: IfcLightEmissionSourceEnum;
  LightDistributionDataSource: IfcLightDistributionDataSourceSelect;
}

/**
 * IfcLightSourcePositional
 * @extends IfcLightSource
 */
export interface IfcLightSourcePositional extends IfcLightSource {
  Position: IfcCartesianPoint;
  Radius: number;
  ConstantAttenuation: IfcReal;
  DistanceAttenuation: IfcReal;
  QuadricAttenuation: IfcReal;
}

/**
 * IfcLightSourceSpot
 * @extends IfcLightSourcePositional
 */
export interface IfcLightSourceSpot extends IfcLightSourcePositional {
  Orientation: IfcDirection;
  ConcentrationExponent?: IfcReal;
  SpreadAngle: number;
  BeamWidthAngle: number;
}

/**
 * IfcLine
 * @extends IfcCurve
 */
export interface IfcLine extends IfcCurve {
  Pnt: IfcCartesianPoint;
  Dir: IfcVector;
}

/**
 * IfcLinearDimension
 * @extends IfcDimensionCurveDirectedCallout
 */
export interface IfcLinearDimension extends IfcDimensionCurveDirectedCallout {
}

/**
 * IfcLocalPlacement
 * @extends IfcObjectPlacement
 */
export interface IfcLocalPlacement extends IfcObjectPlacement {
  PlacementRelTo?: IfcObjectPlacement;
  RelativePlacement: IfcAxis2Placement;
}

/**
 * IfcLocalTime
 */
export interface IfcLocalTime {
  HourComponent: IfcHourInDay;
  MinuteComponent?: IfcMinuteInHour;
  SecondComponent?: IfcSecondInMinute;
  Zone?: IfcCoordinatedUniversalTimeOffset;
  DaylightSavingOffset?: IfcDaylightSavingHour;
}

/**
 * IfcMappedItem
 * @extends IfcRepresentationItem
 */
export interface IfcMappedItem extends IfcRepresentationItem {
  MappingSource: IfcRepresentationMap;
  MappingTarget: IfcCartesianTransformationOperator;
}

/**
 * IfcMaterial
 */
export interface IfcMaterial {
  Name: IfcLabel;
}

/**
 * IfcMaterialClassificationRelationship
 */
export interface IfcMaterialClassificationRelationship {
  MaterialClassifications: IfcClassificationNotationSelect[];
  ClassifiedMaterial: IfcMaterial;
}

/**
 * IfcProductRepresentation
 */
export interface IfcProductRepresentation {
  Name?: IfcLabel;
  Description?: IfcText;
  Representations: IfcRepresentation[];
}

/**
 * IfcMaterialDefinitionRepresentation
 * @extends IfcProductRepresentation
 */
export interface IfcMaterialDefinitionRepresentation extends IfcProductRepresentation {
  RepresentedMaterial: IfcMaterial;
}

/**
 * IfcMaterialLayer
 */
export interface IfcMaterialLayer {
  Material?: IfcMaterial;
  LayerThickness: number;
  IsVentilated?: IfcLogical;
}

/**
 * IfcMaterialLayerSet
 */
export interface IfcMaterialLayerSet {
  MaterialLayers: IfcMaterialLayer[];
  LayerSetName?: IfcLabel;
}

/**
 * IfcMaterialLayerSetUsage
 */
export interface IfcMaterialLayerSetUsage {
  ForLayerSet: IfcMaterialLayerSet;
  LayerSetDirection: IfcLayerSetDirectionEnum;
  DirectionSense: IfcDirectionSenseEnum;
  OffsetFromReferenceLine: number;
}

/**
 * IfcMaterialList
 */
export interface IfcMaterialList {
  Materials: IfcMaterial[];
}

/**
 * IfcMeasureWithUnit
 */
export interface IfcMeasureWithUnit {
  ValueComponent: IfcValue;
  UnitComponent: IfcUnit;
}

/**
 * IfcMechanicalMaterialProperties
 * @extends IfcMaterialProperties
 */
export interface IfcMechanicalMaterialProperties extends IfcMaterialProperties {
  DynamicViscosity?: number;
  YoungModulus?: number;
  ShearModulus?: number;
  PoissonRatio?: number;
  ThermalExpansionCoefficient?: number;
}

/**
 * IfcMechanicalConcreteMaterialProperties
 * @extends IfcMechanicalMaterialProperties
 */
export interface IfcMechanicalConcreteMaterialProperties extends IfcMechanicalMaterialProperties {
  CompressiveStrength?: number;
  MaxAggregateSize?: number;
  AdmixturesDescription?: IfcText;
  Workability?: IfcText;
  ProtectivePoreRatio?: number;
  WaterImpermeability?: IfcText;
}

/**
 * IfcMechanicalFastener
 * @extends IfcFastener
 */
export interface IfcMechanicalFastener extends IfcFastener {
  NominalDiameter?: number;
  NominalLength?: number;
}

/**
 * IfcMechanicalFastenerType
 * @extends IfcFastenerType
 */
export interface IfcMechanicalFastenerType extends IfcFastenerType {
}

/**
 * IfcMechanicalSteelMaterialProperties
 * @extends IfcMechanicalMaterialProperties
 */
export interface IfcMechanicalSteelMaterialProperties extends IfcMechanicalMaterialProperties {
  YieldStress?: number;
  UltimateStress?: number;
  UltimateStrain?: number;
  HardeningModule?: number;
  ProportionalStress?: number;
  PlasticStrain?: number;
  Relaxations?: IfcRelaxation[];
}

/**
 * IfcMember
 * @extends IfcBuildingElement
 */
export interface IfcMember extends IfcBuildingElement {
}

/**
 * IfcMemberType
 * @extends IfcBuildingElementType
 */
export interface IfcMemberType extends IfcBuildingElementType {
  PredefinedType: IfcMemberTypeEnum;
}

/**
 * IfcMetric
 * @extends IfcConstraint
 */
export interface IfcMetric extends IfcConstraint {
  Benchmark: IfcBenchmarkEnum;
  ValueSource?: IfcLabel;
  DataValue: IfcMetricValueSelect;
}

/**
 * IfcMonetaryUnit
 */
export interface IfcMonetaryUnit {
  Currency: IfcCurrencyEnum;
}

/**
 * IfcMotorConnectionType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcMotorConnectionType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcMotorConnectionTypeEnum;
}

/**
 * IfcProcess
 * @abstract
 * @extends IfcObject
 */
export interface IfcProcess extends IfcObject {
}

/**
 * IfcTask
 * @extends IfcProcess
 */
export interface IfcTask extends IfcProcess {
  TaskId: IfcIdentifier;
  Status?: IfcLabel;
  WorkMethod?: IfcLabel;
  IsMilestone: boolean;
  Priority?: number;
}

/**
 * IfcMove
 * @extends IfcTask
 */
export interface IfcMove extends IfcTask {
  MoveFrom: IfcSpatialStructureElement;
  MoveTo: IfcSpatialStructureElement;
  PunchList?: IfcText[];
}

/**
 * IfcObjective
 * @extends IfcConstraint
 */
export interface IfcObjective extends IfcConstraint {
  BenchmarkValues?: IfcMetric;
  ResultValues?: IfcMetric;
  ObjectiveQualifier: IfcObjectiveEnum;
  UserDefinedQualifier?: IfcLabel;
}

/**
 * IfcOccupant
 * @extends IfcActor
 */
export interface IfcOccupant extends IfcActor {
  PredefinedType: IfcOccupantTypeEnum;
}

/**
 * IfcOffsetCurve2D
 * @extends IfcCurve
 */
export interface IfcOffsetCurve2D extends IfcCurve {
  BasisCurve: IfcCurve;
  Distance: number;
  SelfIntersect: boolean | null;
}

/**
 * IfcOffsetCurve3D
 * @extends IfcCurve
 */
export interface IfcOffsetCurve3D extends IfcCurve {
  BasisCurve: IfcCurve;
  Distance: number;
  SelfIntersect: boolean | null;
  RefDirection: IfcDirection;
}

/**
 * IfcOneDirectionRepeatFactor
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcOneDirectionRepeatFactor extends IfcGeometricRepresentationItem {
  RepeatFactor: IfcVector;
}

/**
 * IfcOpenShell
 * @extends IfcConnectedFaceSet
 */
export interface IfcOpenShell extends IfcConnectedFaceSet {
}

/**
 * IfcOpeningElement
 * @extends IfcFeatureElementSubtraction
 */
export interface IfcOpeningElement extends IfcFeatureElementSubtraction {
}

/**
 * IfcOpticalMaterialProperties
 * @extends IfcMaterialProperties
 */
export interface IfcOpticalMaterialProperties extends IfcMaterialProperties {
  VisibleTransmittance?: number;
  SolarTransmittance?: number;
  ThermalIrTransmittance?: number;
  ThermalIrEmissivityBack?: number;
  ThermalIrEmissivityFront?: number;
  VisibleReflectanceBack?: number;
  VisibleReflectanceFront?: number;
  SolarReflectanceFront?: number;
  SolarReflectanceBack?: number;
}

/**
 * IfcOrderAction
 * @extends IfcTask
 */
export interface IfcOrderAction extends IfcTask {
  ActionID: IfcIdentifier;
}

/**
 * IfcOrganization
 */
export interface IfcOrganization {
  Id?: IfcIdentifier;
  Name: IfcLabel;
  Description?: IfcText;
  Roles?: IfcActorRole[];
  Addresses?: IfcAddress[];
}

/**
 * IfcOrganizationRelationship
 */
export interface IfcOrganizationRelationship {
  Name: IfcLabel;
  Description?: IfcText;
  RelatingOrganization: IfcOrganization;
  RelatedOrganizations: IfcOrganization[];
}

/**
 * IfcOrientedEdge
 * @extends IfcEdge
 */
export interface IfcOrientedEdge extends IfcEdge {
  EdgeElement: IfcEdge;
  Orientation: boolean;
}

/**
 * IfcOutletType
 * @extends IfcFlowTerminalType
 */
export interface IfcOutletType extends IfcFlowTerminalType {
  PredefinedType: IfcOutletTypeEnum;
}

/**
 * IfcOwnerHistory
 */
export interface IfcOwnerHistory {
  OwningUser: IfcPersonAndOrganization;
  OwningApplication: IfcApplication;
  State?: IfcStateEnum;
  ChangeAction: IfcChangeActionEnum;
  LastModifiedDate?: IfcTimeStamp;
  LastModifyingUser?: IfcPersonAndOrganization;
  LastModifyingApplication?: IfcApplication;
  CreationDate: IfcTimeStamp;
}

/**
 * IfcPath
 * @extends IfcTopologicalRepresentationItem
 */
export interface IfcPath extends IfcTopologicalRepresentationItem {
  EdgeList: IfcOrientedEdge[];
}

/**
 * IfcPerformanceHistory
 * @extends IfcControl
 */
export interface IfcPerformanceHistory extends IfcControl {
  LifeCyclePhase: IfcLabel;
}

/**
 * IfcPermeableCoveringProperties
 * @extends IfcPropertySetDefinition
 */
export interface IfcPermeableCoveringProperties extends IfcPropertySetDefinition {
  OperationType: IfcPermeableCoveringOperationEnum;
  PanelPosition: IfcWindowPanelPositionEnum;
  FrameDepth?: number;
  FrameThickness?: number;
  ShapeAspectStyle?: IfcShapeAspect;
}

/**
 * IfcPermit
 * @extends IfcControl
 */
export interface IfcPermit extends IfcControl {
  PermitID: IfcIdentifier;
}

/**
 * IfcPerson
 */
export interface IfcPerson {
  Id?: IfcIdentifier;
  FamilyName?: IfcLabel;
  GivenName?: IfcLabel;
  MiddleNames?: IfcLabel[];
  PrefixTitles?: IfcLabel[];
  SuffixTitles?: IfcLabel[];
  Roles?: IfcActorRole[];
  Addresses?: IfcAddress[];
}

/**
 * IfcPersonAndOrganization
 */
export interface IfcPersonAndOrganization {
  ThePerson: IfcPerson;
  TheOrganization: IfcOrganization;
  Roles?: IfcActorRole[];
}

/**
 * IfcPhysicalQuantity
 * @abstract
 */
export interface IfcPhysicalQuantity {
  Name: IfcLabel;
  Description?: IfcText;
}

/**
 * IfcPhysicalComplexQuantity
 * @extends IfcPhysicalQuantity
 */
export interface IfcPhysicalComplexQuantity extends IfcPhysicalQuantity {
  HasQuantities: IfcPhysicalQuantity[];
  Discrimination: IfcLabel;
  Quality?: IfcLabel;
  Usage?: IfcLabel;
}

/**
 * IfcPhysicalSimpleQuantity
 * @abstract
 * @extends IfcPhysicalQuantity
 */
export interface IfcPhysicalSimpleQuantity extends IfcPhysicalQuantity {
  Unit?: IfcNamedUnit;
}

/**
 * IfcPile
 * @extends IfcBuildingElement
 */
export interface IfcPile extends IfcBuildingElement {
  PredefinedType: IfcPileTypeEnum;
  ConstructionType?: IfcPileConstructionEnum;
}

/**
 * IfcPipeFittingType
 * @extends IfcFlowFittingType
 */
export interface IfcPipeFittingType extends IfcFlowFittingType {
  PredefinedType: IfcPipeFittingTypeEnum;
}

/**
 * IfcPipeSegmentType
 * @extends IfcFlowSegmentType
 */
export interface IfcPipeSegmentType extends IfcFlowSegmentType {
  PredefinedType: IfcPipeSegmentTypeEnum;
}

/**
 * IfcPixelTexture
 * @extends IfcSurfaceTexture
 */
export interface IfcPixelTexture extends IfcSurfaceTexture {
  Width: IfcInteger;
  Height: IfcInteger;
  ColourComponents: IfcInteger;
  Pixel: string[];
}

/**
 * IfcPlanarExtent
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcPlanarExtent extends IfcGeometricRepresentationItem {
  SizeInX: number;
  SizeInY: number;
}

/**
 * IfcPlanarBox
 * @extends IfcPlanarExtent
 */
export interface IfcPlanarBox extends IfcPlanarExtent {
  Placement: IfcAxis2Placement;
}

/**
 * IfcPlane
 * @extends IfcElementarySurface
 */
export interface IfcPlane extends IfcElementarySurface {
}

/**
 * IfcPlate
 * @extends IfcBuildingElement
 */
export interface IfcPlate extends IfcBuildingElement {
}

/**
 * IfcPlateType
 * @extends IfcBuildingElementType
 */
export interface IfcPlateType extends IfcBuildingElementType {
  PredefinedType: IfcPlateTypeEnum;
}

/**
 * IfcPointOnCurve
 * @extends IfcPoint
 */
export interface IfcPointOnCurve extends IfcPoint {
  BasisCurve: IfcCurve;
  PointParameter: IfcParameterValue;
}

/**
 * IfcPointOnSurface
 * @extends IfcPoint
 */
export interface IfcPointOnSurface extends IfcPoint {
  BasisSurface: IfcSurface;
  PointParameterU: IfcParameterValue;
  PointParameterV: IfcParameterValue;
}

/**
 * IfcPolyLoop
 * @extends IfcLoop
 */
export interface IfcPolyLoop extends IfcLoop {
  Polygon: IfcCartesianPoint[];
}

/**
 * IfcPolygonalBoundedHalfSpace
 * @extends IfcHalfSpaceSolid
 */
export interface IfcPolygonalBoundedHalfSpace extends IfcHalfSpaceSolid {
  Position: IfcAxis2Placement3D;
  PolygonalBoundary: IfcBoundedCurve;
}

/**
 * IfcPolyline
 * @extends IfcBoundedCurve
 */
export interface IfcPolyline extends IfcBoundedCurve {
  Points: IfcCartesianPoint[];
}

/**
 * IfcPostalAddress
 * @extends IfcAddress
 */
export interface IfcPostalAddress extends IfcAddress {
  InternalLocation?: IfcLabel;
  AddressLines?: IfcLabel[];
  PostalBox?: IfcLabel;
  Town?: IfcLabel;
  Region?: IfcLabel;
  PostalCode?: IfcLabel;
  Country?: IfcLabel;
}

/**
 * IfcPreDefinedSymbol
 * @abstract
 * @extends IfcPreDefinedItem
 */
export interface IfcPreDefinedSymbol extends IfcPreDefinedItem {
}

/**
 * IfcPreDefinedDimensionSymbol
 * @extends IfcPreDefinedSymbol
 */
export interface IfcPreDefinedDimensionSymbol extends IfcPreDefinedSymbol {
}

/**
 * IfcPreDefinedPointMarkerSymbol
 * @extends IfcPreDefinedSymbol
 */
export interface IfcPreDefinedPointMarkerSymbol extends IfcPreDefinedSymbol {
}

/**
 * IfcPreDefinedTerminatorSymbol
 * @extends IfcPreDefinedSymbol
 */
export interface IfcPreDefinedTerminatorSymbol extends IfcPreDefinedSymbol {
}

/**
 * IfcPresentationLayerAssignment
 */
export interface IfcPresentationLayerAssignment {
  Name: IfcLabel;
  Description?: IfcText;
  AssignedItems: IfcLayeredItem[];
  Identifier?: IfcIdentifier;
}

/**
 * IfcPresentationLayerWithStyle
 * @extends IfcPresentationLayerAssignment
 */
export interface IfcPresentationLayerWithStyle extends IfcPresentationLayerAssignment {
  LayerOn: boolean | null;
  LayerFrozen: boolean | null;
  LayerBlocked: boolean | null;
  LayerStyles: IfcPresentationStyleSelect[];
}

/**
 * IfcPresentationStyleAssignment
 */
export interface IfcPresentationStyleAssignment {
  Styles: IfcPresentationStyleSelect[];
}

/**
 * IfcProcedure
 * @extends IfcProcess
 */
export interface IfcProcedure extends IfcProcess {
  ProcedureID: IfcIdentifier;
  ProcedureType: IfcProcedureTypeEnum;
  UserDefinedProcedureType?: IfcLabel;
}

/**
 * IfcProductDefinitionShape
 * @extends IfcProductRepresentation
 */
export interface IfcProductDefinitionShape extends IfcProductRepresentation {
}

/**
 * IfcProductsOfCombustionProperties
 * @extends IfcMaterialProperties
 */
export interface IfcProductsOfCombustionProperties extends IfcMaterialProperties {
  SpecificHeatCapacity?: number;
  N20Content?: number;
  COContent?: number;
  CO2Content?: number;
}

/**
 * IfcProject
 * @extends IfcObject
 */
export interface IfcProject extends IfcObject {
  LongName?: IfcLabel;
  Phase?: IfcLabel;
  RepresentationContexts: IfcRepresentationContext[];
  UnitsInContext: IfcUnitAssignment;
}

/**
 * IfcProjectOrder
 * @extends IfcControl
 */
export interface IfcProjectOrder extends IfcControl {
  ID: IfcIdentifier;
  PredefinedType: IfcProjectOrderTypeEnum;
  Status?: IfcLabel;
}

/**
 * IfcProjectOrderRecord
 * @extends IfcControl
 */
export interface IfcProjectOrderRecord extends IfcControl {
  Records: IfcRelAssignsToProjectOrder[];
  PredefinedType: IfcProjectOrderRecordTypeEnum;
}

/**
 * IfcProjectionCurve
 * @extends IfcAnnotationCurveOccurrence
 */
export interface IfcProjectionCurve extends IfcAnnotationCurveOccurrence {
}

/**
 * IfcProjectionElement
 * @extends IfcFeatureElementAddition
 */
export interface IfcProjectionElement extends IfcFeatureElementAddition {
}

/**
 * IfcSimpleProperty
 * @abstract
 * @extends IfcProperty
 */
export interface IfcSimpleProperty extends IfcProperty {
}

/**
 * IfcPropertyBoundedValue
 * @extends IfcSimpleProperty
 */
export interface IfcPropertyBoundedValue extends IfcSimpleProperty {
  UpperBoundValue?: IfcValue;
  LowerBoundValue?: IfcValue;
  Unit?: IfcUnit;
}

/**
 * IfcPropertyConstraintRelationship
 */
export interface IfcPropertyConstraintRelationship {
  RelatingConstraint: IfcConstraint;
  RelatedProperties: IfcProperty[];
  Name?: IfcLabel;
  Description?: IfcText;
}

/**
 * IfcPropertyDependencyRelationship
 */
export interface IfcPropertyDependencyRelationship {
  DependingProperty: IfcProperty;
  DependantProperty: IfcProperty;
  Name?: IfcLabel;
  Description?: IfcText;
  Expression?: IfcText;
}

/**
 * IfcPropertyEnumeratedValue
 * @extends IfcSimpleProperty
 */
export interface IfcPropertyEnumeratedValue extends IfcSimpleProperty {
  EnumerationValues: IfcValue[];
  EnumerationReference?: IfcPropertyEnumeration;
}

/**
 * IfcPropertyEnumeration
 */
export interface IfcPropertyEnumeration {
  Name: IfcLabel;
  EnumerationValues: IfcValue[];
  Unit?: IfcUnit;
}

/**
 * IfcPropertyListValue
 * @extends IfcSimpleProperty
 */
export interface IfcPropertyListValue extends IfcSimpleProperty {
  ListValues: IfcValue[];
  Unit?: IfcUnit;
}

/**
 * IfcPropertyReferenceValue
 * @extends IfcSimpleProperty
 */
export interface IfcPropertyReferenceValue extends IfcSimpleProperty {
  UsageName?: IfcLabel;
  PropertyReference: IfcObjectReferenceSelect;
}

/**
 * IfcPropertySet
 * @extends IfcPropertySetDefinition
 */
export interface IfcPropertySet extends IfcPropertySetDefinition {
  HasProperties: IfcProperty[];
}

/**
 * IfcPropertySingleValue
 * @extends IfcSimpleProperty
 */
export interface IfcPropertySingleValue extends IfcSimpleProperty {
  NominalValue?: IfcValue;
  Unit?: IfcUnit;
}

/**
 * IfcPropertyTableValue
 * @extends IfcSimpleProperty
 */
export interface IfcPropertyTableValue extends IfcSimpleProperty {
  DefiningValues: IfcValue[];
  DefinedValues: IfcValue[];
  Expression?: IfcText;
  DefiningUnit?: IfcUnit;
  DefinedUnit?: IfcUnit;
}

/**
 * IfcProtectiveDeviceType
 * @extends IfcFlowControllerType
 */
export interface IfcProtectiveDeviceType extends IfcFlowControllerType {
  PredefinedType: IfcProtectiveDeviceTypeEnum;
}

/**
 * IfcProxy
 * @extends IfcProduct
 */
export interface IfcProxy extends IfcProduct {
  ProxyType: IfcObjectTypeEnum;
  Tag?: IfcLabel;
}

/**
 * IfcPumpType
 * @extends IfcFlowMovingDeviceType
 */
export interface IfcPumpType extends IfcFlowMovingDeviceType {
  PredefinedType: IfcPumpTypeEnum;
}

/**
 * IfcQuantityArea
 * @extends IfcPhysicalSimpleQuantity
 */
export interface IfcQuantityArea extends IfcPhysicalSimpleQuantity {
  AreaValue: number;
}

/**
 * IfcQuantityCount
 * @extends IfcPhysicalSimpleQuantity
 */
export interface IfcQuantityCount extends IfcPhysicalSimpleQuantity {
  CountValue: number;
}

/**
 * IfcQuantityLength
 * @extends IfcPhysicalSimpleQuantity
 */
export interface IfcQuantityLength extends IfcPhysicalSimpleQuantity {
  LengthValue: number;
}

/**
 * IfcQuantityTime
 * @extends IfcPhysicalSimpleQuantity
 */
export interface IfcQuantityTime extends IfcPhysicalSimpleQuantity {
  TimeValue: number;
}

/**
 * IfcQuantityVolume
 * @extends IfcPhysicalSimpleQuantity
 */
export interface IfcQuantityVolume extends IfcPhysicalSimpleQuantity {
  VolumeValue: number;
}

/**
 * IfcQuantityWeight
 * @extends IfcPhysicalSimpleQuantity
 */
export interface IfcQuantityWeight extends IfcPhysicalSimpleQuantity {
  WeightValue: number;
}

/**
 * IfcRadiusDimension
 * @extends IfcDimensionCurveDirectedCallout
 */
export interface IfcRadiusDimension extends IfcDimensionCurveDirectedCallout {
}

/**
 * IfcRailing
 * @extends IfcBuildingElement
 */
export interface IfcRailing extends IfcBuildingElement {
  PredefinedType?: IfcRailingTypeEnum;
}

/**
 * IfcRailingType
 * @extends IfcBuildingElementType
 */
export interface IfcRailingType extends IfcBuildingElementType {
  PredefinedType: IfcRailingTypeEnum;
}

/**
 * IfcRamp
 * @extends IfcBuildingElement
 */
export interface IfcRamp extends IfcBuildingElement {
  ShapeType: IfcRampTypeEnum;
}

/**
 * IfcRampFlight
 * @extends IfcBuildingElement
 */
export interface IfcRampFlight extends IfcBuildingElement {
}

/**
 * IfcRampFlightType
 * @extends IfcBuildingElementType
 */
export interface IfcRampFlightType extends IfcBuildingElementType {
  PredefinedType: IfcRampFlightTypeEnum;
}

/**
 * IfcRationalBezierCurve
 * @extends IfcBezierCurve
 */
export interface IfcRationalBezierCurve extends IfcBezierCurve {
  WeightsData: number[];
}

/**
 * IfcRectangleProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcRectangleProfileDef extends IfcParameterizedProfileDef {
  XDim: number;
  YDim: number;
}

/**
 * IfcRectangleHollowProfileDef
 * @extends IfcRectangleProfileDef
 */
export interface IfcRectangleHollowProfileDef extends IfcRectangleProfileDef {
  WallThickness: number;
  InnerFilletRadius?: number;
  OuterFilletRadius?: number;
}

/**
 * IfcRectangularPyramid
 * @extends IfcCsgPrimitive3D
 */
export interface IfcRectangularPyramid extends IfcCsgPrimitive3D {
  XLength: number;
  YLength: number;
  Height: number;
}

/**
 * IfcRectangularTrimmedSurface
 * @extends IfcBoundedSurface
 */
export interface IfcRectangularTrimmedSurface extends IfcBoundedSurface {
  BasisSurface: IfcSurface;
  U1: IfcParameterValue;
  V1: IfcParameterValue;
  U2: IfcParameterValue;
  V2: IfcParameterValue;
  Usense: boolean;
  Vsense: boolean;
}

/**
 * IfcReferencesValueDocument
 */
export interface IfcReferencesValueDocument {
  ReferencedDocument: IfcDocumentSelect;
  ReferencingValues: IfcAppliedValue[];
  Name?: IfcLabel;
  Description?: IfcText;
}

/**
 * IfcRegularTimeSeries
 * @extends IfcTimeSeries
 */
export interface IfcRegularTimeSeries extends IfcTimeSeries {
  TimeStep: number;
  Values: IfcTimeSeriesValue[];
}

/**
 * IfcReinforcementBarProperties
 */
export interface IfcReinforcementBarProperties {
  TotalCrossSectionArea: number;
  SteelGrade: IfcLabel;
  BarSurface?: IfcReinforcingBarSurfaceEnum;
  EffectiveDepth?: number;
  NominalBarDiameter?: number;
  BarCount?: number;
}

/**
 * IfcReinforcementDefinitionProperties
 * @extends IfcPropertySetDefinition
 */
export interface IfcReinforcementDefinitionProperties extends IfcPropertySetDefinition {
  DefinitionType?: IfcLabel;
  ReinforcementSectionDefinitions: IfcSectionReinforcementProperties[];
}

/**
 * IfcReinforcingElement
 * @abstract
 * @extends IfcBuildingElementComponent
 */
export interface IfcReinforcingElement extends IfcBuildingElementComponent {
  SteelGrade?: IfcLabel;
}

/**
 * IfcReinforcingBar
 * @extends IfcReinforcingElement
 */
export interface IfcReinforcingBar extends IfcReinforcingElement {
  NominalDiameter: number;
  CrossSectionArea: number;
  BarLength?: number;
  BarRole: IfcReinforcingBarRoleEnum;
  BarSurface?: IfcReinforcingBarSurfaceEnum;
}

/**
 * IfcReinforcingMesh
 * @extends IfcReinforcingElement
 */
export interface IfcReinforcingMesh extends IfcReinforcingElement {
  MeshLength?: number;
  MeshWidth?: number;
  LongitudinalBarNominalDiameter: number;
  TransverseBarNominalDiameter: number;
  LongitudinalBarCrossSectionArea: number;
  TransverseBarCrossSectionArea: number;
  LongitudinalBarSpacing: number;
  TransverseBarSpacing: number;
}

/**
 * IfcRelationship
 * @abstract
 * @extends IfcRoot
 */
export interface IfcRelationship extends IfcRoot {
}

/**
 * IfcRelDecomposes
 * @abstract
 * @extends IfcRelationship
 */
export interface IfcRelDecomposes extends IfcRelationship {
  RelatingObject: IfcObjectDefinition;
  RelatedObjects: IfcObjectDefinition[];
}

/**
 * IfcRelAggregates
 * @extends IfcRelDecomposes
 */
export interface IfcRelAggregates extends IfcRelDecomposes {
}

/**
 * IfcRelAssigns
 * @abstract
 * @extends IfcRelationship
 */
export interface IfcRelAssigns extends IfcRelationship {
  RelatedObjects: IfcObjectDefinition[];
  RelatedObjectsType?: IfcObjectTypeEnum;
}

/**
 * IfcRelAssignsToControl
 * @extends IfcRelAssigns
 */
export interface IfcRelAssignsToControl extends IfcRelAssigns {
  RelatingControl: IfcControl;
}

/**
 * IfcRelAssignsTasks
 * @extends IfcRelAssignsToControl
 */
export interface IfcRelAssignsTasks extends IfcRelAssignsToControl {
  TimeForTask?: IfcScheduleTimeControl;
}

/**
 * IfcRelAssignsToActor
 * @extends IfcRelAssigns
 */
export interface IfcRelAssignsToActor extends IfcRelAssigns {
  RelatingActor: IfcActor;
  ActingRole?: IfcActorRole;
}

/**
 * IfcRelAssignsToGroup
 * @extends IfcRelAssigns
 */
export interface IfcRelAssignsToGroup extends IfcRelAssigns {
  RelatingGroup: IfcGroup;
}

/**
 * IfcRelAssignsToProcess
 * @extends IfcRelAssigns
 */
export interface IfcRelAssignsToProcess extends IfcRelAssigns {
  RelatingProcess: IfcProcess;
  QuantityInProcess?: IfcMeasureWithUnit;
}

/**
 * IfcRelAssignsToProduct
 * @extends IfcRelAssigns
 */
export interface IfcRelAssignsToProduct extends IfcRelAssigns {
  RelatingProduct: IfcProduct;
}

/**
 * IfcRelAssignsToProjectOrder
 * @extends IfcRelAssignsToControl
 */
export interface IfcRelAssignsToProjectOrder extends IfcRelAssignsToControl {
}

/**
 * IfcRelAssignsToResource
 * @extends IfcRelAssigns
 */
export interface IfcRelAssignsToResource extends IfcRelAssigns {
  RelatingResource: IfcResource;
}

/**
 * IfcRelAssociates
 * @extends IfcRelationship
 */
export interface IfcRelAssociates extends IfcRelationship {
  RelatedObjects: IfcRoot[];
}

/**
 * IfcRelAssociatesAppliedValue
 * @extends IfcRelAssociates
 */
export interface IfcRelAssociatesAppliedValue extends IfcRelAssociates {
  RelatingAppliedValue: IfcAppliedValue;
}

/**
 * IfcRelAssociatesApproval
 * @extends IfcRelAssociates
 */
export interface IfcRelAssociatesApproval extends IfcRelAssociates {
  RelatingApproval: IfcApproval;
}

/**
 * IfcRelAssociatesClassification
 * @extends IfcRelAssociates
 */
export interface IfcRelAssociatesClassification extends IfcRelAssociates {
  RelatingClassification: IfcClassificationNotationSelect;
}

/**
 * IfcRelAssociatesConstraint
 * @extends IfcRelAssociates
 */
export interface IfcRelAssociatesConstraint extends IfcRelAssociates {
  Intent: IfcLabel;
  RelatingConstraint: IfcConstraint;
}

/**
 * IfcRelAssociatesDocument
 * @extends IfcRelAssociates
 */
export interface IfcRelAssociatesDocument extends IfcRelAssociates {
  RelatingDocument: IfcDocumentSelect;
}

/**
 * IfcRelAssociatesLibrary
 * @extends IfcRelAssociates
 */
export interface IfcRelAssociatesLibrary extends IfcRelAssociates {
  RelatingLibrary: IfcLibrarySelect;
}

/**
 * IfcRelAssociatesMaterial
 * @extends IfcRelAssociates
 */
export interface IfcRelAssociatesMaterial extends IfcRelAssociates {
  RelatingMaterial: IfcMaterialSelect;
}

/**
 * IfcRelAssociatesProfileProperties
 * @extends IfcRelAssociates
 */
export interface IfcRelAssociatesProfileProperties extends IfcRelAssociates {
  RelatingProfileProperties: IfcProfileProperties;
  ProfileSectionLocation?: IfcShapeAspect;
  ProfileOrientation?: IfcOrientationSelect;
}

/**
 * IfcRelConnects
 * @abstract
 * @extends IfcRelationship
 */
export interface IfcRelConnects extends IfcRelationship {
}

/**
 * IfcRelConnectsElements
 * @extends IfcRelConnects
 */
export interface IfcRelConnectsElements extends IfcRelConnects {
  ConnectionGeometry?: IfcConnectionGeometry;
  RelatingElement: IfcElement;
  RelatedElement: IfcElement;
}

/**
 * IfcRelConnectsPathElements
 * @extends IfcRelConnectsElements
 */
export interface IfcRelConnectsPathElements extends IfcRelConnectsElements {
  RelatingPriorities: number[];
  RelatedPriorities: number[];
  RelatedConnectionType: IfcConnectionTypeEnum;
  RelatingConnectionType: IfcConnectionTypeEnum;
}

/**
 * IfcRelConnectsPortToElement
 * @extends IfcRelConnects
 */
export interface IfcRelConnectsPortToElement extends IfcRelConnects {
  RelatingPort: IfcPort;
  RelatedElement: IfcElement;
}

/**
 * IfcRelConnectsPorts
 * @extends IfcRelConnects
 */
export interface IfcRelConnectsPorts extends IfcRelConnects {
  RelatingPort: IfcPort;
  RelatedPort: IfcPort;
  RealizingElement?: IfcElement;
}

/**
 * IfcRelConnectsStructuralActivity
 * @extends IfcRelConnects
 */
export interface IfcRelConnectsStructuralActivity extends IfcRelConnects {
  RelatingElement: IfcStructuralActivityAssignmentSelect;
  RelatedStructuralActivity: IfcStructuralActivity;
}

/**
 * IfcRelConnectsStructuralElement
 * @extends IfcRelConnects
 */
export interface IfcRelConnectsStructuralElement extends IfcRelConnects {
  RelatingElement: IfcElement;
  RelatedStructuralMember: IfcStructuralMember;
}

/**
 * IfcRelConnectsStructuralMember
 * @extends IfcRelConnects
 */
export interface IfcRelConnectsStructuralMember extends IfcRelConnects {
  RelatingStructuralMember: IfcStructuralMember;
  RelatedStructuralConnection: IfcStructuralConnection;
  AppliedCondition?: IfcBoundaryCondition;
  AdditionalConditions?: IfcStructuralConnectionCondition;
  SupportedLength?: number;
  ConditionCoordinateSystem?: IfcAxis2Placement3D;
}

/**
 * IfcRelConnectsWithEccentricity
 * @extends IfcRelConnectsStructuralMember
 */
export interface IfcRelConnectsWithEccentricity extends IfcRelConnectsStructuralMember {
  ConnectionConstraint: IfcConnectionGeometry;
}

/**
 * IfcRelConnectsWithRealizingElements
 * @extends IfcRelConnectsElements
 */
export interface IfcRelConnectsWithRealizingElements extends IfcRelConnectsElements {
  RealizingElements: IfcElement[];
  ConnectionType?: IfcLabel;
}

/**
 * IfcRelContainedInSpatialStructure
 * @extends IfcRelConnects
 */
export interface IfcRelContainedInSpatialStructure extends IfcRelConnects {
  RelatedElements: IfcProduct[];
  RelatingStructure: IfcSpatialStructureElement;
}

/**
 * IfcRelCoversBldgElements
 * @extends IfcRelConnects
 */
export interface IfcRelCoversBldgElements extends IfcRelConnects {
  RelatingBuildingElement: IfcElement;
  RelatedCoverings: IfcCovering[];
}

/**
 * IfcRelCoversSpaces
 * @extends IfcRelConnects
 */
export interface IfcRelCoversSpaces extends IfcRelConnects {
  RelatedSpace: IfcSpace;
  RelatedCoverings: IfcCovering[];
}

/**
 * IfcRelDefines
 * @abstract
 * @extends IfcRelationship
 */
export interface IfcRelDefines extends IfcRelationship {
  RelatedObjects: IfcObject[];
}

/**
 * IfcRelDefinesByProperties
 * @extends IfcRelDefines
 */
export interface IfcRelDefinesByProperties extends IfcRelDefines {
  RelatingPropertyDefinition: IfcPropertySetDefinition;
}

/**
 * IfcRelDefinesByType
 * @extends IfcRelDefines
 */
export interface IfcRelDefinesByType extends IfcRelDefines {
  RelatingType: IfcTypeObject;
}

/**
 * IfcRelFillsElement
 * @extends IfcRelConnects
 */
export interface IfcRelFillsElement extends IfcRelConnects {
  RelatingOpeningElement: IfcOpeningElement;
  RelatedBuildingElement: IfcElement;
}

/**
 * IfcRelFlowControlElements
 * @extends IfcRelConnects
 */
export interface IfcRelFlowControlElements extends IfcRelConnects {
  RelatedControlElements: IfcDistributionControlElement[];
  RelatingFlowElement: IfcDistributionFlowElement;
}

/**
 * IfcRelInteractionRequirements
 * @extends IfcRelConnects
 */
export interface IfcRelInteractionRequirements extends IfcRelConnects {
  DailyInteraction?: number;
  ImportanceRating?: number;
  LocationOfInteraction?: IfcSpatialStructureElement;
  RelatedSpaceProgram: IfcSpaceProgram;
  RelatingSpaceProgram: IfcSpaceProgram;
}

/**
 * IfcRelNests
 * @extends IfcRelDecomposes
 */
export interface IfcRelNests extends IfcRelDecomposes {
}

/**
 * IfcRelOccupiesSpaces
 * @extends IfcRelAssignsToActor
 */
export interface IfcRelOccupiesSpaces extends IfcRelAssignsToActor {
}

/**
 * IfcRelOverridesProperties
 * @extends IfcRelDefinesByProperties
 */
export interface IfcRelOverridesProperties extends IfcRelDefinesByProperties {
  OverridingProperties: IfcProperty[];
}

/**
 * IfcRelProjectsElement
 * @extends IfcRelConnects
 */
export interface IfcRelProjectsElement extends IfcRelConnects {
  RelatingElement: IfcElement;
  RelatedFeatureElement: IfcFeatureElementAddition;
}

/**
 * IfcRelReferencedInSpatialStructure
 * @extends IfcRelConnects
 */
export interface IfcRelReferencedInSpatialStructure extends IfcRelConnects {
  RelatedElements: IfcProduct[];
  RelatingStructure: IfcSpatialStructureElement;
}

/**
 * IfcRelSchedulesCostItems
 * @extends IfcRelAssignsToControl
 */
export interface IfcRelSchedulesCostItems extends IfcRelAssignsToControl {
}

/**
 * IfcRelSequence
 * @extends IfcRelConnects
 */
export interface IfcRelSequence extends IfcRelConnects {
  RelatingProcess: IfcProcess;
  RelatedProcess: IfcProcess;
  TimeLag: number;
  SequenceType: IfcSequenceEnum;
}

/**
 * IfcRelServicesBuildings
 * @extends IfcRelConnects
 */
export interface IfcRelServicesBuildings extends IfcRelConnects {
  RelatingSystem: IfcSystem;
  RelatedBuildings: IfcSpatialStructureElement[];
}

/**
 * IfcRelSpaceBoundary
 * @extends IfcRelConnects
 */
export interface IfcRelSpaceBoundary extends IfcRelConnects {
  RelatingSpace: IfcSpace;
  RelatedBuildingElement?: IfcElement;
  ConnectionGeometry?: IfcConnectionGeometry;
  PhysicalOrVirtualBoundary: IfcPhysicalOrVirtualEnum;
  InternalOrExternalBoundary: IfcInternalOrExternalEnum;
}

/**
 * IfcRelVoidsElement
 * @extends IfcRelConnects
 */
export interface IfcRelVoidsElement extends IfcRelConnects {
  RelatingBuildingElement: IfcElement;
  RelatedOpeningElement: IfcFeatureElementSubtraction;
}

/**
 * IfcRelaxation
 */
export interface IfcRelaxation {
  RelaxationValue: number;
  InitialStress: number;
}

/**
 * IfcRepresentation
 */
export interface IfcRepresentation {
  ContextOfItems: IfcRepresentationContext;
  RepresentationIdentifier?: IfcLabel;
  RepresentationType?: IfcLabel;
  Items: IfcRepresentationItem[];
}

/**
 * IfcRepresentationMap
 */
export interface IfcRepresentationMap {
  MappingOrigin: IfcAxis2Placement;
  MappedRepresentation: IfcRepresentation;
}

/**
 * IfcRevolvedAreaSolid
 * @extends IfcSweptAreaSolid
 */
export interface IfcRevolvedAreaSolid extends IfcSweptAreaSolid {
  Axis: IfcAxis1Placement;
  Angle: number;
}

/**
 * IfcRibPlateProfileProperties
 * @extends IfcProfileProperties
 */
export interface IfcRibPlateProfileProperties extends IfcProfileProperties {
  Thickness?: number;
  RibHeight?: number;
  RibWidth?: number;
  RibSpacing?: number;
  Direction: IfcRibPlateDirectionEnum;
}

/**
 * IfcRightCircularCone
 * @extends IfcCsgPrimitive3D
 */
export interface IfcRightCircularCone extends IfcCsgPrimitive3D {
  Height: number;
  BottomRadius: number;
}

/**
 * IfcRightCircularCylinder
 * @extends IfcCsgPrimitive3D
 */
export interface IfcRightCircularCylinder extends IfcCsgPrimitive3D {
  Height: number;
  Radius: number;
}

/**
 * IfcRoof
 * @extends IfcBuildingElement
 */
export interface IfcRoof extends IfcBuildingElement {
  ShapeType: IfcRoofTypeEnum;
}

/**
 * IfcRoundedEdgeFeature
 * @extends IfcEdgeFeature
 */
export interface IfcRoundedEdgeFeature extends IfcEdgeFeature {
  Radius?: number;
}

/**
 * IfcRoundedRectangleProfileDef
 * @extends IfcRectangleProfileDef
 */
export interface IfcRoundedRectangleProfileDef extends IfcRectangleProfileDef {
  RoundingRadius: number;
}

/**
 * IfcSIUnit
 * @extends IfcNamedUnit
 */
export interface IfcSIUnit extends IfcNamedUnit {
  Prefix?: IfcSIPrefix;
  Name: IfcSIUnitName;
}

/**
 * IfcSanitaryTerminalType
 * @extends IfcFlowTerminalType
 */
export interface IfcSanitaryTerminalType extends IfcFlowTerminalType {
  PredefinedType: IfcSanitaryTerminalTypeEnum;
}

/**
 * IfcScheduleTimeControl
 * @extends IfcControl
 */
export interface IfcScheduleTimeControl extends IfcControl {
  ActualStart?: IfcDateTimeSelect;
  EarlyStart?: IfcDateTimeSelect;
  LateStart?: IfcDateTimeSelect;
  ScheduleStart?: IfcDateTimeSelect;
  ActualFinish?: IfcDateTimeSelect;
  EarlyFinish?: IfcDateTimeSelect;
  LateFinish?: IfcDateTimeSelect;
  ScheduleFinish?: IfcDateTimeSelect;
  ScheduleDuration?: number;
  ActualDuration?: number;
  RemainingTime?: number;
  FreeFloat?: number;
  TotalFloat?: number;
  IsCritical?: boolean;
  StatusTime?: IfcDateTimeSelect;
  StartFloat?: number;
  FinishFloat?: number;
  Completion?: number;
}

/**
 * IfcSectionProperties
 */
export interface IfcSectionProperties {
  SectionType: IfcSectionTypeEnum;
  StartProfile: IfcProfileDef;
  EndProfile?: IfcProfileDef;
}

/**
 * IfcSectionReinforcementProperties
 */
export interface IfcSectionReinforcementProperties {
  LongitudinalStartPosition: number;
  LongitudinalEndPosition: number;
  TransversePosition?: number;
  ReinforcementRole: IfcReinforcingBarRoleEnum;
  SectionDefinition: IfcSectionProperties;
  CrossSectionReinforcementDefinitions: IfcReinforcementBarProperties[];
}

/**
 * IfcSectionedSpine
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcSectionedSpine extends IfcGeometricRepresentationItem {
  SpineCurve: IfcCompositeCurve;
  CrossSections: IfcProfileDef[];
  CrossSectionPositions: IfcAxis2Placement3D[];
}

/**
 * IfcSensorType
 * @extends IfcDistributionControlElementType
 */
export interface IfcSensorType extends IfcDistributionControlElementType {
  PredefinedType: IfcSensorTypeEnum;
}

/**
 * IfcServiceLife
 * @extends IfcControl
 */
export interface IfcServiceLife extends IfcControl {
  ServiceLifeType: IfcServiceLifeTypeEnum;
  ServiceLifeDuration: number;
}

/**
 * IfcServiceLifeFactor
 * @extends IfcPropertySetDefinition
 */
export interface IfcServiceLifeFactor extends IfcPropertySetDefinition {
  PredefinedType: IfcServiceLifeFactorTypeEnum;
  UpperValue?: IfcMeasureValue;
  MostUsedValue: IfcMeasureValue;
  LowerValue?: IfcMeasureValue;
}

/**
 * IfcShapeAspect
 */
export interface IfcShapeAspect {
  ShapeRepresentations: IfcShapeModel[];
  Name?: IfcLabel;
  Description?: IfcText;
  ProductDefinitional: boolean | null;
  PartOfProductDefinitionShape: IfcProductDefinitionShape;
}

/**
 * IfcShapeModel
 * @abstract
 * @extends IfcRepresentation
 */
export interface IfcShapeModel extends IfcRepresentation {
}

/**
 * IfcShapeRepresentation
 * @extends IfcShapeModel
 */
export interface IfcShapeRepresentation extends IfcShapeModel {
}

/**
 * IfcShellBasedSurfaceModel
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcShellBasedSurfaceModel extends IfcGeometricRepresentationItem {
  SbsmBoundary: IfcShell[];
}

/**
 * IfcSite
 * @extends IfcSpatialStructureElement
 */
export interface IfcSite extends IfcSpatialStructureElement {
  RefLatitude?: number;
  RefLongitude?: number;
  RefElevation?: number;
  LandTitleNumber?: IfcLabel;
  SiteAddress?: IfcPostalAddress;
}

/**
 * IfcSlab
 * @extends IfcBuildingElement
 */
export interface IfcSlab extends IfcBuildingElement {
  PredefinedType?: IfcSlabTypeEnum;
}

/**
 * IfcSlabType
 * @extends IfcBuildingElementType
 */
export interface IfcSlabType extends IfcBuildingElementType {
  PredefinedType: IfcSlabTypeEnum;
}

/**
 * IfcSlippageConnectionCondition
 * @extends IfcStructuralConnectionCondition
 */
export interface IfcSlippageConnectionCondition extends IfcStructuralConnectionCondition {
  SlippageX?: number;
  SlippageY?: number;
  SlippageZ?: number;
}

/**
 * IfcSoundProperties
 * @extends IfcPropertySetDefinition
 */
export interface IfcSoundProperties extends IfcPropertySetDefinition {
  IsAttenuating: IfcBoolean;
  SoundScale?: IfcSoundScaleEnum;
  SoundValues: IfcSoundValue[];
}

/**
 * IfcSoundValue
 * @extends IfcPropertySetDefinition
 */
export interface IfcSoundValue extends IfcPropertySetDefinition {
  SoundLevelTimeSeries?: IfcTimeSeries;
  Frequency: number;
  SoundLevelSingleValue?: IfcDerivedMeasureValue;
}

/**
 * IfcSpace
 * @extends IfcSpatialStructureElement
 */
export interface IfcSpace extends IfcSpatialStructureElement {
  InteriorOrExteriorSpace: IfcInternalOrExternalEnum;
  ElevationWithFlooring?: number;
}

/**
 * IfcSpaceHeaterType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcSpaceHeaterType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcSpaceHeaterTypeEnum;
}

/**
 * IfcSpaceProgram
 * @extends IfcControl
 */
export interface IfcSpaceProgram extends IfcControl {
  SpaceProgramIdentifier: IfcIdentifier;
  MaxRequiredArea?: number;
  MinRequiredArea?: number;
  RequestedLocation?: IfcSpatialStructureElement;
  StandardRequiredArea: number;
}

/**
 * IfcSpaceThermalLoadProperties
 * @extends IfcPropertySetDefinition
 */
export interface IfcSpaceThermalLoadProperties extends IfcPropertySetDefinition {
  ApplicableValueRatio?: number;
  ThermalLoadSource: IfcThermalLoadSourceEnum;
  PropertySource: IfcPropertySourceEnum;
  SourceDescription?: IfcText;
  MaximumValue: number;
  MinimumValue?: number;
  ThermalLoadTimeSeriesValues?: IfcTimeSeries;
  UserDefinedThermalLoadSource?: IfcLabel;
  UserDefinedPropertySource?: IfcLabel;
  ThermalLoadType: IfcThermalLoadTypeEnum;
}

/**
 * IfcSpatialStructureElementType
 * @abstract
 * @extends IfcElementType
 */
export interface IfcSpatialStructureElementType extends IfcElementType {
}

/**
 * IfcSpaceType
 * @extends IfcSpatialStructureElementType
 */
export interface IfcSpaceType extends IfcSpatialStructureElementType {
  PredefinedType: IfcSpaceTypeEnum;
}

/**
 * IfcSphere
 * @extends IfcCsgPrimitive3D
 */
export interface IfcSphere extends IfcCsgPrimitive3D {
  Radius: number;
}

/**
 * IfcStackTerminalType
 * @extends IfcFlowTerminalType
 */
export interface IfcStackTerminalType extends IfcFlowTerminalType {
  PredefinedType: IfcStackTerminalTypeEnum;
}

/**
 * IfcStair
 * @extends IfcBuildingElement
 */
export interface IfcStair extends IfcBuildingElement {
  ShapeType: IfcStairTypeEnum;
}

/**
 * IfcStairFlight
 * @extends IfcBuildingElement
 */
export interface IfcStairFlight extends IfcBuildingElement {
  NumberOfRiser?: number;
  NumberOfTreads?: number;
  RiserHeight?: number;
  TreadLength?: number;
}

/**
 * IfcStairFlightType
 * @extends IfcBuildingElementType
 */
export interface IfcStairFlightType extends IfcBuildingElementType {
  PredefinedType: IfcStairFlightTypeEnum;
}

/**
 * IfcStructuralActivity
 * @abstract
 * @extends IfcProduct
 */
export interface IfcStructuralActivity extends IfcProduct {
  AppliedLoad: IfcStructuralLoad;
  GlobalOrLocal: IfcGlobalOrLocalEnum;
}

/**
 * IfcStructuralAction
 * @abstract
 * @extends IfcStructuralActivity
 */
export interface IfcStructuralAction extends IfcStructuralActivity {
  DestabilizingLoad: boolean;
  CausedBy?: IfcStructuralReaction;
}

/**
 * IfcStructuralAnalysisModel
 * @extends IfcSystem
 */
export interface IfcStructuralAnalysisModel extends IfcSystem {
  PredefinedType: IfcAnalysisModelTypeEnum;
  OrientationOf2DPlane?: IfcAxis2Placement3D;
  LoadedBy?: IfcStructuralLoadGroup[];
  HasResults?: IfcStructuralResultGroup[];
}

/**
 * IfcStructuralItem
 * @abstract
 * @extends IfcProduct
 */
export interface IfcStructuralItem extends IfcProduct {
}

/**
 * IfcStructuralConnection
 * @abstract
 * @extends IfcStructuralItem
 */
export interface IfcStructuralConnection extends IfcStructuralItem {
  AppliedCondition?: IfcBoundaryCondition;
}

/**
 * IfcStructuralCurveConnection
 * @extends IfcStructuralConnection
 */
export interface IfcStructuralCurveConnection extends IfcStructuralConnection {
}

/**
 * IfcStructuralMember
 * @abstract
 * @extends IfcStructuralItem
 */
export interface IfcStructuralMember extends IfcStructuralItem {
}

/**
 * IfcStructuralCurveMember
 * @extends IfcStructuralMember
 */
export interface IfcStructuralCurveMember extends IfcStructuralMember {
  PredefinedType: IfcStructuralCurveTypeEnum;
}

/**
 * IfcStructuralCurveMemberVarying
 * @extends IfcStructuralCurveMember
 */
export interface IfcStructuralCurveMemberVarying extends IfcStructuralCurveMember {
}

/**
 * IfcStructuralLinearAction
 * @extends IfcStructuralAction
 */
export interface IfcStructuralLinearAction extends IfcStructuralAction {
  ProjectedOrTrue: IfcProjectedOrTrueLengthEnum;
}

/**
 * IfcStructuralLinearActionVarying
 * @extends IfcStructuralLinearAction
 */
export interface IfcStructuralLinearActionVarying extends IfcStructuralLinearAction {
  VaryingAppliedLoadLocation: IfcShapeAspect;
  SubsequentAppliedLoads: IfcStructuralLoad[];
}

/**
 * IfcStructuralLoad
 * @abstract
 */
export interface IfcStructuralLoad {
  Name?: IfcLabel;
}

/**
 * IfcStructuralLoadGroup
 * @extends IfcGroup
 */
export interface IfcStructuralLoadGroup extends IfcGroup {
  PredefinedType: IfcLoadGroupTypeEnum;
  ActionType: IfcActionTypeEnum;
  ActionSource: IfcActionSourceTypeEnum;
  Coefficient?: number;
  Purpose?: IfcLabel;
}

/**
 * IfcStructuralLoadStatic
 * @abstract
 * @extends IfcStructuralLoad
 */
export interface IfcStructuralLoadStatic extends IfcStructuralLoad {
}

/**
 * IfcStructuralLoadLinearForce
 * @extends IfcStructuralLoadStatic
 */
export interface IfcStructuralLoadLinearForce extends IfcStructuralLoadStatic {
  LinearForceX?: number;
  LinearForceY?: number;
  LinearForceZ?: number;
  LinearMomentX?: number;
  LinearMomentY?: number;
  LinearMomentZ?: number;
}

/**
 * IfcStructuralLoadPlanarForce
 * @extends IfcStructuralLoadStatic
 */
export interface IfcStructuralLoadPlanarForce extends IfcStructuralLoadStatic {
  PlanarForceX?: number;
  PlanarForceY?: number;
  PlanarForceZ?: number;
}

/**
 * IfcStructuralLoadSingleDisplacement
 * @extends IfcStructuralLoadStatic
 */
export interface IfcStructuralLoadSingleDisplacement extends IfcStructuralLoadStatic {
  DisplacementX?: number;
  DisplacementY?: number;
  DisplacementZ?: number;
  RotationalDisplacementRX?: number;
  RotationalDisplacementRY?: number;
  RotationalDisplacementRZ?: number;
}

/**
 * IfcStructuralLoadSingleDisplacementDistortion
 * @extends IfcStructuralLoadSingleDisplacement
 */
export interface IfcStructuralLoadSingleDisplacementDistortion extends IfcStructuralLoadSingleDisplacement {
  Distortion?: number;
}

/**
 * IfcStructuralLoadSingleForce
 * @extends IfcStructuralLoadStatic
 */
export interface IfcStructuralLoadSingleForce extends IfcStructuralLoadStatic {
  ForceX?: number;
  ForceY?: number;
  ForceZ?: number;
  MomentX?: number;
  MomentY?: number;
  MomentZ?: number;
}

/**
 * IfcStructuralLoadSingleForceWarping
 * @extends IfcStructuralLoadSingleForce
 */
export interface IfcStructuralLoadSingleForceWarping extends IfcStructuralLoadSingleForce {
  WarpingMoment?: number;
}

/**
 * IfcStructuralLoadTemperature
 * @extends IfcStructuralLoadStatic
 */
export interface IfcStructuralLoadTemperature extends IfcStructuralLoadStatic {
  DeltaT_Constant?: number;
  DeltaT_Y?: number;
  DeltaT_Z?: number;
}

/**
 * IfcStructuralPlanarAction
 * @extends IfcStructuralAction
 */
export interface IfcStructuralPlanarAction extends IfcStructuralAction {
  ProjectedOrTrue: IfcProjectedOrTrueLengthEnum;
}

/**
 * IfcStructuralPlanarActionVarying
 * @extends IfcStructuralPlanarAction
 */
export interface IfcStructuralPlanarActionVarying extends IfcStructuralPlanarAction {
  VaryingAppliedLoadLocation: IfcShapeAspect;
  SubsequentAppliedLoads: IfcStructuralLoad[];
}

/**
 * IfcStructuralPointAction
 * @extends IfcStructuralAction
 */
export interface IfcStructuralPointAction extends IfcStructuralAction {
}

/**
 * IfcStructuralPointConnection
 * @extends IfcStructuralConnection
 */
export interface IfcStructuralPointConnection extends IfcStructuralConnection {
}

/**
 * IfcStructuralReaction
 * @abstract
 * @extends IfcStructuralActivity
 */
export interface IfcStructuralReaction extends IfcStructuralActivity {
}

/**
 * IfcStructuralPointReaction
 * @extends IfcStructuralReaction
 */
export interface IfcStructuralPointReaction extends IfcStructuralReaction {
}

/**
 * IfcStructuralProfileProperties
 * @extends IfcGeneralProfileProperties
 */
export interface IfcStructuralProfileProperties extends IfcGeneralProfileProperties {
  TorsionalConstantX?: number;
  MomentOfInertiaYZ?: number;
  MomentOfInertiaY?: number;
  MomentOfInertiaZ?: number;
  WarpingConstant?: number;
  ShearCentreZ?: number;
  ShearCentreY?: number;
  ShearDeformationAreaZ?: number;
  ShearDeformationAreaY?: number;
  MaximumSectionModulusY?: number;
  MinimumSectionModulusY?: number;
  MaximumSectionModulusZ?: number;
  MinimumSectionModulusZ?: number;
  TorsionalSectionModulus?: number;
  CentreOfGravityInX?: number;
  CentreOfGravityInY?: number;
}

/**
 * IfcStructuralResultGroup
 * @extends IfcGroup
 */
export interface IfcStructuralResultGroup extends IfcGroup {
  TheoryType: IfcAnalysisTheoryTypeEnum;
  ResultForLoadGroup?: IfcStructuralLoadGroup;
  IsLinear: boolean;
}

/**
 * IfcStructuralSteelProfileProperties
 * @extends IfcStructuralProfileProperties
 */
export interface IfcStructuralSteelProfileProperties extends IfcStructuralProfileProperties {
  ShearAreaZ?: number;
  ShearAreaY?: number;
  PlasticShapeFactorY?: number;
  PlasticShapeFactorZ?: number;
}

/**
 * IfcStructuralSurfaceConnection
 * @extends IfcStructuralConnection
 */
export interface IfcStructuralSurfaceConnection extends IfcStructuralConnection {
}

/**
 * IfcStructuralSurfaceMember
 * @extends IfcStructuralMember
 */
export interface IfcStructuralSurfaceMember extends IfcStructuralMember {
  PredefinedType: IfcStructuralSurfaceTypeEnum;
  Thickness?: number;
}

/**
 * IfcStructuralSurfaceMemberVarying
 * @extends IfcStructuralSurfaceMember
 */
export interface IfcStructuralSurfaceMemberVarying extends IfcStructuralSurfaceMember {
  SubsequentThickness: number[];
  VaryingThicknessLocation: IfcShapeAspect;
}

/**
 * IfcStructuredDimensionCallout
 * @extends IfcDraughtingCallout
 */
export interface IfcStructuredDimensionCallout extends IfcDraughtingCallout {
}

/**
 * IfcStyleModel
 * @abstract
 * @extends IfcRepresentation
 */
export interface IfcStyleModel extends IfcRepresentation {
}

/**
 * IfcStyledRepresentation
 * @extends IfcStyleModel
 */
export interface IfcStyledRepresentation extends IfcStyleModel {
}

/**
 * IfcSubContractResource
 * @extends IfcConstructionResource
 */
export interface IfcSubContractResource extends IfcConstructionResource {
  SubContractor?: IfcActorSelect;
  JobDescription?: IfcText;
}

/**
 * IfcSubedge
 * @extends IfcEdge
 */
export interface IfcSubedge extends IfcEdge {
  ParentEdge: IfcEdge;
}

/**
 * IfcSurfaceCurveSweptAreaSolid
 * @extends IfcSweptAreaSolid
 */
export interface IfcSurfaceCurveSweptAreaSolid extends IfcSweptAreaSolid {
  Directrix: IfcCurve;
  StartParam: IfcParameterValue;
  EndParam: IfcParameterValue;
  ReferenceSurface: IfcSurface;
}

/**
 * IfcSweptSurface
 * @abstract
 * @extends IfcSurface
 */
export interface IfcSweptSurface extends IfcSurface {
  SweptCurve: IfcProfileDef;
  Position: IfcAxis2Placement3D;
}

/**
 * IfcSurfaceOfLinearExtrusion
 * @extends IfcSweptSurface
 */
export interface IfcSurfaceOfLinearExtrusion extends IfcSweptSurface {
  ExtrudedDirection: IfcDirection;
  Depth: number;
}

/**
 * IfcSurfaceOfRevolution
 * @extends IfcSweptSurface
 */
export interface IfcSurfaceOfRevolution extends IfcSweptSurface {
  AxisPosition: IfcAxis1Placement;
}

/**
 * IfcSurfaceStyle
 * @extends IfcPresentationStyle
 */
export interface IfcSurfaceStyle extends IfcPresentationStyle {
  Side: IfcSurfaceSide;
  Styles: IfcSurfaceStyleElementSelect[];
}

/**
 * IfcSurfaceStyleLighting
 */
export interface IfcSurfaceStyleLighting {
  DiffuseTransmissionColour: IfcColourRgb;
  DiffuseReflectionColour: IfcColourRgb;
  TransmissionColour: IfcColourRgb;
  ReflectanceColour: IfcColourRgb;
}

/**
 * IfcSurfaceStyleRefraction
 */
export interface IfcSurfaceStyleRefraction {
  RefractionIndex?: IfcReal;
  DispersionFactor?: IfcReal;
}

/**
 * IfcSurfaceStyleShading
 */
export interface IfcSurfaceStyleShading {
  SurfaceColour: IfcColourRgb;
}

/**
 * IfcSurfaceStyleRendering
 * @extends IfcSurfaceStyleShading
 */
export interface IfcSurfaceStyleRendering extends IfcSurfaceStyleShading {
  Transparency?: number;
  DiffuseColour?: IfcColourOrFactor;
  TransmissionColour?: IfcColourOrFactor;
  DiffuseTransmissionColour?: IfcColourOrFactor;
  ReflectionColour?: IfcColourOrFactor;
  SpecularColour?: IfcColourOrFactor;
  SpecularHighlight?: IfcSpecularHighlightSelect;
  ReflectanceMethod: IfcReflectanceMethodEnum;
}

/**
 * IfcSurfaceStyleWithTextures
 */
export interface IfcSurfaceStyleWithTextures {
  Textures: IfcSurfaceTexture[];
}

/**
 * IfcSweptDiskSolid
 * @extends IfcSolidModel
 */
export interface IfcSweptDiskSolid extends IfcSolidModel {
  Directrix: IfcCurve;
  Radius: number;
  InnerRadius?: number;
  StartParam: IfcParameterValue;
  EndParam: IfcParameterValue;
}

/**
 * IfcSwitchingDeviceType
 * @extends IfcFlowControllerType
 */
export interface IfcSwitchingDeviceType extends IfcFlowControllerType {
  PredefinedType: IfcSwitchingDeviceTypeEnum;
}

/**
 * IfcSymbolStyle
 * @extends IfcPresentationStyle
 */
export interface IfcSymbolStyle extends IfcPresentationStyle {
  StyleOfSymbol: IfcSymbolStyleSelect;
}

/**
 * IfcSystemFurnitureElementType
 * @extends IfcFurnishingElementType
 */
export interface IfcSystemFurnitureElementType extends IfcFurnishingElementType {
}

/**
 * IfcTShapeProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcTShapeProfileDef extends IfcParameterizedProfileDef {
  Depth: number;
  FlangeWidth: number;
  WebThickness: number;
  FlangeThickness: number;
  FilletRadius?: number;
  FlangeEdgeRadius?: number;
  WebEdgeRadius?: number;
  WebSlope?: number;
  FlangeSlope?: number;
  CentreOfGravityInY?: number;
}

/**
 * IfcTable
 */
export interface IfcTable {
  Name: string;
  Rows: IfcTableRow[];
}

/**
 * IfcTableRow
 */
export interface IfcTableRow {
  RowCells: IfcValue[];
  IsHeading: boolean;
}

/**
 * IfcTankType
 * @extends IfcFlowStorageDeviceType
 */
export interface IfcTankType extends IfcFlowStorageDeviceType {
  PredefinedType: IfcTankTypeEnum;
}

/**
 * IfcTelecomAddress
 * @extends IfcAddress
 */
export interface IfcTelecomAddress extends IfcAddress {
  TelephoneNumbers?: IfcLabel[];
  FacsimileNumbers?: IfcLabel[];
  PagerNumber?: IfcLabel;
  ElectronicMailAddresses?: IfcLabel[];
  WWWHomePageURL?: IfcLabel;
}

/**
 * IfcTendon
 * @extends IfcReinforcingElement
 */
export interface IfcTendon extends IfcReinforcingElement {
  PredefinedType: IfcTendonTypeEnum;
  NominalDiameter: number;
  CrossSectionArea: number;
  TensionForce?: number;
  PreStress?: number;
  FrictionCoefficient?: number;
  AnchorageSlip?: number;
  MinCurvatureRadius?: number;
}

/**
 * IfcTendonAnchor
 * @extends IfcReinforcingElement
 */
export interface IfcTendonAnchor extends IfcReinforcingElement {
}

/**
 * IfcTextLiteral
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcTextLiteral extends IfcGeometricRepresentationItem {
  Literal: IfcPresentableText;
  Placement: IfcAxis2Placement;
  Path: IfcTextPath;
}

/**
 * IfcTextLiteralWithExtent
 * @extends IfcTextLiteral
 */
export interface IfcTextLiteralWithExtent extends IfcTextLiteral {
  Extent: IfcPlanarExtent;
  BoxAlignment: IfcBoxAlignment;
}

/**
 * IfcTextStyle
 * @extends IfcPresentationStyle
 */
export interface IfcTextStyle extends IfcPresentationStyle {
  TextCharacterAppearance?: IfcCharacterStyleSelect;
  TextStyle?: IfcTextStyleSelect;
  TextFontStyle: IfcTextFontSelect;
}

/**
 * IfcTextStyleFontModel
 * @extends IfcPreDefinedTextFont
 */
export interface IfcTextStyleFontModel extends IfcPreDefinedTextFont {
  FontFamily?: IfcTextFontName[];
  FontStyle?: IfcFontStyle;
  FontVariant?: IfcFontVariant;
  FontWeight?: IfcFontWeight;
  FontSize: IfcSizeSelect;
}

/**
 * IfcTextStyleForDefinedFont
 */
export interface IfcTextStyleForDefinedFont {
  Colour: IfcColour;
  BackgroundColour?: IfcColour;
}

/**
 * IfcTextStyleTextModel
 */
export interface IfcTextStyleTextModel {
  TextIndent?: IfcSizeSelect;
  TextAlign?: IfcTextAlignment;
  TextDecoration?: IfcTextDecoration;
  LetterSpacing?: IfcSizeSelect;
  WordSpacing?: IfcSizeSelect;
  TextTransform?: IfcTextTransformation;
  LineHeight?: IfcSizeSelect;
}

/**
 * IfcTextStyleWithBoxCharacteristics
 */
export interface IfcTextStyleWithBoxCharacteristics {
  BoxHeight?: number;
  BoxWidth?: number;
  BoxSlantAngle?: number;
  BoxRotateAngle?: number;
  CharacterSpacing?: IfcSizeSelect;
}

/**
 * IfcTextureCoordinate
 * @abstract
 */
export interface IfcTextureCoordinate {
}

/**
 * IfcTextureCoordinateGenerator
 * @extends IfcTextureCoordinate
 */
export interface IfcTextureCoordinateGenerator extends IfcTextureCoordinate {
  Mode: IfcLabel;
  Parameter: IfcSimpleValue[];
}

/**
 * IfcTextureMap
 * @extends IfcTextureCoordinate
 */
export interface IfcTextureMap extends IfcTextureCoordinate {
  TextureMaps: IfcVertexBasedTextureMap[];
}

/**
 * IfcTextureVertex
 */
export interface IfcTextureVertex {
  Coordinates: IfcParameterValue[];
}

/**
 * IfcThermalMaterialProperties
 * @extends IfcMaterialProperties
 */
export interface IfcThermalMaterialProperties extends IfcMaterialProperties {
  SpecificHeatCapacity?: number;
  BoilingPoint?: number;
  FreezingPoint?: number;
  ThermalConductivity?: number;
}

/**
 * IfcTimeSeriesReferenceRelationship
 */
export interface IfcTimeSeriesReferenceRelationship {
  ReferencedTimeSeries: IfcTimeSeries;
  TimeSeriesReferences: IfcDocumentSelect[];
}

/**
 * IfcTimeSeriesSchedule
 * @extends IfcControl
 */
export interface IfcTimeSeriesSchedule extends IfcControl {
  ApplicableDates?: IfcDateTimeSelect[];
  TimeSeriesScheduleType: IfcTimeSeriesScheduleTypeEnum;
  TimeSeries: IfcTimeSeries;
}

/**
 * IfcTimeSeriesValue
 */
export interface IfcTimeSeriesValue {
  ListValues: IfcValue[];
}

/**
 * IfcTopologyRepresentation
 * @extends IfcShapeModel
 */
export interface IfcTopologyRepresentation extends IfcShapeModel {
}

/**
 * IfcTransformerType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcTransformerType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcTransformerTypeEnum;
}

/**
 * IfcTransportElement
 * @extends IfcElement
 */
export interface IfcTransportElement extends IfcElement {
  OperationType?: IfcTransportElementTypeEnum;
  CapacityByWeight?: number;
  CapacityByNumber?: number;
}

/**
 * IfcTransportElementType
 * @extends IfcElementType
 */
export interface IfcTransportElementType extends IfcElementType {
  PredefinedType: IfcTransportElementTypeEnum;
}

/**
 * IfcTrapeziumProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcTrapeziumProfileDef extends IfcParameterizedProfileDef {
  BottomXDim: number;
  TopXDim: number;
  YDim: number;
  TopXOffset: number;
}

/**
 * IfcTrimmedCurve
 * @extends IfcBoundedCurve
 */
export interface IfcTrimmedCurve extends IfcBoundedCurve {
  BasisCurve: IfcCurve;
  Trim1: IfcTrimmingSelect[];
  Trim2: IfcTrimmingSelect[];
  SenseAgreement: boolean;
  MasterRepresentation: IfcTrimmingPreference;
}

/**
 * IfcTubeBundleType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcTubeBundleType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcTubeBundleTypeEnum;
}

/**
 * IfcTwoDirectionRepeatFactor
 * @extends IfcOneDirectionRepeatFactor
 */
export interface IfcTwoDirectionRepeatFactor extends IfcOneDirectionRepeatFactor {
  SecondRepeatFactor: IfcVector;
}

/**
 * IfcUShapeProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcUShapeProfileDef extends IfcParameterizedProfileDef {
  Depth: number;
  FlangeWidth: number;
  WebThickness: number;
  FlangeThickness: number;
  FilletRadius?: number;
  EdgeRadius?: number;
  FlangeSlope?: number;
  CentreOfGravityInX?: number;
}

/**
 * IfcUnitAssignment
 */
export interface IfcUnitAssignment {
  Units: IfcUnit[];
}

/**
 * IfcUnitaryEquipmentType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcUnitaryEquipmentType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcUnitaryEquipmentTypeEnum;
}

/**
 * IfcValveType
 * @extends IfcFlowControllerType
 */
export interface IfcValveType extends IfcFlowControllerType {
  PredefinedType: IfcValveTypeEnum;
}

/**
 * IfcVector
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcVector extends IfcGeometricRepresentationItem {
  Orientation: IfcDirection;
  Magnitude: number;
}

/**
 * IfcVertex
 * @extends IfcTopologicalRepresentationItem
 */
export interface IfcVertex extends IfcTopologicalRepresentationItem {
}

/**
 * IfcVertexBasedTextureMap
 */
export interface IfcVertexBasedTextureMap {
  TextureVertices: IfcTextureVertex[];
  TexturePoints: IfcCartesianPoint[];
}

/**
 * IfcVertexLoop
 * @extends IfcLoop
 */
export interface IfcVertexLoop extends IfcLoop {
  LoopVertex: IfcVertex;
}

/**
 * IfcVertexPoint
 * @extends IfcVertex
 */
export interface IfcVertexPoint extends IfcVertex {
  VertexGeometry: IfcPoint;
}

/**
 * IfcVibrationIsolatorType
 * @extends IfcDiscreteAccessoryType
 */
export interface IfcVibrationIsolatorType extends IfcDiscreteAccessoryType {
  PredefinedType: IfcVibrationIsolatorTypeEnum;
}

/**
 * IfcVirtualElement
 * @extends IfcElement
 */
export interface IfcVirtualElement extends IfcElement {
}

/**
 * IfcVirtualGridIntersection
 */
export interface IfcVirtualGridIntersection {
  IntersectingAxes: IfcGridAxis[];
  OffsetDistances: number[];
}

/**
 * IfcWall
 * @extends IfcBuildingElement
 */
export interface IfcWall extends IfcBuildingElement {
}

/**
 * IfcWallStandardCase
 * @extends IfcWall
 */
export interface IfcWallStandardCase extends IfcWall {
}

/**
 * IfcWallType
 * @extends IfcBuildingElementType
 */
export interface IfcWallType extends IfcBuildingElementType {
  PredefinedType: IfcWallTypeEnum;
}

/**
 * IfcWasteTerminalType
 * @extends IfcFlowTerminalType
 */
export interface IfcWasteTerminalType extends IfcFlowTerminalType {
  PredefinedType: IfcWasteTerminalTypeEnum;
}

/**
 * IfcWaterProperties
 * @extends IfcMaterialProperties
 */
export interface IfcWaterProperties extends IfcMaterialProperties {
  IsPotable?: boolean;
  Hardness?: number;
  AlkalinityConcentration?: number;
  AcidityConcentration?: number;
  ImpuritiesContent?: number;
  PHLevel?: number;
  DissolvedSolidsContent?: number;
}

/**
 * IfcWindow
 * @extends IfcBuildingElement
 */
export interface IfcWindow extends IfcBuildingElement {
  OverallHeight?: number;
  OverallWidth?: number;
}

/**
 * IfcWindowLiningProperties
 * @extends IfcPropertySetDefinition
 */
export interface IfcWindowLiningProperties extends IfcPropertySetDefinition {
  LiningDepth?: number;
  LiningThickness?: number;
  TransomThickness?: number;
  MullionThickness?: number;
  FirstTransomOffset?: number;
  SecondTransomOffset?: number;
  FirstMullionOffset?: number;
  SecondMullionOffset?: number;
  ShapeAspectStyle?: IfcShapeAspect;
}

/**
 * IfcWindowPanelProperties
 * @extends IfcPropertySetDefinition
 */
export interface IfcWindowPanelProperties extends IfcPropertySetDefinition {
  OperationType: IfcWindowPanelOperationEnum;
  PanelPosition: IfcWindowPanelPositionEnum;
  FrameDepth?: number;
  FrameThickness?: number;
  ShapeAspectStyle?: IfcShapeAspect;
}

/**
 * IfcWindowStyle
 * @extends IfcTypeProduct
 */
export interface IfcWindowStyle extends IfcTypeProduct {
  ConstructionType: IfcWindowStyleConstructionEnum;
  OperationType: IfcWindowStyleOperationEnum;
  ParameterTakesPrecedence: boolean;
  Sizeable: boolean;
}

/**
 * IfcWorkControl
 * @abstract
 * @extends IfcControl
 */
export interface IfcWorkControl extends IfcControl {
  Identifier: IfcIdentifier;
  CreationDate: IfcDateTimeSelect;
  Creators?: IfcPerson[];
  Purpose?: IfcLabel;
  Duration?: number;
  TotalFloat?: number;
  StartTime: IfcDateTimeSelect;
  FinishTime?: IfcDateTimeSelect;
  WorkControlType?: IfcWorkControlTypeEnum;
  UserDefinedControlType?: IfcLabel;
}

/**
 * IfcWorkPlan
 * @extends IfcWorkControl
 */
export interface IfcWorkPlan extends IfcWorkControl {
}

/**
 * IfcWorkSchedule
 * @extends IfcWorkControl
 */
export interface IfcWorkSchedule extends IfcWorkControl {
}

/**
 * IfcZShapeProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcZShapeProfileDef extends IfcParameterizedProfileDef {
  Depth: number;
  FlangeWidth: number;
  WebThickness: number;
  FlangeThickness: number;
  FilletRadius?: number;
  EdgeRadius?: number;
}

/**
 * IfcZone
 * @extends IfcGroup
 */
export interface IfcZone extends IfcGroup {
}
