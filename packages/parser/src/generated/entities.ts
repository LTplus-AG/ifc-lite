/**
 * IFC Entity Interfaces
 * Generated from EXPRESS schema: IFC4_ADD2_TC1
 *
 * DO NOT EDIT - This file is auto-generated
 */

import type {
  IfcAbsorbedDoseMeasure,
  IfcAccelerationMeasure,
  IfcAmountOfSubstanceMeasure,
  IfcAngularVelocityMeasure,
  IfcArcIndex,
  IfcAreaDensityMeasure,
  IfcAreaMeasure,
  IfcBinary,
  IfcBoolean,
  IfcBoxAlignment,
  IfcCardinalPointReference,
  IfcComplexNumber,
  IfcCompoundPlaneAngleMeasure,
  IfcContextDependentMeasure,
  IfcCountMeasure,
  IfcCurvatureMeasure,
  IfcDate,
  IfcDateTime,
  IfcDayInMonthNumber,
  IfcDayInWeekNumber,
  IfcDescriptiveMeasure,
  IfcDimensionCount,
  IfcDoseEquivalentMeasure,
  IfcDuration,
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
  IfcIdentifier,
  IfcIlluminanceMeasure,
  IfcInductanceMeasure,
  IfcInteger,
  IfcIntegerCountRateMeasure,
  IfcIonConcentrationMeasure,
  IfcIsothermalMoistureCapacityMeasure,
  IfcKinematicViscosityMeasure,
  IfcLabel,
  IfcLanguageId,
  IfcLengthMeasure,
  IfcLineIndex,
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
  IfcModulusOfElasticityMeasure,
  IfcModulusOfLinearSubgradeReactionMeasure,
  IfcModulusOfRotationalSubgradeReactionMeasure,
  IfcModulusOfSubgradeReactionMeasure,
  IfcMoistureDiffusivityMeasure,
  IfcMolecularWeightMeasure,
  IfcMomentOfInertiaMeasure,
  IfcMonetaryMeasure,
  IfcMonthInYearNumber,
  IfcNonNegativeLengthMeasure,
  IfcNormalisedRatioMeasure,
  IfcNumericMeasure,
  IfcPHMeasure,
  IfcParameterValue,
  IfcPlanarForceMeasure,
  IfcPlaneAngleMeasure,
  IfcPositiveInteger,
  IfcPositiveLengthMeasure,
  IfcPositivePlaneAngleMeasure,
  IfcPositiveRatioMeasure,
  IfcPowerMeasure,
  IfcPresentableText,
  IfcPressureMeasure,
  IfcPropertySetDefinitionSet,
  IfcRadioActivityMeasure,
  IfcRatioMeasure,
  IfcReal,
  IfcRotationalFrequencyMeasure,
  IfcRotationalMassMeasure,
  IfcRotationalStiffnessMeasure,
  IfcSectionModulusMeasure,
  IfcSectionalAreaIntegralMeasure,
  IfcShearModulusMeasure,
  IfcSolidAngleMeasure,
  IfcSoundPowerLevelMeasure,
  IfcSoundPowerMeasure,
  IfcSoundPressureLevelMeasure,
  IfcSoundPressureMeasure,
  IfcSpecificHeatCapacityMeasure,
  IfcSpecularExponent,
  IfcSpecularRoughness,
  IfcTemperatureGradientMeasure,
  IfcTemperatureRateOfChangeMeasure,
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
  IfcTime,
  IfcTimeMeasure,
  IfcTimeStamp,
  IfcTorqueMeasure,
  IfcURIReference,
  IfcVaporPermeabilityMeasure,
  IfcVolumeMeasure,
  IfcVolumetricFlowRateMeasure,
  IfcWarpingConstantMeasure,
  IfcWarpingMomentMeasure,
} from './types.js';

import type {
  IfcActionRequestTypeEnum,
  IfcActionSourceTypeEnum,
  IfcActionTypeEnum,
  IfcActuatorTypeEnum,
  IfcAddressTypeEnum,
  IfcAirTerminalBoxTypeEnum,
  IfcAirTerminalTypeEnum,
  IfcAirToAirHeatRecoveryTypeEnum,
  IfcAlarmTypeEnum,
  IfcAnalysisModelTypeEnum,
  IfcAnalysisTheoryTypeEnum,
  IfcArithmeticOperatorEnum,
  IfcAssemblyPlaceEnum,
  IfcAudioVisualApplianceTypeEnum,
  IfcBSplineCurveForm,
  IfcBSplineSurfaceForm,
  IfcBeamTypeEnum,
  IfcBenchmarkEnum,
  IfcBoilerTypeEnum,
  IfcBooleanOperator,
  IfcBuildingElementPartTypeEnum,
  IfcBuildingElementProxyTypeEnum,
  IfcBuildingSystemTypeEnum,
  IfcBurnerTypeEnum,
  IfcCableCarrierFittingTypeEnum,
  IfcCableCarrierSegmentTypeEnum,
  IfcCableFittingTypeEnum,
  IfcCableSegmentTypeEnum,
  IfcChangeActionEnum,
  IfcChillerTypeEnum,
  IfcChimneyTypeEnum,
  IfcCoilTypeEnum,
  IfcColumnTypeEnum,
  IfcCommunicationsApplianceTypeEnum,
  IfcComplexPropertyTemplateTypeEnum,
  IfcCompressorTypeEnum,
  IfcCondenserTypeEnum,
  IfcConnectionTypeEnum,
  IfcConstraintEnum,
  IfcConstructionEquipmentResourceTypeEnum,
  IfcConstructionMaterialResourceTypeEnum,
  IfcConstructionProductResourceTypeEnum,
  IfcControllerTypeEnum,
  IfcCooledBeamTypeEnum,
  IfcCoolingTowerTypeEnum,
  IfcCostItemTypeEnum,
  IfcCostScheduleTypeEnum,
  IfcCoveringTypeEnum,
  IfcCrewResourceTypeEnum,
  IfcCurtainWallTypeEnum,
  IfcCurveInterpolationEnum,
  IfcDamperTypeEnum,
  IfcDataOriginEnum,
  IfcDerivedUnitEnum,
  IfcDirectionSenseEnum,
  IfcDiscreteAccessoryTypeEnum,
  IfcDistributionChamberElementTypeEnum,
  IfcDistributionPortTypeEnum,
  IfcDistributionSystemEnum,
  IfcDocumentConfidentialityEnum,
  IfcDocumentStatusEnum,
  IfcDoorPanelOperationEnum,
  IfcDoorPanelPositionEnum,
  IfcDoorStyleConstructionEnum,
  IfcDoorStyleOperationEnum,
  IfcDoorTypeEnum,
  IfcDoorTypeOperationEnum,
  IfcDuctFittingTypeEnum,
  IfcDuctSegmentTypeEnum,
  IfcDuctSilencerTypeEnum,
  IfcElectricApplianceTypeEnum,
  IfcElectricDistributionBoardTypeEnum,
  IfcElectricFlowStorageDeviceTypeEnum,
  IfcElectricGeneratorTypeEnum,
  IfcElectricMotorTypeEnum,
  IfcElectricTimeControlTypeEnum,
  IfcElementAssemblyTypeEnum,
  IfcElementCompositionEnum,
  IfcEngineTypeEnum,
  IfcEvaporativeCoolerTypeEnum,
  IfcEvaporatorTypeEnum,
  IfcEventTriggerTypeEnum,
  IfcEventTypeEnum,
  IfcExternalSpatialElementTypeEnum,
  IfcFanTypeEnum,
  IfcFastenerTypeEnum,
  IfcFilterTypeEnum,
  IfcFireSuppressionTerminalTypeEnum,
  IfcFlowDirectionEnum,
  IfcFlowInstrumentTypeEnum,
  IfcFlowMeterTypeEnum,
  IfcFootingTypeEnum,
  IfcFurnitureTypeEnum,
  IfcGeographicElementTypeEnum,
  IfcGeometricProjectionEnum,
  IfcGlobalOrLocalEnum,
  IfcGridTypeEnum,
  IfcHeatExchangerTypeEnum,
  IfcHumidifierTypeEnum,
  IfcInterceptorTypeEnum,
  IfcInternalOrExternalEnum,
  IfcInventoryTypeEnum,
  IfcJunctionBoxTypeEnum,
  IfcKnotType,
  IfcLaborResourceTypeEnum,
  IfcLampTypeEnum,
  IfcLayerSetDirectionEnum,
  IfcLightDistributionCurveEnum,
  IfcLightEmissionSourceEnum,
  IfcLightFixtureTypeEnum,
  IfcLoadGroupTypeEnum,
  IfcLogicalOperatorEnum,
  IfcMechanicalFastenerTypeEnum,
  IfcMedicalDeviceTypeEnum,
  IfcMemberTypeEnum,
  IfcMotorConnectionTypeEnum,
  IfcNullStyle,
  IfcObjectTypeEnum,
  IfcObjectiveEnum,
  IfcOccupantTypeEnum,
  IfcOpeningElementTypeEnum,
  IfcOutletTypeEnum,
  IfcPerformanceHistoryTypeEnum,
  IfcPermeableCoveringOperationEnum,
  IfcPermitTypeEnum,
  IfcPhysicalOrVirtualEnum,
  IfcPileConstructionEnum,
  IfcPileTypeEnum,
  IfcPipeFittingTypeEnum,
  IfcPipeSegmentTypeEnum,
  IfcPlateTypeEnum,
  IfcPreferredSurfaceCurveRepresentation,
  IfcProcedureTypeEnum,
  IfcProfileTypeEnum,
  IfcProjectOrderTypeEnum,
  IfcProjectedOrTrueLengthEnum,
  IfcProjectionElementTypeEnum,
  IfcPropertySetTemplateTypeEnum,
  IfcProtectiveDeviceTrippingUnitTypeEnum,
  IfcProtectiveDeviceTypeEnum,
  IfcPumpTypeEnum,
  IfcRailingTypeEnum,
  IfcRampFlightTypeEnum,
  IfcRampTypeEnum,
  IfcRecurrenceTypeEnum,
  IfcReflectanceMethodEnum,
  IfcReinforcingBarRoleEnum,
  IfcReinforcingBarSurfaceEnum,
  IfcReinforcingBarTypeEnum,
  IfcReinforcingMeshTypeEnum,
  IfcRoleEnum,
  IfcRoofTypeEnum,
  IfcSIPrefix,
  IfcSIUnitName,
  IfcSanitaryTerminalTypeEnum,
  IfcSectionTypeEnum,
  IfcSensorTypeEnum,
  IfcSequenceEnum,
  IfcShadingDeviceTypeEnum,
  IfcSimplePropertyTemplateTypeEnum,
  IfcSlabTypeEnum,
  IfcSolarDeviceTypeEnum,
  IfcSpaceHeaterTypeEnum,
  IfcSpaceTypeEnum,
  IfcSpatialZoneTypeEnum,
  IfcStackTerminalTypeEnum,
  IfcStairFlightTypeEnum,
  IfcStairTypeEnum,
  IfcStateEnum,
  IfcStructuralCurveActivityTypeEnum,
  IfcStructuralCurveMemberTypeEnum,
  IfcStructuralSurfaceActivityTypeEnum,
  IfcStructuralSurfaceMemberTypeEnum,
  IfcSubContractResourceTypeEnum,
  IfcSurfaceFeatureTypeEnum,
  IfcSurfaceSide,
  IfcSwitchingDeviceTypeEnum,
  IfcSystemFurnitureElementTypeEnum,
  IfcTankTypeEnum,
  IfcTaskDurationEnum,
  IfcTaskTypeEnum,
  IfcTendonAnchorTypeEnum,
  IfcTendonTypeEnum,
  IfcTextPath,
  IfcTimeSeriesDataTypeEnum,
  IfcTransformerTypeEnum,
  IfcTransitionCode,
  IfcTransportElementTypeEnum,
  IfcTrimmingPreference,
  IfcTubeBundleTypeEnum,
  IfcUnitEnum,
  IfcUnitaryControlElementTypeEnum,
  IfcUnitaryEquipmentTypeEnum,
  IfcValveTypeEnum,
  IfcVibrationIsolatorTypeEnum,
  IfcVoidingFeatureTypeEnum,
  IfcWallTypeEnum,
  IfcWasteTerminalTypeEnum,
  IfcWindowPanelOperationEnum,
  IfcWindowPanelPositionEnum,
  IfcWindowStyleConstructionEnum,
  IfcWindowStyleOperationEnum,
  IfcWindowTypeEnum,
  IfcWindowTypePartitioningEnum,
  IfcWorkCalendarTypeEnum,
  IfcWorkPlanTypeEnum,
  IfcWorkScheduleTypeEnum,
} from './enums.js';

import type {
  IfcActorSelect,
  IfcAppliedValueSelect,
  IfcAxis2Placement,
  IfcBendingParameterSelect,
  IfcBooleanOperand,
  IfcClassificationReferenceSelect,
  IfcClassificationSelect,
  IfcColour,
  IfcColourOrFactor,
  IfcCoordinateReferenceSystemSelect,
  IfcCsgSelect,
  IfcCurveFontOrScaledCurveFontSelect,
  IfcCurveOnSurface,
  IfcCurveOrEdgeCurve,
  IfcCurveStyleFontSelect,
  IfcDefinitionSelect,
  IfcDerivedMeasureValue,
  IfcDocumentSelect,
  IfcFillStyleSelect,
  IfcGeometricSetSelect,
  IfcGridPlacementDirectionSelect,
  IfcHatchLineDistanceSelect,
  IfcLayeredItem,
  IfcLibrarySelect,
  IfcLightDistributionDataSourceSelect,
  IfcMaterialSelect,
  IfcMeasureValue,
  IfcMetricValueSelect,
  IfcModulusOfRotationalSubgradeReactionSelect,
  IfcModulusOfSubgradeReactionSelect,
  IfcModulusOfTranslationalSubgradeReactionSelect,
  IfcObjectReferenceSelect,
  IfcPointOrVertexPoint,
  IfcPresentationStyleSelect,
  IfcProcessSelect,
  IfcProductRepresentationSelect,
  IfcProductSelect,
  IfcPropertySetDefinitionSelect,
  IfcResourceObjectSelect,
  IfcResourceSelect,
  IfcRotationalStiffnessSelect,
  IfcSegmentIndexSelect,
  IfcShell,
  IfcSimpleValue,
  IfcSizeSelect,
  IfcSolidOrShell,
  IfcSpaceBoundarySelect,
  IfcSpecularHighlightSelect,
  IfcStructuralActivityAssignmentSelect,
  IfcStyleAssignmentSelect,
  IfcSurfaceOrFaceSurface,
  IfcSurfaceStyleElementSelect,
  IfcTextFontSelect,
  IfcTimeOrRatioSelect,
  IfcTranslationalStiffnessSelect,
  IfcTrimmingSelect,
  IfcUnit,
  IfcValue,
  IfcVectorOrDirection,
  IfcWarpingStiffnessSelect,
} from './selects.js';

/**
 * IfcRoot
 * @abstract
 */
export interface IfcRoot {
  GlobalId: IfcGloballyUniqueId;
  OwnerHistory?: IfcOwnerHistory;
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
  Identification?: IfcIdentifier;
}

/**
 * IfcActionRequest
 * @extends IfcControl
 */
export interface IfcActionRequest extends IfcControl {
  PredefinedType?: IfcActionRequestTypeEnum;
  Status?: IfcLabel;
  LongDescription?: IfcText;
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
 * IfcProduct
 * @abstract
 * @extends IfcObject
 */
export interface IfcProduct extends IfcObject {
  ObjectPlacement?: IfcObjectPlacement;
  Representation?: IfcProductRepresentation;
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
 * IfcDistributionElement
 * @extends IfcElement
 */
export interface IfcDistributionElement extends IfcElement {
}

/**
 * IfcDistributionControlElement
 * @extends IfcDistributionElement
 */
export interface IfcDistributionControlElement extends IfcDistributionElement {
}

/**
 * IfcActuator
 * @extends IfcDistributionControlElement
 */
export interface IfcActuator extends IfcDistributionControlElement {
  PredefinedType?: IfcActuatorTypeEnum;
}

/**
 * IfcTypeObject
 * @extends IfcObjectDefinition
 */
export interface IfcTypeObject extends IfcObjectDefinition {
  ApplicableOccurrence?: IfcIdentifier;
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
 * IfcSolidModel
 * @abstract
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcSolidModel extends IfcGeometricRepresentationItem {
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
 * IfcAdvancedBrep
 * @extends IfcManifoldSolidBrep
 */
export interface IfcAdvancedBrep extends IfcManifoldSolidBrep {
}

/**
 * IfcAdvancedBrepWithVoids
 * @extends IfcAdvancedBrep
 */
export interface IfcAdvancedBrepWithVoids extends IfcAdvancedBrep {
  Voids: IfcClosedShell[];
}

/**
 * IfcTopologicalRepresentationItem
 * @abstract
 * @extends IfcRepresentationItem
 */
export interface IfcTopologicalRepresentationItem extends IfcRepresentationItem {
}

/**
 * IfcFace
 * @extends IfcTopologicalRepresentationItem
 */
export interface IfcFace extends IfcTopologicalRepresentationItem {
  Bounds: IfcFaceBound[];
}

/**
 * IfcFaceSurface
 * @extends IfcFace
 */
export interface IfcFaceSurface extends IfcFace {
  FaceSurface: IfcSurface;
  SameSense: IfcBoolean;
}

/**
 * IfcAdvancedFace
 * @extends IfcFaceSurface
 */
export interface IfcAdvancedFace extends IfcFaceSurface {
}

/**
 * IfcDistributionFlowElement
 * @extends IfcDistributionElement
 */
export interface IfcDistributionFlowElement extends IfcDistributionElement {
}

/**
 * IfcFlowTerminal
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowTerminal extends IfcDistributionFlowElement {
}

/**
 * IfcAirTerminal
 * @extends IfcFlowTerminal
 */
export interface IfcAirTerminal extends IfcFlowTerminal {
  PredefinedType?: IfcAirTerminalTypeEnum;
}

/**
 * IfcFlowController
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowController extends IfcDistributionFlowElement {
}

/**
 * IfcAirTerminalBox
 * @extends IfcFlowController
 */
export interface IfcAirTerminalBox extends IfcFlowController {
  PredefinedType?: IfcAirTerminalBoxTypeEnum;
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
 * IfcEnergyConversionDevice
 * @extends IfcDistributionFlowElement
 */
export interface IfcEnergyConversionDevice extends IfcDistributionFlowElement {
}

/**
 * IfcAirToAirHeatRecovery
 * @extends IfcEnergyConversionDevice
 */
export interface IfcAirToAirHeatRecovery extends IfcEnergyConversionDevice {
  PredefinedType?: IfcAirToAirHeatRecoveryTypeEnum;
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
 * IfcAlarm
 * @extends IfcDistributionControlElement
 */
export interface IfcAlarm extends IfcDistributionControlElement {
  PredefinedType?: IfcAlarmTypeEnum;
}

/**
 * IfcAlarmType
 * @extends IfcDistributionControlElementType
 */
export interface IfcAlarmType extends IfcDistributionControlElementType {
  PredefinedType: IfcAlarmTypeEnum;
}

/**
 * IfcAnnotation
 * @extends IfcProduct
 */
export interface IfcAnnotation extends IfcProduct {
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
 */
export interface IfcAppliedValue {
  Name?: IfcLabel;
  Description?: IfcText;
  AppliedValue?: IfcAppliedValueSelect;
  UnitBasis?: IfcMeasureWithUnit;
  ApplicableDate?: IfcDate;
  FixedUntilDate?: IfcDate;
  Category?: IfcLabel;
  Condition?: IfcLabel;
  ArithmeticOperator?: IfcArithmeticOperatorEnum;
  Components?: IfcAppliedValue[];
}

/**
 * IfcApproval
 */
export interface IfcApproval {
  Identifier?: IfcIdentifier;
  Name?: IfcLabel;
  Description?: IfcText;
  TimeOfApproval?: IfcDateTime;
  Status?: IfcLabel;
  Level?: IfcLabel;
  Qualifier?: IfcText;
  RequestingApproval?: IfcActorSelect;
  GivingApproval?: IfcActorSelect;
}

/**
 * IfcResourceLevelRelationship
 * @abstract
 */
export interface IfcResourceLevelRelationship {
  Name?: IfcLabel;
  Description?: IfcText;
}

/**
 * IfcApprovalRelationship
 * @extends IfcResourceLevelRelationship
 */
export interface IfcApprovalRelationship extends IfcResourceLevelRelationship {
  RelatingApproval: IfcApproval;
  RelatedApprovals: IfcApproval[];
}

/**
 * IfcProfileDef
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
  Identification?: IfcIdentifier;
  OriginalValue?: IfcCostValue;
  CurrentValue?: IfcCostValue;
  TotalReplacementCost?: IfcCostValue;
  Owner?: IfcActorSelect;
  User?: IfcActorSelect;
  ResponsiblePerson?: IfcPerson;
  IncorporationDate?: IfcDate;
  DepreciatedValue?: IfcCostValue;
}

/**
 * IfcParameterizedProfileDef
 * @abstract
 * @extends IfcProfileDef
 */
export interface IfcParameterizedProfileDef extends IfcProfileDef {
  Position?: IfcAxis2Placement2D;
}

/**
 * IfcAsymmetricIShapeProfileDef
 * @extends IfcParameterizedProfileDef
 */
export interface IfcAsymmetricIShapeProfileDef extends IfcParameterizedProfileDef {
  BottomFlangeWidth: number;
  OverallDepth: number;
  WebThickness: number;
  BottomFlangeThickness: number;
  BottomFlangeFilletRadius?: number;
  TopFlangeWidth: number;
  TopFlangeThickness?: number;
  TopFlangeFilletRadius?: number;
  BottomFlangeEdgeRadius?: number;
  BottomFlangeSlope?: number;
  TopFlangeEdgeRadius?: number;
  TopFlangeSlope?: number;
}

/**
 * IfcAudioVisualAppliance
 * @extends IfcFlowTerminal
 */
export interface IfcAudioVisualAppliance extends IfcFlowTerminal {
  PredefinedType?: IfcAudioVisualApplianceTypeEnum;
}

/**
 * IfcAudioVisualApplianceType
 * @extends IfcFlowTerminalType
 */
export interface IfcAudioVisualApplianceType extends IfcFlowTerminalType {
  PredefinedType: IfcAudioVisualApplianceTypeEnum;
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
 * IfcBSplineCurve
 * @abstract
 * @extends IfcBoundedCurve
 */
export interface IfcBSplineCurve extends IfcBoundedCurve {
  Degree: IfcInteger;
  ControlPointsList: IfcCartesianPoint[];
  CurveForm: IfcBSplineCurveForm;
  ClosedCurve: IfcLogical;
  SelfIntersect: IfcLogical;
}

/**
 * IfcBSplineCurveWithKnots
 * @extends IfcBSplineCurve
 */
export interface IfcBSplineCurveWithKnots extends IfcBSplineCurve {
  KnotMultiplicities: IfcInteger[];
  Knots: IfcParameterValue[];
  KnotSpec: IfcKnotType;
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
 * @abstract
 * @extends IfcSurface
 */
export interface IfcBoundedSurface extends IfcSurface {
}

/**
 * IfcBSplineSurface
 * @abstract
 * @extends IfcBoundedSurface
 */
export interface IfcBSplineSurface extends IfcBoundedSurface {
  UDegree: IfcInteger;
  VDegree: IfcInteger;
  ControlPointsList: IfcCartesianPoint[][];
  SurfaceForm: IfcBSplineSurfaceForm;
  UClosed: IfcLogical;
  VClosed: IfcLogical;
  SelfIntersect: IfcLogical;
}

/**
 * IfcBSplineSurfaceWithKnots
 * @extends IfcBSplineSurface
 */
export interface IfcBSplineSurfaceWithKnots extends IfcBSplineSurface {
  UMultiplicities: IfcInteger[];
  VMultiplicities: IfcInteger[];
  UKnots: IfcParameterValue[];
  VKnots: IfcParameterValue[];
  KnotSpec: IfcKnotType;
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
  PredefinedType?: IfcBeamTypeEnum;
}

/**
 * IfcBeamStandardCase
 * @extends IfcBeam
 */
export interface IfcBeamStandardCase extends IfcBeam {
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
 * IfcPresentationItem
 * @abstract
 */
export interface IfcPresentationItem {
}

/**
 * IfcSurfaceTexture
 * @abstract
 * @extends IfcPresentationItem
 */
export interface IfcSurfaceTexture extends IfcPresentationItem {
  RepeatS: IfcBoolean;
  RepeatT: IfcBoolean;
  Mode?: IfcIdentifier;
  TextureTransform?: IfcCartesianTransformationOperator2D;
  Parameter?: IfcIdentifier[];
}

/**
 * IfcBlobTexture
 * @extends IfcSurfaceTexture
 */
export interface IfcBlobTexture extends IfcSurfaceTexture {
  RasterFormat: IfcIdentifier;
  RasterCode: IfcBinary;
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
 * IfcBoiler
 * @extends IfcEnergyConversionDevice
 */
export interface IfcBoiler extends IfcEnergyConversionDevice {
  PredefinedType?: IfcBoilerTypeEnum;
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
 * IfcCompositeCurve
 * @extends IfcBoundedCurve
 */
export interface IfcCompositeCurve extends IfcBoundedCurve {
  Segments: IfcCompositeCurveSegment[];
  SelfIntersect: IfcLogical;
}

/**
 * IfcCompositeCurveOnSurface
 * @extends IfcCompositeCurve
 */
export interface IfcCompositeCurveOnSurface extends IfcCompositeCurve {
}

/**
 * IfcBoundaryCurve
 * @extends IfcCompositeCurveOnSurface
 */
export interface IfcBoundaryCurve extends IfcCompositeCurveOnSurface {
}

/**
 * IfcBoundaryEdgeCondition
 * @extends IfcBoundaryCondition
 */
export interface IfcBoundaryEdgeCondition extends IfcBoundaryCondition {
  TranslationalStiffnessByLengthX?: IfcModulusOfTranslationalSubgradeReactionSelect;
  TranslationalStiffnessByLengthY?: IfcModulusOfTranslationalSubgradeReactionSelect;
  TranslationalStiffnessByLengthZ?: IfcModulusOfTranslationalSubgradeReactionSelect;
  RotationalStiffnessByLengthX?: IfcModulusOfRotationalSubgradeReactionSelect;
  RotationalStiffnessByLengthY?: IfcModulusOfRotationalSubgradeReactionSelect;
  RotationalStiffnessByLengthZ?: IfcModulusOfRotationalSubgradeReactionSelect;
}

/**
 * IfcBoundaryFaceCondition
 * @extends IfcBoundaryCondition
 */
export interface IfcBoundaryFaceCondition extends IfcBoundaryCondition {
  TranslationalStiffnessByAreaX?: IfcModulusOfSubgradeReactionSelect;
  TranslationalStiffnessByAreaY?: IfcModulusOfSubgradeReactionSelect;
  TranslationalStiffnessByAreaZ?: IfcModulusOfSubgradeReactionSelect;
}

/**
 * IfcBoundaryNodeCondition
 * @extends IfcBoundaryCondition
 */
export interface IfcBoundaryNodeCondition extends IfcBoundaryCondition {
  TranslationalStiffnessX?: IfcTranslationalStiffnessSelect;
  TranslationalStiffnessY?: IfcTranslationalStiffnessSelect;
  TranslationalStiffnessZ?: IfcTranslationalStiffnessSelect;
  RotationalStiffnessX?: IfcRotationalStiffnessSelect;
  RotationalStiffnessY?: IfcRotationalStiffnessSelect;
  RotationalStiffnessZ?: IfcRotationalStiffnessSelect;
}

/**
 * IfcBoundaryNodeConditionWarping
 * @extends IfcBoundaryNodeCondition
 */
export interface IfcBoundaryNodeConditionWarping extends IfcBoundaryNodeCondition {
  WarpingStiffness?: IfcWarpingStiffnessSelect;
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
  AgreementFlag: IfcBoolean;
}

/**
 * IfcBoxedHalfSpace
 * @extends IfcHalfSpaceSolid
 */
export interface IfcBoxedHalfSpace extends IfcHalfSpaceSolid {
  Enclosure: IfcBoundingBox;
}

/**
 * IfcSpatialElement
 * @abstract
 * @extends IfcProduct
 */
export interface IfcSpatialElement extends IfcProduct {
  LongName?: IfcLabel;
}

/**
 * IfcSpatialStructureElement
 * @abstract
 * @extends IfcSpatialElement
 */
export interface IfcSpatialStructureElement extends IfcSpatialElement {
  CompositionType?: IfcElementCompositionEnum;
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
 * IfcElementComponent
 * @abstract
 * @extends IfcElement
 */
export interface IfcElementComponent extends IfcElement {
}

/**
 * IfcBuildingElementPart
 * @extends IfcElementComponent
 */
export interface IfcBuildingElementPart extends IfcElementComponent {
  PredefinedType?: IfcBuildingElementPartTypeEnum;
}

/**
 * IfcElementComponentType
 * @abstract
 * @extends IfcElementType
 */
export interface IfcElementComponentType extends IfcElementType {
}

/**
 * IfcBuildingElementPartType
 * @extends IfcElementComponentType
 */
export interface IfcBuildingElementPartType extends IfcElementComponentType {
  PredefinedType: IfcBuildingElementPartTypeEnum;
}

/**
 * IfcBuildingElementProxy
 * @extends IfcBuildingElement
 */
export interface IfcBuildingElementProxy extends IfcBuildingElement {
  PredefinedType?: IfcBuildingElementProxyTypeEnum;
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
 * IfcSystem
 * @extends IfcGroup
 */
export interface IfcSystem extends IfcGroup {
}

/**
 * IfcBuildingSystem
 * @extends IfcSystem
 */
export interface IfcBuildingSystem extends IfcSystem {
  PredefinedType?: IfcBuildingSystemTypeEnum;
  LongName?: IfcLabel;
}

/**
 * IfcBurner
 * @extends IfcEnergyConversionDevice
 */
export interface IfcBurner extends IfcEnergyConversionDevice {
  PredefinedType?: IfcBurnerTypeEnum;
}

/**
 * IfcBurnerType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcBurnerType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcBurnerTypeEnum;
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
}

/**
 * IfcFlowFitting
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowFitting extends IfcDistributionFlowElement {
}

/**
 * IfcCableCarrierFitting
 * @extends IfcFlowFitting
 */
export interface IfcCableCarrierFitting extends IfcFlowFitting {
  PredefinedType?: IfcCableCarrierFittingTypeEnum;
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
 * IfcFlowSegment
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowSegment extends IfcDistributionFlowElement {
}

/**
 * IfcCableCarrierSegment
 * @extends IfcFlowSegment
 */
export interface IfcCableCarrierSegment extends IfcFlowSegment {
  PredefinedType?: IfcCableCarrierSegmentTypeEnum;
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
 * IfcCableFitting
 * @extends IfcFlowFitting
 */
export interface IfcCableFitting extends IfcFlowFitting {
  PredefinedType?: IfcCableFittingTypeEnum;
}

/**
 * IfcCableFittingType
 * @extends IfcFlowFittingType
 */
export interface IfcCableFittingType extends IfcFlowFittingType {
  PredefinedType: IfcCableFittingTypeEnum;
}

/**
 * IfcCableSegment
 * @extends IfcFlowSegment
 */
export interface IfcCableSegment extends IfcFlowSegment {
  PredefinedType?: IfcCableSegmentTypeEnum;
}

/**
 * IfcCableSegmentType
 * @extends IfcFlowSegmentType
 */
export interface IfcCableSegmentType extends IfcFlowSegmentType {
  PredefinedType: IfcCableSegmentTypeEnum;
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
 * IfcCartesianPointList
 * @abstract
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcCartesianPointList extends IfcGeometricRepresentationItem {
}

/**
 * IfcCartesianPointList2D
 * @extends IfcCartesianPointList
 */
export interface IfcCartesianPointList2D extends IfcCartesianPointList {
  CoordList: IfcLengthMeasure[][];
}

/**
 * IfcCartesianPointList3D
 * @extends IfcCartesianPointList
 */
export interface IfcCartesianPointList3D extends IfcCartesianPointList {
  CoordList: IfcLengthMeasure[][];
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
  Scale?: IfcReal;
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
  Scale2?: IfcReal;
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
  Scale2?: IfcReal;
  Scale3?: IfcReal;
}

/**
 * IfcCenterLineProfileDef
 * @extends IfcArbitraryOpenProfileDef
 */
export interface IfcCenterLineProfileDef extends IfcArbitraryOpenProfileDef {
  Thickness: number;
}

/**
 * IfcChiller
 * @extends IfcEnergyConversionDevice
 */
export interface IfcChiller extends IfcEnergyConversionDevice {
  PredefinedType?: IfcChillerTypeEnum;
}

/**
 * IfcChillerType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcChillerType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcChillerTypeEnum;
}

/**
 * IfcChimney
 * @extends IfcBuildingElement
 */
export interface IfcChimney extends IfcBuildingElement {
  PredefinedType?: IfcChimneyTypeEnum;
}

/**
 * IfcChimneyType
 * @extends IfcBuildingElementType
 */
export interface IfcChimneyType extends IfcBuildingElementType {
  PredefinedType: IfcChimneyTypeEnum;
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
 * IfcCivilElement
 * @extends IfcElement
 */
export interface IfcCivilElement extends IfcElement {
}

/**
 * IfcCivilElementType
 * @extends IfcElementType
 */
export interface IfcCivilElementType extends IfcElementType {
}

/**
 * IfcExternalInformation
 * @abstract
 */
export interface IfcExternalInformation {
}

/**
 * IfcClassification
 * @extends IfcExternalInformation
 */
export interface IfcClassification extends IfcExternalInformation {
  Source?: IfcLabel;
  Edition?: IfcLabel;
  EditionDate?: IfcDate;
  Name: IfcLabel;
  Description?: IfcText;
  Location?: IfcURIReference;
  ReferenceTokens?: IfcIdentifier[];
}

/**
 * IfcExternalReference
 * @abstract
 */
export interface IfcExternalReference {
  Location?: IfcURIReference;
  Identification?: IfcIdentifier;
  Name?: IfcLabel;
}

/**
 * IfcClassificationReference
 * @extends IfcExternalReference
 */
export interface IfcClassificationReference extends IfcExternalReference {
  ReferencedSource?: IfcClassificationReferenceSelect;
  Description?: IfcText;
  Sort?: IfcIdentifier;
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
 * IfcCoil
 * @extends IfcEnergyConversionDevice
 */
export interface IfcCoil extends IfcEnergyConversionDevice {
  PredefinedType?: IfcCoilTypeEnum;
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
 * @extends IfcPresentationItem
 */
export interface IfcColourSpecification extends IfcPresentationItem {
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
 * IfcColourRgbList
 * @extends IfcPresentationItem
 */
export interface IfcColourRgbList extends IfcPresentationItem {
  ColourList: IfcNormalisedRatioMeasure[][];
}

/**
 * IfcColumn
 * @extends IfcBuildingElement
 */
export interface IfcColumn extends IfcBuildingElement {
  PredefinedType?: IfcColumnTypeEnum;
}

/**
 * IfcColumnStandardCase
 * @extends IfcColumn
 */
export interface IfcColumnStandardCase extends IfcColumn {
}

/**
 * IfcColumnType
 * @extends IfcBuildingElementType
 */
export interface IfcColumnType extends IfcBuildingElementType {
  PredefinedType: IfcColumnTypeEnum;
}

/**
 * IfcCommunicationsAppliance
 * @extends IfcFlowTerminal
 */
export interface IfcCommunicationsAppliance extends IfcFlowTerminal {
  PredefinedType?: IfcCommunicationsApplianceTypeEnum;
}

/**
 * IfcCommunicationsApplianceType
 * @extends IfcFlowTerminalType
 */
export interface IfcCommunicationsApplianceType extends IfcFlowTerminalType {
  PredefinedType: IfcCommunicationsApplianceTypeEnum;
}

/**
 * IfcPropertyAbstraction
 * @abstract
 */
export interface IfcPropertyAbstraction {
}

/**
 * IfcProperty
 * @abstract
 * @extends IfcPropertyAbstraction
 */
export interface IfcProperty extends IfcPropertyAbstraction {
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
 * IfcPropertyDefinition
 * @abstract
 * @extends IfcRoot
 */
export interface IfcPropertyDefinition extends IfcRoot {
}

/**
 * IfcPropertyTemplateDefinition
 * @abstract
 * @extends IfcPropertyDefinition
 */
export interface IfcPropertyTemplateDefinition extends IfcPropertyDefinition {
}

/**
 * IfcPropertyTemplate
 * @abstract
 * @extends IfcPropertyTemplateDefinition
 */
export interface IfcPropertyTemplate extends IfcPropertyTemplateDefinition {
}

/**
 * IfcComplexPropertyTemplate
 * @extends IfcPropertyTemplate
 */
export interface IfcComplexPropertyTemplate extends IfcPropertyTemplate {
  UsageName?: IfcLabel;
  TemplateType?: IfcComplexPropertyTemplateTypeEnum;
  HasPropertyTemplates?: IfcPropertyTemplate[];
}

/**
 * IfcCompositeCurveSegment
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcCompositeCurveSegment extends IfcGeometricRepresentationItem {
  Transition: IfcTransitionCode;
  SameSense: IfcBoolean;
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
 * IfcFlowMovingDevice
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowMovingDevice extends IfcDistributionFlowElement {
}

/**
 * IfcCompressor
 * @extends IfcFlowMovingDevice
 */
export interface IfcCompressor extends IfcFlowMovingDevice {
  PredefinedType?: IfcCompressorTypeEnum;
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
 * IfcCondenser
 * @extends IfcEnergyConversionDevice
 */
export interface IfcCondenser extends IfcEnergyConversionDevice {
  PredefinedType?: IfcCondenserTypeEnum;
}

/**
 * IfcCondenserType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcCondenserType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcCondenserTypeEnum;
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
 * IfcConnectionSurfaceGeometry
 * @extends IfcConnectionGeometry
 */
export interface IfcConnectionSurfaceGeometry extends IfcConnectionGeometry {
  SurfaceOnRelatingElement: IfcSurfaceOrFaceSurface;
  SurfaceOnRelatedElement?: IfcSurfaceOrFaceSurface;
}

/**
 * IfcConnectionVolumeGeometry
 * @extends IfcConnectionGeometry
 */
export interface IfcConnectionVolumeGeometry extends IfcConnectionGeometry {
  VolumeOnRelatingElement: IfcSolidOrShell;
  VolumeOnRelatedElement?: IfcSolidOrShell;
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
  CreationTime?: IfcDateTime;
  UserDefinedGrade?: IfcLabel;
}

/**
 * IfcResource
 * @abstract
 * @extends IfcObject
 */
export interface IfcResource extends IfcObject {
  Identification?: IfcIdentifier;
  LongDescription?: IfcText;
}

/**
 * IfcConstructionResource
 * @abstract
 * @extends IfcResource
 */
export interface IfcConstructionResource extends IfcResource {
  Usage?: IfcResourceTime;
  BaseCosts?: IfcAppliedValue[];
  BaseQuantity?: IfcPhysicalQuantity;
}

/**
 * IfcConstructionEquipmentResource
 * @extends IfcConstructionResource
 */
export interface IfcConstructionEquipmentResource extends IfcConstructionResource {
  PredefinedType?: IfcConstructionEquipmentResourceTypeEnum;
}

/**
 * IfcTypeResource
 * @abstract
 * @extends IfcTypeObject
 */
export interface IfcTypeResource extends IfcTypeObject {
  Identification?: IfcIdentifier;
  LongDescription?: IfcText;
  ResourceType?: IfcLabel;
}

/**
 * IfcConstructionResourceType
 * @abstract
 * @extends IfcTypeResource
 */
export interface IfcConstructionResourceType extends IfcTypeResource {
  BaseCosts?: IfcAppliedValue[];
  BaseQuantity?: IfcPhysicalQuantity;
}

/**
 * IfcConstructionEquipmentResourceType
 * @extends IfcConstructionResourceType
 */
export interface IfcConstructionEquipmentResourceType extends IfcConstructionResourceType {
  PredefinedType: IfcConstructionEquipmentResourceTypeEnum;
}

/**
 * IfcConstructionMaterialResource
 * @extends IfcConstructionResource
 */
export interface IfcConstructionMaterialResource extends IfcConstructionResource {
  PredefinedType?: IfcConstructionMaterialResourceTypeEnum;
}

/**
 * IfcConstructionMaterialResourceType
 * @extends IfcConstructionResourceType
 */
export interface IfcConstructionMaterialResourceType extends IfcConstructionResourceType {
  PredefinedType: IfcConstructionMaterialResourceTypeEnum;
}

/**
 * IfcConstructionProductResource
 * @extends IfcConstructionResource
 */
export interface IfcConstructionProductResource extends IfcConstructionResource {
  PredefinedType?: IfcConstructionProductResourceTypeEnum;
}

/**
 * IfcConstructionProductResourceType
 * @extends IfcConstructionResourceType
 */
export interface IfcConstructionProductResourceType extends IfcConstructionResourceType {
  PredefinedType: IfcConstructionProductResourceTypeEnum;
}

/**
 * IfcContext
 * @abstract
 * @extends IfcObjectDefinition
 */
export interface IfcContext extends IfcObjectDefinition {
  ObjectType?: IfcLabel;
  LongName?: IfcLabel;
  Phase?: IfcLabel;
  RepresentationContexts?: IfcRepresentationContext[];
  UnitsInContext?: IfcUnitAssignment;
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
 * IfcController
 * @extends IfcDistributionControlElement
 */
export interface IfcController extends IfcDistributionControlElement {
  PredefinedType?: IfcControllerTypeEnum;
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
 * IfcConversionBasedUnitWithOffset
 * @extends IfcConversionBasedUnit
 */
export interface IfcConversionBasedUnitWithOffset extends IfcConversionBasedUnit {
  ConversionOffset: IfcReal;
}

/**
 * IfcCooledBeam
 * @extends IfcEnergyConversionDevice
 */
export interface IfcCooledBeam extends IfcEnergyConversionDevice {
  PredefinedType?: IfcCooledBeamTypeEnum;
}

/**
 * IfcCooledBeamType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcCooledBeamType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcCooledBeamTypeEnum;
}

/**
 * IfcCoolingTower
 * @extends IfcEnergyConversionDevice
 */
export interface IfcCoolingTower extends IfcEnergyConversionDevice {
  PredefinedType?: IfcCoolingTowerTypeEnum;
}

/**
 * IfcCoolingTowerType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcCoolingTowerType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcCoolingTowerTypeEnum;
}

/**
 * IfcCoordinateOperation
 * @abstract
 */
export interface IfcCoordinateOperation {
  SourceCRS: IfcCoordinateReferenceSystemSelect;
  TargetCRS: IfcCoordinateReferenceSystem;
}

/**
 * IfcCoordinateReferenceSystem
 * @abstract
 */
export interface IfcCoordinateReferenceSystem {
  Name: IfcLabel;
  Description?: IfcText;
  GeodeticDatum?: IfcIdentifier;
  VerticalDatum?: IfcIdentifier;
}

/**
 * IfcCostItem
 * @extends IfcControl
 */
export interface IfcCostItem extends IfcControl {
  PredefinedType?: IfcCostItemTypeEnum;
  CostValues?: IfcCostValue[];
  CostQuantities?: IfcPhysicalQuantity[];
}

/**
 * IfcCostSchedule
 * @extends IfcControl
 */
export interface IfcCostSchedule extends IfcControl {
  PredefinedType?: IfcCostScheduleTypeEnum;
  Status?: IfcLabel;
  SubmittedOn?: IfcDateTime;
  UpdateDate?: IfcDateTime;
}

/**
 * IfcCostValue
 * @extends IfcAppliedValue
 */
export interface IfcCostValue extends IfcAppliedValue {
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
 * IfcCrewResource
 * @extends IfcConstructionResource
 */
export interface IfcCrewResource extends IfcConstructionResource {
  PredefinedType?: IfcCrewResourceTypeEnum;
}

/**
 * IfcCrewResourceType
 * @extends IfcConstructionResourceType
 */
export interface IfcCrewResourceType extends IfcConstructionResourceType {
  PredefinedType: IfcCrewResourceTypeEnum;
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
 * @extends IfcResourceLevelRelationship
 */
export interface IfcCurrencyRelationship extends IfcResourceLevelRelationship {
  RelatingMonetaryUnit: IfcMonetaryUnit;
  RelatedMonetaryUnit: IfcMonetaryUnit;
  ExchangeRate: number;
  RateDateTime?: IfcDateTime;
  RateSource?: IfcLibraryInformation;
}

/**
 * IfcCurtainWall
 * @extends IfcBuildingElement
 */
export interface IfcCurtainWall extends IfcBuildingElement {
  PredefinedType?: IfcCurtainWallTypeEnum;
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
 * IfcCurveBoundedSurface
 * @extends IfcBoundedSurface
 */
export interface IfcCurveBoundedSurface extends IfcBoundedSurface {
  BasisSurface: IfcSurface;
  Boundaries: IfcBoundaryCurve[];
  ImplicitOuter: IfcBoolean;
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
  ModelOrDraughting?: IfcBoolean;
}

/**
 * IfcCurveStyleFont
 * @extends IfcPresentationItem
 */
export interface IfcCurveStyleFont extends IfcPresentationItem {
  Name?: IfcLabel;
  PatternList: IfcCurveStyleFontPattern[];
}

/**
 * IfcCurveStyleFontAndScaling
 * @extends IfcPresentationItem
 */
export interface IfcCurveStyleFontAndScaling extends IfcPresentationItem {
  Name?: IfcLabel;
  CurveFont: IfcCurveStyleFontSelect;
  CurveFontScaling: number;
}

/**
 * IfcCurveStyleFontPattern
 * @extends IfcPresentationItem
 */
export interface IfcCurveStyleFontPattern extends IfcPresentationItem {
  VisibleSegmentLength: number;
  InvisibleSegmentLength: number;
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
 * IfcCylindricalSurface
 * @extends IfcElementarySurface
 */
export interface IfcCylindricalSurface extends IfcElementarySurface {
  Radius: number;
}

/**
 * IfcDamper
 * @extends IfcFlowController
 */
export interface IfcDamper extends IfcFlowController {
  PredefinedType?: IfcDamperTypeEnum;
}

/**
 * IfcDamperType
 * @extends IfcFlowControllerType
 */
export interface IfcDamperType extends IfcFlowControllerType {
  PredefinedType: IfcDamperTypeEnum;
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
  DirectionRatios: IfcReal[];
}

/**
 * IfcDiscreteAccessory
 * @extends IfcElementComponent
 */
export interface IfcDiscreteAccessory extends IfcElementComponent {
  PredefinedType?: IfcDiscreteAccessoryTypeEnum;
}

/**
 * IfcDiscreteAccessoryType
 * @extends IfcElementComponentType
 */
export interface IfcDiscreteAccessoryType extends IfcElementComponentType {
  PredefinedType: IfcDiscreteAccessoryTypeEnum;
}

/**
 * IfcDistributionChamberElement
 * @extends IfcDistributionFlowElement
 */
export interface IfcDistributionChamberElement extends IfcDistributionFlowElement {
  PredefinedType?: IfcDistributionChamberElementTypeEnum;
}

/**
 * IfcDistributionChamberElementType
 * @extends IfcDistributionFlowElementType
 */
export interface IfcDistributionChamberElementType extends IfcDistributionFlowElementType {
  PredefinedType: IfcDistributionChamberElementTypeEnum;
}

/**
 * IfcDistributionSystem
 * @extends IfcSystem
 */
export interface IfcDistributionSystem extends IfcSystem {
  LongName?: IfcLabel;
  PredefinedType?: IfcDistributionSystemEnum;
}

/**
 * IfcDistributionCircuit
 * @extends IfcDistributionSystem
 */
export interface IfcDistributionCircuit extends IfcDistributionSystem {
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
  PredefinedType?: IfcDistributionPortTypeEnum;
  SystemType?: IfcDistributionSystemEnum;
}

/**
 * IfcDocumentInformation
 * @extends IfcExternalInformation
 */
export interface IfcDocumentInformation extends IfcExternalInformation {
  Identification: IfcIdentifier;
  Name: IfcLabel;
  Description?: IfcText;
  Location?: IfcURIReference;
  Purpose?: IfcText;
  IntendedUse?: IfcText;
  Scope?: IfcText;
  Revision?: IfcLabel;
  DocumentOwner?: IfcActorSelect;
  Editors?: IfcActorSelect[];
  CreationTime?: IfcDateTime;
  LastRevisionTime?: IfcDateTime;
  ElectronicFormat?: IfcIdentifier;
  ValidFrom?: IfcDate;
  ValidUntil?: IfcDate;
  Confidentiality?: IfcDocumentConfidentialityEnum;
  Status?: IfcDocumentStatusEnum;
}

/**
 * IfcDocumentInformationRelationship
 * @extends IfcResourceLevelRelationship
 */
export interface IfcDocumentInformationRelationship extends IfcResourceLevelRelationship {
  RelatingDocument: IfcDocumentInformation;
  RelatedDocuments: IfcDocumentInformation[];
  RelationshipType?: IfcLabel;
}

/**
 * IfcDocumentReference
 * @extends IfcExternalReference
 */
export interface IfcDocumentReference extends IfcExternalReference {
  Description?: IfcText;
  ReferencedDocument?: IfcDocumentInformation;
}

/**
 * IfcDoor
 * @extends IfcBuildingElement
 */
export interface IfcDoor extends IfcBuildingElement {
  OverallHeight?: number;
  OverallWidth?: number;
  PredefinedType?: IfcDoorTypeEnum;
  OperationType?: IfcDoorTypeOperationEnum;
  UserDefinedOperationType?: IfcLabel;
}

/**
 * IfcPropertySetDefinition
 * @abstract
 * @extends IfcPropertyDefinition
 */
export interface IfcPropertySetDefinition extends IfcPropertyDefinition {
}

/**
 * IfcPreDefinedPropertySet
 * @abstract
 * @extends IfcPropertySetDefinition
 */
export interface IfcPreDefinedPropertySet extends IfcPropertySetDefinition {
}

/**
 * IfcDoorLiningProperties
 * @extends IfcPreDefinedPropertySet
 */
export interface IfcDoorLiningProperties extends IfcPreDefinedPropertySet {
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
  LiningToPanelOffsetX?: number;
  LiningToPanelOffsetY?: number;
}

/**
 * IfcDoorPanelProperties
 * @extends IfcPreDefinedPropertySet
 */
export interface IfcDoorPanelProperties extends IfcPreDefinedPropertySet {
  PanelDepth?: number;
  PanelOperation: IfcDoorPanelOperationEnum;
  PanelWidth?: number;
  PanelPosition: IfcDoorPanelPositionEnum;
  ShapeAspectStyle?: IfcShapeAspect;
}

/**
 * IfcDoorStandardCase
 * @extends IfcDoor
 */
export interface IfcDoorStandardCase extends IfcDoor {
}

/**
 * IfcDoorStyle
 * @extends IfcTypeProduct
 */
export interface IfcDoorStyle extends IfcTypeProduct {
  OperationType: IfcDoorStyleOperationEnum;
  ConstructionType: IfcDoorStyleConstructionEnum;
  ParameterTakesPrecedence: IfcBoolean;
  Sizeable: IfcBoolean;
}

/**
 * IfcDoorType
 * @extends IfcBuildingElementType
 */
export interface IfcDoorType extends IfcBuildingElementType {
  PredefinedType: IfcDoorTypeEnum;
  OperationType: IfcDoorTypeOperationEnum;
  ParameterTakesPrecedence?: IfcBoolean;
  UserDefinedOperationType?: IfcLabel;
}

/**
 * IfcPreDefinedItem
 * @abstract
 * @extends IfcPresentationItem
 */
export interface IfcPreDefinedItem extends IfcPresentationItem {
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
 * IfcDuctFitting
 * @extends IfcFlowFitting
 */
export interface IfcDuctFitting extends IfcFlowFitting {
  PredefinedType?: IfcDuctFittingTypeEnum;
}

/**
 * IfcDuctFittingType
 * @extends IfcFlowFittingType
 */
export interface IfcDuctFittingType extends IfcFlowFittingType {
  PredefinedType: IfcDuctFittingTypeEnum;
}

/**
 * IfcDuctSegment
 * @extends IfcFlowSegment
 */
export interface IfcDuctSegment extends IfcFlowSegment {
  PredefinedType?: IfcDuctSegmentTypeEnum;
}

/**
 * IfcDuctSegmentType
 * @extends IfcFlowSegmentType
 */
export interface IfcDuctSegmentType extends IfcFlowSegmentType {
  PredefinedType: IfcDuctSegmentTypeEnum;
}

/**
 * IfcFlowTreatmentDevice
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowTreatmentDevice extends IfcDistributionFlowElement {
}

/**
 * IfcDuctSilencer
 * @extends IfcFlowTreatmentDevice
 */
export interface IfcDuctSilencer extends IfcFlowTreatmentDevice {
  PredefinedType?: IfcDuctSilencerTypeEnum;
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
  SameSense: IfcBoolean;
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
 * IfcElectricAppliance
 * @extends IfcFlowTerminal
 */
export interface IfcElectricAppliance extends IfcFlowTerminal {
  PredefinedType?: IfcElectricApplianceTypeEnum;
}

/**
 * IfcElectricApplianceType
 * @extends IfcFlowTerminalType
 */
export interface IfcElectricApplianceType extends IfcFlowTerminalType {
  PredefinedType: IfcElectricApplianceTypeEnum;
}

/**
 * IfcElectricDistributionBoard
 * @extends IfcFlowController
 */
export interface IfcElectricDistributionBoard extends IfcFlowController {
  PredefinedType?: IfcElectricDistributionBoardTypeEnum;
}

/**
 * IfcElectricDistributionBoardType
 * @extends IfcFlowControllerType
 */
export interface IfcElectricDistributionBoardType extends IfcFlowControllerType {
  PredefinedType: IfcElectricDistributionBoardTypeEnum;
}

/**
 * IfcFlowStorageDevice
 * @extends IfcDistributionFlowElement
 */
export interface IfcFlowStorageDevice extends IfcDistributionFlowElement {
}

/**
 * IfcElectricFlowStorageDevice
 * @extends IfcFlowStorageDevice
 */
export interface IfcElectricFlowStorageDevice extends IfcFlowStorageDevice {
  PredefinedType?: IfcElectricFlowStorageDeviceTypeEnum;
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
 * IfcElectricGenerator
 * @extends IfcEnergyConversionDevice
 */
export interface IfcElectricGenerator extends IfcEnergyConversionDevice {
  PredefinedType?: IfcElectricGeneratorTypeEnum;
}

/**
 * IfcElectricGeneratorType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcElectricGeneratorType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcElectricGeneratorTypeEnum;
}

/**
 * IfcElectricMotor
 * @extends IfcEnergyConversionDevice
 */
export interface IfcElectricMotor extends IfcEnergyConversionDevice {
  PredefinedType?: IfcElectricMotorTypeEnum;
}

/**
 * IfcElectricMotorType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcElectricMotorType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcElectricMotorTypeEnum;
}

/**
 * IfcElectricTimeControl
 * @extends IfcFlowController
 */
export interface IfcElectricTimeControl extends IfcFlowController {
  PredefinedType?: IfcElectricTimeControlTypeEnum;
}

/**
 * IfcElectricTimeControlType
 * @extends IfcFlowControllerType
 */
export interface IfcElectricTimeControlType extends IfcFlowControllerType {
  PredefinedType: IfcElectricTimeControlTypeEnum;
}

/**
 * IfcElementAssembly
 * @extends IfcElement
 */
export interface IfcElementAssembly extends IfcElement {
  AssemblyPlace?: IfcAssemblyPlaceEnum;
  PredefinedType?: IfcElementAssemblyTypeEnum;
}

/**
 * IfcElementAssemblyType
 * @extends IfcElementType
 */
export interface IfcElementAssemblyType extends IfcElementType {
  PredefinedType: IfcElementAssemblyTypeEnum;
}

/**
 * IfcQuantitySet
 * @abstract
 * @extends IfcPropertySetDefinition
 */
export interface IfcQuantitySet extends IfcPropertySetDefinition {
}

/**
 * IfcElementQuantity
 * @extends IfcQuantitySet
 */
export interface IfcElementQuantity extends IfcQuantitySet {
  MethodOfMeasurement?: IfcLabel;
  Quantities: IfcPhysicalQuantity[];
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
 * IfcEngine
 * @extends IfcEnergyConversionDevice
 */
export interface IfcEngine extends IfcEnergyConversionDevice {
  PredefinedType?: IfcEngineTypeEnum;
}

/**
 * IfcEngineType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcEngineType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcEngineTypeEnum;
}

/**
 * IfcEvaporativeCooler
 * @extends IfcEnergyConversionDevice
 */
export interface IfcEvaporativeCooler extends IfcEnergyConversionDevice {
  PredefinedType?: IfcEvaporativeCoolerTypeEnum;
}

/**
 * IfcEvaporativeCoolerType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcEvaporativeCoolerType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcEvaporativeCoolerTypeEnum;
}

/**
 * IfcEvaporator
 * @extends IfcEnergyConversionDevice
 */
export interface IfcEvaporator extends IfcEnergyConversionDevice {
  PredefinedType?: IfcEvaporatorTypeEnum;
}

/**
 * IfcEvaporatorType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcEvaporatorType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcEvaporatorTypeEnum;
}

/**
 * IfcProcess
 * @abstract
 * @extends IfcObject
 */
export interface IfcProcess extends IfcObject {
  Identification?: IfcIdentifier;
  LongDescription?: IfcText;
}

/**
 * IfcEvent
 * @extends IfcProcess
 */
export interface IfcEvent extends IfcProcess {
  PredefinedType?: IfcEventTypeEnum;
  EventTriggerType?: IfcEventTriggerTypeEnum;
  UserDefinedEventTriggerType?: IfcLabel;
  EventOccurenceTime?: IfcEventTime;
}

/**
 * IfcSchedulingTime
 * @abstract
 */
export interface IfcSchedulingTime {
  Name?: IfcLabel;
  DataOrigin?: IfcDataOriginEnum;
  UserDefinedDataOrigin?: IfcLabel;
}

/**
 * IfcEventTime
 * @extends IfcSchedulingTime
 */
export interface IfcEventTime extends IfcSchedulingTime {
  ActualDate?: IfcDateTime;
  EarlyDate?: IfcDateTime;
  LateDate?: IfcDateTime;
  ScheduleDate?: IfcDateTime;
}

/**
 * IfcTypeProcess
 * @abstract
 * @extends IfcTypeObject
 */
export interface IfcTypeProcess extends IfcTypeObject {
  Identification?: IfcIdentifier;
  LongDescription?: IfcText;
  ProcessType?: IfcLabel;
}

/**
 * IfcEventType
 * @extends IfcTypeProcess
 */
export interface IfcEventType extends IfcTypeProcess {
  PredefinedType: IfcEventTypeEnum;
  EventTriggerType: IfcEventTriggerTypeEnum;
  UserDefinedEventTriggerType?: IfcLabel;
}

/**
 * IfcExtendedProperties
 * @abstract
 * @extends IfcPropertyAbstraction
 */
export interface IfcExtendedProperties extends IfcPropertyAbstraction {
  Name?: IfcIdentifier;
  Description?: IfcText;
  Properties: IfcProperty[];
}

/**
 * IfcExternalReferenceRelationship
 * @extends IfcResourceLevelRelationship
 */
export interface IfcExternalReferenceRelationship extends IfcResourceLevelRelationship {
  RelatingReference: IfcExternalReference;
  RelatedResourceObjects: IfcResourceObjectSelect[];
}

/**
 * IfcExternalSpatialStructureElement
 * @abstract
 * @extends IfcSpatialElement
 */
export interface IfcExternalSpatialStructureElement extends IfcSpatialElement {
}

/**
 * IfcExternalSpatialElement
 * @extends IfcExternalSpatialStructureElement
 */
export interface IfcExternalSpatialElement extends IfcExternalSpatialStructureElement {
  PredefinedType?: IfcExternalSpatialElementTypeEnum;
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
  Position?: IfcAxis2Placement3D;
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
 * IfcExtrudedAreaSolidTapered
 * @extends IfcExtrudedAreaSolid
 */
export interface IfcExtrudedAreaSolidTapered extends IfcExtrudedAreaSolid {
  EndSweptArea: IfcProfileDef;
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
  Orientation: IfcBoolean;
}

/**
 * IfcFaceOuterBound
 * @extends IfcFaceBound
 */
export interface IfcFaceOuterBound extends IfcFaceBound {
}

/**
 * IfcFacetedBrep
 * @extends IfcManifoldSolidBrep
 */
export interface IfcFacetedBrep extends IfcManifoldSolidBrep {
}

/**
 * IfcFacetedBrepWithVoids
 * @extends IfcFacetedBrep
 */
export interface IfcFacetedBrepWithVoids extends IfcFacetedBrep {
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
 * IfcFan
 * @extends IfcFlowMovingDevice
 */
export interface IfcFan extends IfcFlowMovingDevice {
  PredefinedType?: IfcFanTypeEnum;
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
  PredefinedType?: IfcFastenerTypeEnum;
}

/**
 * IfcFastenerType
 * @extends IfcElementComponentType
 */
export interface IfcFastenerType extends IfcElementComponentType {
  PredefinedType: IfcFastenerTypeEnum;
}

/**
 * IfcFeatureElement
 * @abstract
 * @extends IfcElement
 */
export interface IfcFeatureElement extends IfcElement {
}

/**
 * IfcFeatureElementAddition
 * @abstract
 * @extends IfcFeatureElement
 */
export interface IfcFeatureElementAddition extends IfcFeatureElement {
}

/**
 * IfcFeatureElementSubtraction
 * @abstract
 * @extends IfcFeatureElement
 */
export interface IfcFeatureElementSubtraction extends IfcFeatureElement {
}

/**
 * IfcFillAreaStyle
 * @extends IfcPresentationStyle
 */
export interface IfcFillAreaStyle extends IfcPresentationStyle {
  FillStyles: IfcFillStyleSelect[];
  ModelorDraughting?: IfcBoolean;
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
 * IfcFillAreaStyleTiles
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcFillAreaStyleTiles extends IfcGeometricRepresentationItem {
  TilingPattern: IfcVector[];
  Tiles: IfcStyledItem[];
  TilingScale: number;
}

/**
 * IfcFilter
 * @extends IfcFlowTreatmentDevice
 */
export interface IfcFilter extends IfcFlowTreatmentDevice {
  PredefinedType?: IfcFilterTypeEnum;
}

/**
 * IfcFilterType
 * @extends IfcFlowTreatmentDeviceType
 */
export interface IfcFilterType extends IfcFlowTreatmentDeviceType {
  PredefinedType: IfcFilterTypeEnum;
}

/**
 * IfcFireSuppressionTerminal
 * @extends IfcFlowTerminal
 */
export interface IfcFireSuppressionTerminal extends IfcFlowTerminal {
  PredefinedType?: IfcFireSuppressionTerminalTypeEnum;
}

/**
 * IfcFireSuppressionTerminalType
 * @extends IfcFlowTerminalType
 */
export interface IfcFireSuppressionTerminalType extends IfcFlowTerminalType {
  PredefinedType: IfcFireSuppressionTerminalTypeEnum;
}

/**
 * IfcFixedReferenceSweptAreaSolid
 * @extends IfcSweptAreaSolid
 */
export interface IfcFixedReferenceSweptAreaSolid extends IfcSweptAreaSolid {
  Directrix: IfcCurve;
  StartParam?: IfcParameterValue;
  EndParam?: IfcParameterValue;
  FixedReference: IfcDirection;
}

/**
 * IfcFlowInstrument
 * @extends IfcDistributionControlElement
 */
export interface IfcFlowInstrument extends IfcDistributionControlElement {
  PredefinedType?: IfcFlowInstrumentTypeEnum;
}

/**
 * IfcFlowInstrumentType
 * @extends IfcDistributionControlElementType
 */
export interface IfcFlowInstrumentType extends IfcDistributionControlElementType {
  PredefinedType: IfcFlowInstrumentTypeEnum;
}

/**
 * IfcFlowMeter
 * @extends IfcFlowController
 */
export interface IfcFlowMeter extends IfcFlowController {
  PredefinedType?: IfcFlowMeterTypeEnum;
}

/**
 * IfcFlowMeterType
 * @extends IfcFlowControllerType
 */
export interface IfcFlowMeterType extends IfcFlowControllerType {
  PredefinedType: IfcFlowMeterTypeEnum;
}

/**
 * IfcFooting
 * @extends IfcBuildingElement
 */
export interface IfcFooting extends IfcBuildingElement {
  PredefinedType?: IfcFootingTypeEnum;
}

/**
 * IfcFootingType
 * @extends IfcBuildingElementType
 */
export interface IfcFootingType extends IfcBuildingElementType {
  PredefinedType: IfcFootingTypeEnum;
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
 * IfcFurniture
 * @extends IfcFurnishingElement
 */
export interface IfcFurniture extends IfcFurnishingElement {
  PredefinedType?: IfcFurnitureTypeEnum;
}

/**
 * IfcFurnitureType
 * @extends IfcFurnishingElementType
 */
export interface IfcFurnitureType extends IfcFurnishingElementType {
  AssemblyPlace: IfcAssemblyPlaceEnum;
  PredefinedType?: IfcFurnitureTypeEnum;
}

/**
 * IfcGeographicElement
 * @extends IfcElement
 */
export interface IfcGeographicElement extends IfcElement {
  PredefinedType?: IfcGeographicElementTypeEnum;
}

/**
 * IfcGeographicElementType
 * @extends IfcElementType
 */
export interface IfcGeographicElementType extends IfcElementType {
  PredefinedType: IfcGeographicElementTypeEnum;
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
 * @abstract
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
  Precision?: IfcReal;
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
  PredefinedType?: IfcGridTypeEnum;
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
  PlacementRefDirection?: IfcGridPlacementDirectionSelect;
}

/**
 * IfcHeatExchanger
 * @extends IfcEnergyConversionDevice
 */
export interface IfcHeatExchanger extends IfcEnergyConversionDevice {
  PredefinedType?: IfcHeatExchangerTypeEnum;
}

/**
 * IfcHeatExchangerType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcHeatExchangerType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcHeatExchangerTypeEnum;
}

/**
 * IfcHumidifier
 * @extends IfcEnergyConversionDevice
 */
export interface IfcHumidifier extends IfcEnergyConversionDevice {
  PredefinedType?: IfcHumidifierTypeEnum;
}

/**
 * IfcHumidifierType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcHumidifierType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcHumidifierTypeEnum;
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
  FlangeEdgeRadius?: number;
  FlangeSlope?: number;
}

/**
 * IfcImageTexture
 * @extends IfcSurfaceTexture
 */
export interface IfcImageTexture extends IfcSurfaceTexture {
  URLReference: IfcURIReference;
}

/**
 * IfcIndexedColourMap
 * @extends IfcPresentationItem
 */
export interface IfcIndexedColourMap extends IfcPresentationItem {
  MappedTo: IfcTessellatedFaceSet;
  Opacity?: number;
  Colours: IfcColourRgbList;
  ColourIndex: IfcPositiveInteger[];
}

/**
 * IfcIndexedPolyCurve
 * @extends IfcBoundedCurve
 */
export interface IfcIndexedPolyCurve extends IfcBoundedCurve {
  Points: IfcCartesianPointList;
  Segments?: IfcSegmentIndexSelect[];
  SelfIntersect?: IfcBoolean;
}

/**
 * IfcTessellatedItem
 * @abstract
 * @extends IfcGeometricRepresentationItem
 */
export interface IfcTessellatedItem extends IfcGeometricRepresentationItem {
}

/**
 * IfcIndexedPolygonalFace
 * @extends IfcTessellatedItem
 */
export interface IfcIndexedPolygonalFace extends IfcTessellatedItem {
  CoordIndex: IfcPositiveInteger[];
}

/**
 * IfcIndexedPolygonalFaceWithVoids
 * @extends IfcIndexedPolygonalFace
 */
export interface IfcIndexedPolygonalFaceWithVoids extends IfcIndexedPolygonalFace {
  InnerCoordIndices: IfcPositiveInteger[][];
}

/**
 * IfcTextureCoordinate
 * @abstract
 * @extends IfcPresentationItem
 */
export interface IfcTextureCoordinate extends IfcPresentationItem {
  Maps: IfcSurfaceTexture[];
}

/**
 * IfcIndexedTextureMap
 * @abstract
 * @extends IfcTextureCoordinate
 */
export interface IfcIndexedTextureMap extends IfcTextureCoordinate {
  MappedTo: IfcTessellatedFaceSet;
  TexCoords: IfcTextureVertexList;
}

/**
 * IfcIndexedTriangleTextureMap
 * @extends IfcIndexedTextureMap
 */
export interface IfcIndexedTriangleTextureMap extends IfcIndexedTextureMap {
  TexCoordIndex?: IfcPositiveInteger[][];
}

/**
 * IfcInterceptor
 * @extends IfcFlowTreatmentDevice
 */
export interface IfcInterceptor extends IfcFlowTreatmentDevice {
  PredefinedType?: IfcInterceptorTypeEnum;
}

/**
 * IfcInterceptorType
 * @extends IfcFlowTreatmentDeviceType
 */
export interface IfcInterceptorType extends IfcFlowTreatmentDeviceType {
  PredefinedType: IfcInterceptorTypeEnum;
}

/**
 * IfcSurfaceCurve
 * @extends IfcCurve
 */
export interface IfcSurfaceCurve extends IfcCurve {
  Curve3D: IfcCurve;
  AssociatedGeometry: IfcPcurve[];
  MasterRepresentation: IfcPreferredSurfaceCurveRepresentation;
}

/**
 * IfcIntersectionCurve
 * @extends IfcSurfaceCurve
 */
export interface IfcIntersectionCurve extends IfcSurfaceCurve {
}

/**
 * IfcInventory
 * @extends IfcGroup
 */
export interface IfcInventory extends IfcGroup {
  PredefinedType?: IfcInventoryTypeEnum;
  Jurisdiction?: IfcActorSelect;
  ResponsiblePersons?: IfcPerson[];
  LastUpdateDate?: IfcDate;
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
  StartTime: IfcDateTime;
  EndTime: IfcDateTime;
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
  TimeStamp: IfcDateTime;
  ListValues: IfcValue[];
}

/**
 * IfcJunctionBox
 * @extends IfcFlowFitting
 */
export interface IfcJunctionBox extends IfcFlowFitting {
  PredefinedType?: IfcJunctionBoxTypeEnum;
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
}

/**
 * IfcLaborResource
 * @extends IfcConstructionResource
 */
export interface IfcLaborResource extends IfcConstructionResource {
  PredefinedType?: IfcLaborResourceTypeEnum;
}

/**
 * IfcLaborResourceType
 * @extends IfcConstructionResourceType
 */
export interface IfcLaborResourceType extends IfcConstructionResourceType {
  PredefinedType: IfcLaborResourceTypeEnum;
}

/**
 * IfcLagTime
 * @extends IfcSchedulingTime
 */
export interface IfcLagTime extends IfcSchedulingTime {
  LagValue: IfcTimeOrRatioSelect;
  DurationType: IfcTaskDurationEnum;
}

/**
 * IfcLamp
 * @extends IfcFlowTerminal
 */
export interface IfcLamp extends IfcFlowTerminal {
  PredefinedType?: IfcLampTypeEnum;
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
 * @extends IfcExternalInformation
 */
export interface IfcLibraryInformation extends IfcExternalInformation {
  Name: IfcLabel;
  Version?: IfcLabel;
  Publisher?: IfcActorSelect;
  VersionDate?: IfcDateTime;
  Location?: IfcURIReference;
  Description?: IfcText;
}

/**
 * IfcLibraryReference
 * @extends IfcExternalReference
 */
export interface IfcLibraryReference extends IfcExternalReference {
  Description?: IfcText;
  Language?: IfcLanguageId;
  ReferencedLibrary?: IfcLibraryInformation;
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
 * IfcLightFixture
 * @extends IfcFlowTerminal
 */
export interface IfcLightFixture extends IfcFlowTerminal {
  PredefinedType?: IfcLightFixtureTypeEnum;
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
 * IfcLocalPlacement
 * @extends IfcObjectPlacement
 */
export interface IfcLocalPlacement extends IfcObjectPlacement {
  PlacementRelTo?: IfcObjectPlacement;
  RelativePlacement: IfcAxis2Placement;
}

/**
 * IfcMapConversion
 * @extends IfcCoordinateOperation
 */
export interface IfcMapConversion extends IfcCoordinateOperation {
  Eastings: number;
  Northings: number;
  OrthogonalHeight: number;
  XAxisAbscissa?: IfcReal;
  XAxisOrdinate?: IfcReal;
  Scale?: IfcReal;
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
 * IfcMaterialDefinition
 * @abstract
 */
export interface IfcMaterialDefinition {
}

/**
 * IfcMaterial
 * @extends IfcMaterialDefinition
 */
export interface IfcMaterial extends IfcMaterialDefinition {
  Name: IfcLabel;
  Description?: IfcText;
  Category?: IfcLabel;
}

/**
 * IfcMaterialClassificationRelationship
 */
export interface IfcMaterialClassificationRelationship {
  MaterialClassifications: IfcClassificationSelect[];
  ClassifiedMaterial: IfcMaterial;
}

/**
 * IfcMaterialConstituent
 * @extends IfcMaterialDefinition
 */
export interface IfcMaterialConstituent extends IfcMaterialDefinition {
  Name?: IfcLabel;
  Description?: IfcText;
  Material: IfcMaterial;
  Fraction?: number;
  Category?: IfcLabel;
}

/**
 * IfcMaterialConstituentSet
 * @extends IfcMaterialDefinition
 */
export interface IfcMaterialConstituentSet extends IfcMaterialDefinition {
  Name?: IfcLabel;
  Description?: IfcText;
  MaterialConstituents?: IfcMaterialConstituent[];
}

/**
 * IfcProductRepresentation
 * @abstract
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
 * @extends IfcMaterialDefinition
 */
export interface IfcMaterialLayer extends IfcMaterialDefinition {
  Material?: IfcMaterial;
  LayerThickness: number;
  IsVentilated?: IfcLogical;
  Name?: IfcLabel;
  Description?: IfcText;
  Category?: IfcLabel;
  Priority?: IfcInteger;
}

/**
 * IfcMaterialLayerSet
 * @extends IfcMaterialDefinition
 */
export interface IfcMaterialLayerSet extends IfcMaterialDefinition {
  MaterialLayers: IfcMaterialLayer[];
  LayerSetName?: IfcLabel;
  Description?: IfcText;
}

/**
 * IfcMaterialUsageDefinition
 * @abstract
 */
export interface IfcMaterialUsageDefinition {
}

/**
 * IfcMaterialLayerSetUsage
 * @extends IfcMaterialUsageDefinition
 */
export interface IfcMaterialLayerSetUsage extends IfcMaterialUsageDefinition {
  ForLayerSet: IfcMaterialLayerSet;
  LayerSetDirection: IfcLayerSetDirectionEnum;
  DirectionSense: IfcDirectionSenseEnum;
  OffsetFromReferenceLine: number;
  ReferenceExtent?: number;
}

/**
 * IfcMaterialLayerWithOffsets
 * @extends IfcMaterialLayer
 */
export interface IfcMaterialLayerWithOffsets extends IfcMaterialLayer {
  OffsetDirection: IfcLayerSetDirectionEnum;
  OffsetValues: number[];
}

/**
 * IfcMaterialList
 */
export interface IfcMaterialList {
  Materials: IfcMaterial[];
}

/**
 * IfcMaterialProfile
 * @extends IfcMaterialDefinition
 */
export interface IfcMaterialProfile extends IfcMaterialDefinition {
  Name?: IfcLabel;
  Description?: IfcText;
  Material?: IfcMaterial;
  Profile: IfcProfileDef;
  Priority?: IfcInteger;
  Category?: IfcLabel;
}

/**
 * IfcMaterialProfileSet
 * @extends IfcMaterialDefinition
 */
export interface IfcMaterialProfileSet extends IfcMaterialDefinition {
  Name?: IfcLabel;
  Description?: IfcText;
  MaterialProfiles: IfcMaterialProfile[];
  CompositeProfile?: IfcCompositeProfileDef;
}

/**
 * IfcMaterialProfileSetUsage
 * @extends IfcMaterialUsageDefinition
 */
export interface IfcMaterialProfileSetUsage extends IfcMaterialUsageDefinition {
  ForProfileSet: IfcMaterialProfileSet;
  CardinalPoint?: IfcCardinalPointReference;
  ReferenceExtent?: number;
}

/**
 * IfcMaterialProfileSetUsageTapering
 * @extends IfcMaterialProfileSetUsage
 */
export interface IfcMaterialProfileSetUsageTapering extends IfcMaterialProfileSetUsage {
  ForProfileEndSet: IfcMaterialProfileSet;
  CardinalEndPoint?: IfcCardinalPointReference;
}

/**
 * IfcMaterialProfileWithOffsets
 * @extends IfcMaterialProfile
 */
export interface IfcMaterialProfileWithOffsets extends IfcMaterialProfile {
  OffsetValues: number[];
}

/**
 * IfcMaterialProperties
 * @extends IfcExtendedProperties
 */
export interface IfcMaterialProperties extends IfcExtendedProperties {
  Material: IfcMaterialDefinition;
}

/**
 * IfcMaterialRelationship
 * @extends IfcResourceLevelRelationship
 */
export interface IfcMaterialRelationship extends IfcResourceLevelRelationship {
  RelatingMaterial: IfcMaterial;
  RelatedMaterials: IfcMaterial[];
  Expression?: IfcLabel;
}

/**
 * IfcMeasureWithUnit
 */
export interface IfcMeasureWithUnit {
  ValueComponent: IfcValue;
  UnitComponent: IfcUnit;
}

/**
 * IfcMechanicalFastener
 * @extends IfcElementComponent
 */
export interface IfcMechanicalFastener extends IfcElementComponent {
  NominalDiameter?: number;
  NominalLength?: number;
  PredefinedType?: IfcMechanicalFastenerTypeEnum;
}

/**
 * IfcMechanicalFastenerType
 * @extends IfcElementComponentType
 */
export interface IfcMechanicalFastenerType extends IfcElementComponentType {
  PredefinedType: IfcMechanicalFastenerTypeEnum;
  NominalDiameter?: number;
  NominalLength?: number;
}

/**
 * IfcMedicalDevice
 * @extends IfcFlowTerminal
 */
export interface IfcMedicalDevice extends IfcFlowTerminal {
  PredefinedType?: IfcMedicalDeviceTypeEnum;
}

/**
 * IfcMedicalDeviceType
 * @extends IfcFlowTerminalType
 */
export interface IfcMedicalDeviceType extends IfcFlowTerminalType {
  PredefinedType: IfcMedicalDeviceTypeEnum;
}

/**
 * IfcMember
 * @extends IfcBuildingElement
 */
export interface IfcMember extends IfcBuildingElement {
  PredefinedType?: IfcMemberTypeEnum;
}

/**
 * IfcMemberStandardCase
 * @extends IfcMember
 */
export interface IfcMemberStandardCase extends IfcMember {
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
  DataValue?: IfcMetricValueSelect;
  ReferencePath?: IfcReference;
}

/**
 * IfcMirroredProfileDef
 * @extends IfcDerivedProfileDef
 */
export interface IfcMirroredProfileDef extends IfcDerivedProfileDef {
}

/**
 * IfcMonetaryUnit
 */
export interface IfcMonetaryUnit {
  Currency: IfcLabel;
}

/**
 * IfcMotorConnection
 * @extends IfcEnergyConversionDevice
 */
export interface IfcMotorConnection extends IfcEnergyConversionDevice {
  PredefinedType?: IfcMotorConnectionTypeEnum;
}

/**
 * IfcMotorConnectionType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcMotorConnectionType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcMotorConnectionTypeEnum;
}

/**
 * IfcObjective
 * @extends IfcConstraint
 */
export interface IfcObjective extends IfcConstraint {
  BenchmarkValues?: IfcConstraint[];
  LogicalAggregator?: IfcLogicalOperatorEnum;
  ObjectiveQualifier: IfcObjectiveEnum;
  UserDefinedQualifier?: IfcLabel;
}

/**
 * IfcOccupant
 * @extends IfcActor
 */
export interface IfcOccupant extends IfcActor {
  PredefinedType?: IfcOccupantTypeEnum;
}

/**
 * IfcOffsetCurve2D
 * @extends IfcCurve
 */
export interface IfcOffsetCurve2D extends IfcCurve {
  BasisCurve: IfcCurve;
  Distance: number;
  SelfIntersect: IfcLogical;
}

/**
 * IfcOffsetCurve3D
 * @extends IfcCurve
 */
export interface IfcOffsetCurve3D extends IfcCurve {
  BasisCurve: IfcCurve;
  Distance: number;
  SelfIntersect: IfcLogical;
  RefDirection: IfcDirection;
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
  PredefinedType?: IfcOpeningElementTypeEnum;
}

/**
 * IfcOpeningStandardCase
 * @extends IfcOpeningElement
 */
export interface IfcOpeningStandardCase extends IfcOpeningElement {
}

/**
 * IfcOrganization
 */
export interface IfcOrganization {
  Identification?: IfcIdentifier;
  Name: IfcLabel;
  Description?: IfcText;
  Roles?: IfcActorRole[];
  Addresses?: IfcAddress[];
}

/**
 * IfcOrganizationRelationship
 * @extends IfcResourceLevelRelationship
 */
export interface IfcOrganizationRelationship extends IfcResourceLevelRelationship {
  RelatingOrganization: IfcOrganization;
  RelatedOrganizations: IfcOrganization[];
}

/**
 * IfcOrientedEdge
 * @extends IfcEdge
 */
export interface IfcOrientedEdge extends IfcEdge {
  EdgeElement: IfcEdge;
  Orientation: IfcBoolean;
}

/**
 * IfcOuterBoundaryCurve
 * @extends IfcBoundaryCurve
 */
export interface IfcOuterBoundaryCurve extends IfcBoundaryCurve {
}

/**
 * IfcOutlet
 * @extends IfcFlowTerminal
 */
export interface IfcOutlet extends IfcFlowTerminal {
  PredefinedType?: IfcOutletTypeEnum;
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
  ChangeAction?: IfcChangeActionEnum;
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
 * IfcPcurve
 * @extends IfcCurve
 */
export interface IfcPcurve extends IfcCurve {
  BasisSurface: IfcSurface;
  ReferenceCurve: IfcCurve;
}

/**
 * IfcPerformanceHistory
 * @extends IfcControl
 */
export interface IfcPerformanceHistory extends IfcControl {
  LifeCyclePhase: IfcLabel;
  PredefinedType?: IfcPerformanceHistoryTypeEnum;
}

/**
 * IfcPermeableCoveringProperties
 * @extends IfcPreDefinedPropertySet
 */
export interface IfcPermeableCoveringProperties extends IfcPreDefinedPropertySet {
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
  PredefinedType?: IfcPermitTypeEnum;
  Status?: IfcLabel;
  LongDescription?: IfcText;
}

/**
 * IfcPerson
 */
export interface IfcPerson {
  Identification?: IfcIdentifier;
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
  PredefinedType?: IfcPileTypeEnum;
  ConstructionType?: IfcPileConstructionEnum;
}

/**
 * IfcPileType
 * @extends IfcBuildingElementType
 */
export interface IfcPileType extends IfcBuildingElementType {
  PredefinedType: IfcPileTypeEnum;
}

/**
 * IfcPipeFitting
 * @extends IfcFlowFitting
 */
export interface IfcPipeFitting extends IfcFlowFitting {
  PredefinedType?: IfcPipeFittingTypeEnum;
}

/**
 * IfcPipeFittingType
 * @extends IfcFlowFittingType
 */
export interface IfcPipeFittingType extends IfcFlowFittingType {
  PredefinedType: IfcPipeFittingTypeEnum;
}

/**
 * IfcPipeSegment
 * @extends IfcFlowSegment
 */
export interface IfcPipeSegment extends IfcFlowSegment {
  PredefinedType?: IfcPipeSegmentTypeEnum;
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
  Pixel: IfcBinary[];
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
  PredefinedType?: IfcPlateTypeEnum;
}

/**
 * IfcPlateStandardCase
 * @extends IfcPlate
 */
export interface IfcPlateStandardCase extends IfcPlate {
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
 * IfcTessellatedFaceSet
 * @abstract
 * @extends IfcTessellatedItem
 */
export interface IfcTessellatedFaceSet extends IfcTessellatedItem {
  Coordinates: IfcCartesianPointList3D;
}

/**
 * IfcPolygonalFaceSet
 * @extends IfcTessellatedFaceSet
 */
export interface IfcPolygonalFaceSet extends IfcTessellatedFaceSet {
  Closed?: IfcBoolean;
  Faces: IfcIndexedPolygonalFace[];
  PnIndex?: IfcPositiveInteger[];
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
 * IfcPreDefinedProperties
 * @abstract
 * @extends IfcPropertyAbstraction
 */
export interface IfcPreDefinedProperties extends IfcPropertyAbstraction {
}

/**
 * IfcPreDefinedTextFont
 * @abstract
 * @extends IfcPreDefinedItem
 */
export interface IfcPreDefinedTextFont extends IfcPreDefinedItem {
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
  LayerOn: IfcLogical;
  LayerFrozen: IfcLogical;
  LayerBlocked: IfcLogical;
  LayerStyles: IfcPresentationStyle[];
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
  PredefinedType?: IfcProcedureTypeEnum;
}

/**
 * IfcProcedureType
 * @extends IfcTypeProcess
 */
export interface IfcProcedureType extends IfcTypeProcess {
  PredefinedType: IfcProcedureTypeEnum;
}

/**
 * IfcProductDefinitionShape
 * @extends IfcProductRepresentation
 */
export interface IfcProductDefinitionShape extends IfcProductRepresentation {
}

/**
 * IfcProfileProperties
 * @extends IfcExtendedProperties
 */
export interface IfcProfileProperties extends IfcExtendedProperties {
  ProfileDefinition: IfcProfileDef;
}

/**
 * IfcProject
 * @extends IfcContext
 */
export interface IfcProject extends IfcContext {
}

/**
 * IfcProjectLibrary
 * @extends IfcContext
 */
export interface IfcProjectLibrary extends IfcContext {
}

/**
 * IfcProjectOrder
 * @extends IfcControl
 */
export interface IfcProjectOrder extends IfcControl {
  PredefinedType?: IfcProjectOrderTypeEnum;
  Status?: IfcLabel;
  LongDescription?: IfcText;
}

/**
 * IfcProjectedCRS
 * @extends IfcCoordinateReferenceSystem
 */
export interface IfcProjectedCRS extends IfcCoordinateReferenceSystem {
  MapProjection?: IfcIdentifier;
  MapZone?: IfcIdentifier;
  MapUnit?: IfcNamedUnit;
}

/**
 * IfcProjectionElement
 * @extends IfcFeatureElementAddition
 */
export interface IfcProjectionElement extends IfcFeatureElementAddition {
  PredefinedType?: IfcProjectionElementTypeEnum;
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
  SetPointValue?: IfcValue;
}

/**
 * IfcPropertyDependencyRelationship
 * @extends IfcResourceLevelRelationship
 */
export interface IfcPropertyDependencyRelationship extends IfcResourceLevelRelationship {
  DependingProperty: IfcProperty;
  DependantProperty: IfcProperty;
  Expression?: IfcText;
}

/**
 * IfcPropertyEnumeratedValue
 * @extends IfcSimpleProperty
 */
export interface IfcPropertyEnumeratedValue extends IfcSimpleProperty {
  EnumerationValues?: IfcValue[];
  EnumerationReference?: IfcPropertyEnumeration;
}

/**
 * IfcPropertyEnumeration
 * @extends IfcPropertyAbstraction
 */
export interface IfcPropertyEnumeration extends IfcPropertyAbstraction {
  Name: IfcLabel;
  EnumerationValues: IfcValue[];
  Unit?: IfcUnit;
}

/**
 * IfcPropertyListValue
 * @extends IfcSimpleProperty
 */
export interface IfcPropertyListValue extends IfcSimpleProperty {
  ListValues?: IfcValue[];
  Unit?: IfcUnit;
}

/**
 * IfcPropertyReferenceValue
 * @extends IfcSimpleProperty
 */
export interface IfcPropertyReferenceValue extends IfcSimpleProperty {
  UsageName?: IfcText;
  PropertyReference?: IfcObjectReferenceSelect;
}

/**
 * IfcPropertySet
 * @extends IfcPropertySetDefinition
 */
export interface IfcPropertySet extends IfcPropertySetDefinition {
  HasProperties: IfcProperty[];
}

/**
 * IfcPropertySetTemplate
 * @extends IfcPropertyTemplateDefinition
 */
export interface IfcPropertySetTemplate extends IfcPropertyTemplateDefinition {
  TemplateType?: IfcPropertySetTemplateTypeEnum;
  ApplicableEntity?: IfcIdentifier;
  HasPropertyTemplates: IfcPropertyTemplate[];
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
  DefiningValues?: IfcValue[];
  DefinedValues?: IfcValue[];
  Expression?: IfcText;
  DefiningUnit?: IfcUnit;
  DefinedUnit?: IfcUnit;
  CurveInterpolation?: IfcCurveInterpolationEnum;
}

/**
 * IfcProtectiveDevice
 * @extends IfcFlowController
 */
export interface IfcProtectiveDevice extends IfcFlowController {
  PredefinedType?: IfcProtectiveDeviceTypeEnum;
}

/**
 * IfcProtectiveDeviceTrippingUnit
 * @extends IfcDistributionControlElement
 */
export interface IfcProtectiveDeviceTrippingUnit extends IfcDistributionControlElement {
  PredefinedType?: IfcProtectiveDeviceTrippingUnitTypeEnum;
}

/**
 * IfcProtectiveDeviceTrippingUnitType
 * @extends IfcDistributionControlElementType
 */
export interface IfcProtectiveDeviceTrippingUnitType extends IfcDistributionControlElementType {
  PredefinedType: IfcProtectiveDeviceTrippingUnitTypeEnum;
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
 * IfcPump
 * @extends IfcFlowMovingDevice
 */
export interface IfcPump extends IfcFlowMovingDevice {
  PredefinedType?: IfcPumpTypeEnum;
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
  Formula?: IfcLabel;
}

/**
 * IfcQuantityCount
 * @extends IfcPhysicalSimpleQuantity
 */
export interface IfcQuantityCount extends IfcPhysicalSimpleQuantity {
  CountValue: number;
  Formula?: IfcLabel;
}

/**
 * IfcQuantityLength
 * @extends IfcPhysicalSimpleQuantity
 */
export interface IfcQuantityLength extends IfcPhysicalSimpleQuantity {
  LengthValue: number;
  Formula?: IfcLabel;
}

/**
 * IfcQuantityTime
 * @extends IfcPhysicalSimpleQuantity
 */
export interface IfcQuantityTime extends IfcPhysicalSimpleQuantity {
  TimeValue: number;
  Formula?: IfcLabel;
}

/**
 * IfcQuantityVolume
 * @extends IfcPhysicalSimpleQuantity
 */
export interface IfcQuantityVolume extends IfcPhysicalSimpleQuantity {
  VolumeValue: number;
  Formula?: IfcLabel;
}

/**
 * IfcQuantityWeight
 * @extends IfcPhysicalSimpleQuantity
 */
export interface IfcQuantityWeight extends IfcPhysicalSimpleQuantity {
  WeightValue: number;
  Formula?: IfcLabel;
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
  PredefinedType?: IfcRampTypeEnum;
}

/**
 * IfcRampFlight
 * @extends IfcBuildingElement
 */
export interface IfcRampFlight extends IfcBuildingElement {
  PredefinedType?: IfcRampFlightTypeEnum;
}

/**
 * IfcRampFlightType
 * @extends IfcBuildingElementType
 */
export interface IfcRampFlightType extends IfcBuildingElementType {
  PredefinedType: IfcRampFlightTypeEnum;
}

/**
 * IfcRampType
 * @extends IfcBuildingElementType
 */
export interface IfcRampType extends IfcBuildingElementType {
  PredefinedType: IfcRampTypeEnum;
}

/**
 * IfcRationalBSplineCurveWithKnots
 * @extends IfcBSplineCurveWithKnots
 */
export interface IfcRationalBSplineCurveWithKnots extends IfcBSplineCurveWithKnots {
  WeightsData: IfcReal[];
}

/**
 * IfcRationalBSplineSurfaceWithKnots
 * @extends IfcBSplineSurfaceWithKnots
 */
export interface IfcRationalBSplineSurfaceWithKnots extends IfcBSplineSurfaceWithKnots {
  WeightsData: IfcReal[][];
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
  Usense: IfcBoolean;
  Vsense: IfcBoolean;
}

/**
 * IfcRecurrencePattern
 */
export interface IfcRecurrencePattern {
  RecurrenceType: IfcRecurrenceTypeEnum;
  DayComponent?: IfcDayInMonthNumber[];
  WeekdayComponent?: IfcDayInWeekNumber[];
  MonthComponent?: IfcMonthInYearNumber[];
  Position?: IfcInteger;
  Interval?: IfcInteger;
  Occurrences?: IfcInteger;
  TimePeriods?: IfcTimePeriod[];
}

/**
 * IfcReference
 */
export interface IfcReference {
  TypeIdentifier?: IfcIdentifier;
  AttributeIdentifier?: IfcIdentifier;
  InstanceName?: IfcLabel;
  ListPositions?: IfcInteger[];
  InnerReference?: IfcReference;
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
 * @extends IfcPreDefinedProperties
 */
export interface IfcReinforcementBarProperties extends IfcPreDefinedProperties {
  TotalCrossSectionArea: number;
  SteelGrade: IfcLabel;
  BarSurface?: IfcReinforcingBarSurfaceEnum;
  EffectiveDepth?: number;
  NominalBarDiameter?: number;
  BarCount?: number;
}

/**
 * IfcReinforcementDefinitionProperties
 * @extends IfcPreDefinedPropertySet
 */
export interface IfcReinforcementDefinitionProperties extends IfcPreDefinedPropertySet {
  DefinitionType?: IfcLabel;
  ReinforcementSectionDefinitions: IfcSectionReinforcementProperties[];
}

/**
 * IfcReinforcingElement
 * @abstract
 * @extends IfcElementComponent
 */
export interface IfcReinforcingElement extends IfcElementComponent {
  SteelGrade?: IfcLabel;
}

/**
 * IfcReinforcingBar
 * @extends IfcReinforcingElement
 */
export interface IfcReinforcingBar extends IfcReinforcingElement {
  NominalDiameter?: number;
  CrossSectionArea?: number;
  BarLength?: number;
  PredefinedType?: IfcReinforcingBarTypeEnum;
  BarSurface?: IfcReinforcingBarSurfaceEnum;
}

/**
 * IfcReinforcingElementType
 * @abstract
 * @extends IfcElementComponentType
 */
export interface IfcReinforcingElementType extends IfcElementComponentType {
}

/**
 * IfcReinforcingBarType
 * @extends IfcReinforcingElementType
 */
export interface IfcReinforcingBarType extends IfcReinforcingElementType {
  PredefinedType: IfcReinforcingBarTypeEnum;
  NominalDiameter?: number;
  CrossSectionArea?: number;
  BarLength?: number;
  BarSurface?: IfcReinforcingBarSurfaceEnum;
  BendingShapeCode?: IfcLabel;
  BendingParameters?: IfcBendingParameterSelect[];
}

/**
 * IfcReinforcingMesh
 * @extends IfcReinforcingElement
 */
export interface IfcReinforcingMesh extends IfcReinforcingElement {
  MeshLength?: number;
  MeshWidth?: number;
  LongitudinalBarNominalDiameter?: number;
  TransverseBarNominalDiameter?: number;
  LongitudinalBarCrossSectionArea?: number;
  TransverseBarCrossSectionArea?: number;
  LongitudinalBarSpacing?: number;
  TransverseBarSpacing?: number;
  PredefinedType?: IfcReinforcingMeshTypeEnum;
}

/**
 * IfcReinforcingMeshType
 * @extends IfcReinforcingElementType
 */
export interface IfcReinforcingMeshType extends IfcReinforcingElementType {
  PredefinedType: IfcReinforcingMeshTypeEnum;
  MeshLength?: number;
  MeshWidth?: number;
  LongitudinalBarNominalDiameter?: number;
  TransverseBarNominalDiameter?: number;
  LongitudinalBarCrossSectionArea?: number;
  TransverseBarCrossSectionArea?: number;
  LongitudinalBarSpacing?: number;
  TransverseBarSpacing?: number;
  BendingShapeCode?: IfcLabel;
  BendingParameters?: IfcBendingParameterSelect[];
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
}

/**
 * IfcRelAggregates
 * @extends IfcRelDecomposes
 */
export interface IfcRelAggregates extends IfcRelDecomposes {
  RelatingObject: IfcObjectDefinition;
  RelatedObjects: IfcObjectDefinition[];
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
 * IfcRelAssignsToActor
 * @extends IfcRelAssigns
 */
export interface IfcRelAssignsToActor extends IfcRelAssigns {
  RelatingActor: IfcActor;
  ActingRole?: IfcActorRole;
}

/**
 * IfcRelAssignsToControl
 * @extends IfcRelAssigns
 */
export interface IfcRelAssignsToControl extends IfcRelAssigns {
  RelatingControl: IfcControl;
}

/**
 * IfcRelAssignsToGroup
 * @extends IfcRelAssigns
 */
export interface IfcRelAssignsToGroup extends IfcRelAssigns {
  RelatingGroup: IfcGroup;
}

/**
 * IfcRelAssignsToGroupByFactor
 * @extends IfcRelAssignsToGroup
 */
export interface IfcRelAssignsToGroupByFactor extends IfcRelAssignsToGroup {
  Factor: number;
}

/**
 * IfcRelAssignsToProcess
 * @extends IfcRelAssigns
 */
export interface IfcRelAssignsToProcess extends IfcRelAssigns {
  RelatingProcess: IfcProcessSelect;
  QuantityInProcess?: IfcMeasureWithUnit;
}

/**
 * IfcRelAssignsToProduct
 * @extends IfcRelAssigns
 */
export interface IfcRelAssignsToProduct extends IfcRelAssigns {
  RelatingProduct: IfcProductSelect;
}

/**
 * IfcRelAssignsToResource
 * @extends IfcRelAssigns
 */
export interface IfcRelAssignsToResource extends IfcRelAssigns {
  RelatingResource: IfcResourceSelect;
}

/**
 * IfcRelAssociates
 * @abstract
 * @extends IfcRelationship
 */
export interface IfcRelAssociates extends IfcRelationship {
  RelatedObjects: IfcDefinitionSelect[];
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
  RelatingClassification: IfcClassificationSelect;
}

/**
 * IfcRelAssociatesConstraint
 * @extends IfcRelAssociates
 */
export interface IfcRelAssociatesConstraint extends IfcRelAssociates {
  Intent?: IfcLabel;
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
  RelatingPriorities: IfcInteger[];
  RelatedPriorities: IfcInteger[];
  RelatedConnectionType: IfcConnectionTypeEnum;
  RelatingConnectionType: IfcConnectionTypeEnum;
}

/**
 * IfcRelConnectsPortToElement
 * @extends IfcRelConnects
 */
export interface IfcRelConnectsPortToElement extends IfcRelConnects {
  RelatingPort: IfcPort;
  RelatedElement: IfcDistributionElement;
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
  RelatingStructure: IfcSpatialElement;
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
  RelatingSpace: IfcSpace;
  RelatedCoverings: IfcCovering[];
}

/**
 * IfcRelDeclares
 * @extends IfcRelationship
 */
export interface IfcRelDeclares extends IfcRelationship {
  RelatingContext: IfcContext;
  RelatedDefinitions: IfcDefinitionSelect[];
}

/**
 * IfcRelDefines
 * @abstract
 * @extends IfcRelationship
 */
export interface IfcRelDefines extends IfcRelationship {
}

/**
 * IfcRelDefinesByObject
 * @extends IfcRelDefines
 */
export interface IfcRelDefinesByObject extends IfcRelDefines {
  RelatedObjects: IfcObject[];
  RelatingObject: IfcObject;
}

/**
 * IfcRelDefinesByProperties
 * @extends IfcRelDefines
 */
export interface IfcRelDefinesByProperties extends IfcRelDefines {
  RelatedObjects: IfcObjectDefinition[];
  RelatingPropertyDefinition: IfcPropertySetDefinitionSelect;
}

/**
 * IfcRelDefinesByTemplate
 * @extends IfcRelDefines
 */
export interface IfcRelDefinesByTemplate extends IfcRelDefines {
  RelatedPropertySets: IfcPropertySetDefinition[];
  RelatingTemplate: IfcPropertySetTemplate;
}

/**
 * IfcRelDefinesByType
 * @extends IfcRelDefines
 */
export interface IfcRelDefinesByType extends IfcRelDefines {
  RelatedObjects: IfcObject[];
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
 * IfcRelInterferesElements
 * @extends IfcRelConnects
 */
export interface IfcRelInterferesElements extends IfcRelConnects {
  RelatingElement: IfcElement;
  RelatedElement: IfcElement;
  InterferenceGeometry?: IfcConnectionGeometry;
  InterferenceType?: IfcIdentifier;
  ImpliedOrder: boolean | null;
}

/**
 * IfcRelNests
 * @extends IfcRelDecomposes
 */
export interface IfcRelNests extends IfcRelDecomposes {
  RelatingObject: IfcObjectDefinition;
  RelatedObjects: IfcObjectDefinition[];
}

/**
 * IfcRelProjectsElement
 * @extends IfcRelDecomposes
 */
export interface IfcRelProjectsElement extends IfcRelDecomposes {
  RelatingElement: IfcElement;
  RelatedFeatureElement: IfcFeatureElementAddition;
}

/**
 * IfcRelReferencedInSpatialStructure
 * @extends IfcRelConnects
 */
export interface IfcRelReferencedInSpatialStructure extends IfcRelConnects {
  RelatedElements: IfcProduct[];
  RelatingStructure: IfcSpatialElement;
}

/**
 * IfcRelSequence
 * @extends IfcRelConnects
 */
export interface IfcRelSequence extends IfcRelConnects {
  RelatingProcess: IfcProcess;
  RelatedProcess: IfcProcess;
  TimeLag?: IfcLagTime;
  SequenceType?: IfcSequenceEnum;
  UserDefinedSequenceType?: IfcLabel;
}

/**
 * IfcRelServicesBuildings
 * @extends IfcRelConnects
 */
export interface IfcRelServicesBuildings extends IfcRelConnects {
  RelatingSystem: IfcSystem;
  RelatedBuildings: IfcSpatialElement[];
}

/**
 * IfcRelSpaceBoundary
 * @extends IfcRelConnects
 */
export interface IfcRelSpaceBoundary extends IfcRelConnects {
  RelatingSpace: IfcSpaceBoundarySelect;
  RelatedBuildingElement: IfcElement;
  ConnectionGeometry?: IfcConnectionGeometry;
  PhysicalOrVirtualBoundary: IfcPhysicalOrVirtualEnum;
  InternalOrExternalBoundary: IfcInternalOrExternalEnum;
}

/**
 * IfcRelSpaceBoundary1stLevel
 * @extends IfcRelSpaceBoundary
 */
export interface IfcRelSpaceBoundary1stLevel extends IfcRelSpaceBoundary {
  ParentBoundary?: IfcRelSpaceBoundary1stLevel;
}

/**
 * IfcRelSpaceBoundary2ndLevel
 * @extends IfcRelSpaceBoundary1stLevel
 */
export interface IfcRelSpaceBoundary2ndLevel extends IfcRelSpaceBoundary1stLevel {
  CorrespondingBoundary?: IfcRelSpaceBoundary2ndLevel;
}

/**
 * IfcRelVoidsElement
 * @extends IfcRelDecomposes
 */
export interface IfcRelVoidsElement extends IfcRelDecomposes {
  RelatingBuildingElement: IfcElement;
  RelatedOpeningElement: IfcFeatureElementSubtraction;
}

/**
 * IfcReparametrisedCompositeCurveSegment
 * @extends IfcCompositeCurveSegment
 */
export interface IfcReparametrisedCompositeCurveSegment extends IfcCompositeCurveSegment {
  ParamLength: IfcParameterValue;
}

/**
 * IfcRepresentation
 * @abstract
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
 * IfcResourceApprovalRelationship
 * @extends IfcResourceLevelRelationship
 */
export interface IfcResourceApprovalRelationship extends IfcResourceLevelRelationship {
  RelatedResourceObjects: IfcResourceObjectSelect[];
  RelatingApproval: IfcApproval;
}

/**
 * IfcResourceConstraintRelationship
 * @extends IfcResourceLevelRelationship
 */
export interface IfcResourceConstraintRelationship extends IfcResourceLevelRelationship {
  RelatingConstraint: IfcConstraint;
  RelatedResourceObjects: IfcResourceObjectSelect[];
}

/**
 * IfcResourceTime
 * @extends IfcSchedulingTime
 */
export interface IfcResourceTime extends IfcSchedulingTime {
  ScheduleWork?: IfcDuration;
  ScheduleUsage?: number;
  ScheduleStart?: IfcDateTime;
  ScheduleFinish?: IfcDateTime;
  ScheduleContour?: IfcLabel;
  LevelingDelay?: IfcDuration;
  IsOverAllocated?: IfcBoolean;
  StatusTime?: IfcDateTime;
  ActualWork?: IfcDuration;
  ActualUsage?: number;
  ActualStart?: IfcDateTime;
  ActualFinish?: IfcDateTime;
  RemainingWork?: IfcDuration;
  RemainingUsage?: number;
  Completion?: number;
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
 * IfcRevolvedAreaSolidTapered
 * @extends IfcRevolvedAreaSolid
 */
export interface IfcRevolvedAreaSolidTapered extends IfcRevolvedAreaSolid {
  EndSweptArea: IfcProfileDef;
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
  PredefinedType?: IfcRoofTypeEnum;
}

/**
 * IfcRoofType
 * @extends IfcBuildingElementType
 */
export interface IfcRoofType extends IfcBuildingElementType {
  PredefinedType: IfcRoofTypeEnum;
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
 * IfcSanitaryTerminal
 * @extends IfcFlowTerminal
 */
export interface IfcSanitaryTerminal extends IfcFlowTerminal {
  PredefinedType?: IfcSanitaryTerminalTypeEnum;
}

/**
 * IfcSanitaryTerminalType
 * @extends IfcFlowTerminalType
 */
export interface IfcSanitaryTerminalType extends IfcFlowTerminalType {
  PredefinedType: IfcSanitaryTerminalTypeEnum;
}

/**
 * IfcSeamCurve
 * @extends IfcSurfaceCurve
 */
export interface IfcSeamCurve extends IfcSurfaceCurve {
}

/**
 * IfcSectionProperties
 * @extends IfcPreDefinedProperties
 */
export interface IfcSectionProperties extends IfcPreDefinedProperties {
  SectionType: IfcSectionTypeEnum;
  StartProfile: IfcProfileDef;
  EndProfile?: IfcProfileDef;
}

/**
 * IfcSectionReinforcementProperties
 * @extends IfcPreDefinedProperties
 */
export interface IfcSectionReinforcementProperties extends IfcPreDefinedProperties {
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
 * IfcSensor
 * @extends IfcDistributionControlElement
 */
export interface IfcSensor extends IfcDistributionControlElement {
  PredefinedType?: IfcSensorTypeEnum;
}

/**
 * IfcSensorType
 * @extends IfcDistributionControlElementType
 */
export interface IfcSensorType extends IfcDistributionControlElementType {
  PredefinedType: IfcSensorTypeEnum;
}

/**
 * IfcShadingDevice
 * @extends IfcBuildingElement
 */
export interface IfcShadingDevice extends IfcBuildingElement {
  PredefinedType?: IfcShadingDeviceTypeEnum;
}

/**
 * IfcShadingDeviceType
 * @extends IfcBuildingElementType
 */
export interface IfcShadingDeviceType extends IfcBuildingElementType {
  PredefinedType: IfcShadingDeviceTypeEnum;
}

/**
 * IfcShapeAspect
 */
export interface IfcShapeAspect {
  ShapeRepresentations: IfcShapeModel[];
  Name?: IfcLabel;
  Description?: IfcText;
  ProductDefinitional: IfcLogical;
  PartOfProductDefinitionShape?: IfcProductRepresentationSelect;
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
 * IfcSimplePropertyTemplate
 * @extends IfcPropertyTemplate
 */
export interface IfcSimplePropertyTemplate extends IfcPropertyTemplate {
  TemplateType?: IfcSimplePropertyTemplateTypeEnum;
  PrimaryMeasureType?: IfcLabel;
  SecondaryMeasureType?: IfcLabel;
  Enumerators?: IfcPropertyEnumeration;
  PrimaryUnit?: IfcUnit;
  SecondaryUnit?: IfcUnit;
  Expression?: IfcLabel;
  AccessState?: IfcStateEnum;
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
 * IfcSlabElementedCase
 * @extends IfcSlab
 */
export interface IfcSlabElementedCase extends IfcSlab {
}

/**
 * IfcSlabStandardCase
 * @extends IfcSlab
 */
export interface IfcSlabStandardCase extends IfcSlab {
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
 * IfcSolarDevice
 * @extends IfcEnergyConversionDevice
 */
export interface IfcSolarDevice extends IfcEnergyConversionDevice {
  PredefinedType?: IfcSolarDeviceTypeEnum;
}

/**
 * IfcSolarDeviceType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcSolarDeviceType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcSolarDeviceTypeEnum;
}

/**
 * IfcSpace
 * @extends IfcSpatialStructureElement
 */
export interface IfcSpace extends IfcSpatialStructureElement {
  PredefinedType?: IfcSpaceTypeEnum;
  ElevationWithFlooring?: number;
}

/**
 * IfcSpaceHeater
 * @extends IfcFlowTerminal
 */
export interface IfcSpaceHeater extends IfcFlowTerminal {
  PredefinedType?: IfcSpaceHeaterTypeEnum;
}

/**
 * IfcSpaceHeaterType
 * @extends IfcFlowTerminalType
 */
export interface IfcSpaceHeaterType extends IfcFlowTerminalType {
  PredefinedType: IfcSpaceHeaterTypeEnum;
}

/**
 * IfcSpatialElementType
 * @abstract
 * @extends IfcTypeProduct
 */
export interface IfcSpatialElementType extends IfcTypeProduct {
  ElementType?: IfcLabel;
}

/**
 * IfcSpatialStructureElementType
 * @abstract
 * @extends IfcSpatialElementType
 */
export interface IfcSpatialStructureElementType extends IfcSpatialElementType {
}

/**
 * IfcSpaceType
 * @extends IfcSpatialStructureElementType
 */
export interface IfcSpaceType extends IfcSpatialStructureElementType {
  PredefinedType: IfcSpaceTypeEnum;
  LongName?: IfcLabel;
}

/**
 * IfcSpatialZone
 * @extends IfcSpatialElement
 */
export interface IfcSpatialZone extends IfcSpatialElement {
  PredefinedType?: IfcSpatialZoneTypeEnum;
}

/**
 * IfcSpatialZoneType
 * @extends IfcSpatialElementType
 */
export interface IfcSpatialZoneType extends IfcSpatialElementType {
  PredefinedType: IfcSpatialZoneTypeEnum;
  LongName?: IfcLabel;
}

/**
 * IfcSphere
 * @extends IfcCsgPrimitive3D
 */
export interface IfcSphere extends IfcCsgPrimitive3D {
  Radius: number;
}

/**
 * IfcSphericalSurface
 * @extends IfcElementarySurface
 */
export interface IfcSphericalSurface extends IfcElementarySurface {
  Radius: number;
}

/**
 * IfcStackTerminal
 * @extends IfcFlowTerminal
 */
export interface IfcStackTerminal extends IfcFlowTerminal {
  PredefinedType?: IfcStackTerminalTypeEnum;
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
  PredefinedType?: IfcStairTypeEnum;
}

/**
 * IfcStairFlight
 * @extends IfcBuildingElement
 */
export interface IfcStairFlight extends IfcBuildingElement {
  NumberOfRisers?: IfcInteger;
  NumberOfTreads?: IfcInteger;
  RiserHeight?: number;
  TreadLength?: number;
  PredefinedType?: IfcStairFlightTypeEnum;
}

/**
 * IfcStairFlightType
 * @extends IfcBuildingElementType
 */
export interface IfcStairFlightType extends IfcBuildingElementType {
  PredefinedType: IfcStairFlightTypeEnum;
}

/**
 * IfcStairType
 * @extends IfcBuildingElementType
 */
export interface IfcStairType extends IfcBuildingElementType {
  PredefinedType: IfcStairTypeEnum;
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
  DestabilizingLoad?: IfcBoolean;
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
  SharedPlacement?: IfcObjectPlacement;
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
 * IfcStructuralCurveAction
 * @extends IfcStructuralAction
 */
export interface IfcStructuralCurveAction extends IfcStructuralAction {
  ProjectedOrTrue?: IfcProjectedOrTrueLengthEnum;
  PredefinedType: IfcStructuralCurveActivityTypeEnum;
}

/**
 * IfcStructuralCurveConnection
 * @extends IfcStructuralConnection
 */
export interface IfcStructuralCurveConnection extends IfcStructuralConnection {
  Axis: IfcDirection;
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
  PredefinedType: IfcStructuralCurveMemberTypeEnum;
  Axis: IfcDirection;
}

/**
 * IfcStructuralCurveMemberVarying
 * @extends IfcStructuralCurveMember
 */
export interface IfcStructuralCurveMemberVarying extends IfcStructuralCurveMember {
}

/**
 * IfcStructuralReaction
 * @abstract
 * @extends IfcStructuralActivity
 */
export interface IfcStructuralReaction extends IfcStructuralActivity {
}

/**
 * IfcStructuralCurveReaction
 * @extends IfcStructuralReaction
 */
export interface IfcStructuralCurveReaction extends IfcStructuralReaction {
  PredefinedType: IfcStructuralCurveActivityTypeEnum;
}

/**
 * IfcStructuralLinearAction
 * @extends IfcStructuralCurveAction
 */
export interface IfcStructuralLinearAction extends IfcStructuralCurveAction {
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
 * IfcStructuralLoadCase
 * @extends IfcStructuralLoadGroup
 */
export interface IfcStructuralLoadCase extends IfcStructuralLoadGroup {
  SelfWeightCoefficients?: number[];
}

/**
 * IfcStructuralLoadConfiguration
 * @extends IfcStructuralLoad
 */
export interface IfcStructuralLoadConfiguration extends IfcStructuralLoad {
  Values: IfcStructuralLoadOrResult[];
  Locations?: IfcLengthMeasure[][];
}

/**
 * IfcStructuralLoadOrResult
 * @abstract
 * @extends IfcStructuralLoad
 */
export interface IfcStructuralLoadOrResult extends IfcStructuralLoad {
}

/**
 * IfcStructuralLoadStatic
 * @abstract
 * @extends IfcStructuralLoadOrResult
 */
export interface IfcStructuralLoadStatic extends IfcStructuralLoadOrResult {
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
  DeltaTConstant?: number;
  DeltaTY?: number;
  DeltaTZ?: number;
}

/**
 * IfcStructuralSurfaceAction
 * @extends IfcStructuralAction
 */
export interface IfcStructuralSurfaceAction extends IfcStructuralAction {
  ProjectedOrTrue?: IfcProjectedOrTrueLengthEnum;
  PredefinedType: IfcStructuralSurfaceActivityTypeEnum;
}

/**
 * IfcStructuralPlanarAction
 * @extends IfcStructuralSurfaceAction
 */
export interface IfcStructuralPlanarAction extends IfcStructuralSurfaceAction {
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
  ConditionCoordinateSystem?: IfcAxis2Placement3D;
}

/**
 * IfcStructuralPointReaction
 * @extends IfcStructuralReaction
 */
export interface IfcStructuralPointReaction extends IfcStructuralReaction {
}

/**
 * IfcStructuralResultGroup
 * @extends IfcGroup
 */
export interface IfcStructuralResultGroup extends IfcGroup {
  TheoryType: IfcAnalysisTheoryTypeEnum;
  ResultForLoadGroup?: IfcStructuralLoadGroup;
  IsLinear: IfcBoolean;
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
  PredefinedType: IfcStructuralSurfaceMemberTypeEnum;
  Thickness?: number;
}

/**
 * IfcStructuralSurfaceMemberVarying
 * @extends IfcStructuralSurfaceMember
 */
export interface IfcStructuralSurfaceMemberVarying extends IfcStructuralSurfaceMember {
}

/**
 * IfcStructuralSurfaceReaction
 * @extends IfcStructuralReaction
 */
export interface IfcStructuralSurfaceReaction extends IfcStructuralReaction {
  PredefinedType: IfcStructuralSurfaceActivityTypeEnum;
}

/**
 * IfcStyleModel
 * @abstract
 * @extends IfcRepresentation
 */
export interface IfcStyleModel extends IfcRepresentation {
}

/**
 * IfcStyledItem
 * @extends IfcRepresentationItem
 */
export interface IfcStyledItem extends IfcRepresentationItem {
  Item?: IfcRepresentationItem;
  Styles: IfcStyleAssignmentSelect[];
  Name?: IfcLabel;
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
  PredefinedType?: IfcSubContractResourceTypeEnum;
}

/**
 * IfcSubContractResourceType
 * @extends IfcConstructionResourceType
 */
export interface IfcSubContractResourceType extends IfcConstructionResourceType {
  PredefinedType: IfcSubContractResourceTypeEnum;
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
  StartParam?: IfcParameterValue;
  EndParam?: IfcParameterValue;
  ReferenceSurface: IfcSurface;
}

/**
 * IfcSurfaceFeature
 * @extends IfcFeatureElement
 */
export interface IfcSurfaceFeature extends IfcFeatureElement {
  PredefinedType?: IfcSurfaceFeatureTypeEnum;
}

/**
 * IfcSweptSurface
 * @abstract
 * @extends IfcSurface
 */
export interface IfcSweptSurface extends IfcSurface {
  SweptCurve: IfcProfileDef;
  Position?: IfcAxis2Placement3D;
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
 * IfcSurfaceReinforcementArea
 * @extends IfcStructuralLoadOrResult
 */
export interface IfcSurfaceReinforcementArea extends IfcStructuralLoadOrResult {
  SurfaceReinforcement1?: number[];
  SurfaceReinforcement2?: number[];
  ShearReinforcement?: number;
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
 * @extends IfcPresentationItem
 */
export interface IfcSurfaceStyleLighting extends IfcPresentationItem {
  DiffuseTransmissionColour: IfcColourRgb;
  DiffuseReflectionColour: IfcColourRgb;
  TransmissionColour: IfcColourRgb;
  ReflectanceColour: IfcColourRgb;
}

/**
 * IfcSurfaceStyleRefraction
 * @extends IfcPresentationItem
 */
export interface IfcSurfaceStyleRefraction extends IfcPresentationItem {
  RefractionIndex?: IfcReal;
  DispersionFactor?: IfcReal;
}

/**
 * IfcSurfaceStyleShading
 * @extends IfcPresentationItem
 */
export interface IfcSurfaceStyleShading extends IfcPresentationItem {
  SurfaceColour: IfcColourRgb;
  Transparency?: number;
}

/**
 * IfcSurfaceStyleRendering
 * @extends IfcSurfaceStyleShading
 */
export interface IfcSurfaceStyleRendering extends IfcSurfaceStyleShading {
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
 * @extends IfcPresentationItem
 */
export interface IfcSurfaceStyleWithTextures extends IfcPresentationItem {
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
  StartParam?: IfcParameterValue;
  EndParam?: IfcParameterValue;
}

/**
 * IfcSweptDiskSolidPolygonal
 * @extends IfcSweptDiskSolid
 */
export interface IfcSweptDiskSolidPolygonal extends IfcSweptDiskSolid {
  FilletRadius?: number;
}

/**
 * IfcSwitchingDevice
 * @extends IfcFlowController
 */
export interface IfcSwitchingDevice extends IfcFlowController {
  PredefinedType?: IfcSwitchingDeviceTypeEnum;
}

/**
 * IfcSwitchingDeviceType
 * @extends IfcFlowControllerType
 */
export interface IfcSwitchingDeviceType extends IfcFlowControllerType {
  PredefinedType: IfcSwitchingDeviceTypeEnum;
}

/**
 * IfcSystemFurnitureElement
 * @extends IfcFurnishingElement
 */
export interface IfcSystemFurnitureElement extends IfcFurnishingElement {
  PredefinedType?: IfcSystemFurnitureElementTypeEnum;
}

/**
 * IfcSystemFurnitureElementType
 * @extends IfcFurnishingElementType
 */
export interface IfcSystemFurnitureElementType extends IfcFurnishingElementType {
  PredefinedType?: IfcSystemFurnitureElementTypeEnum;
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
}

/**
 * IfcTable
 */
export interface IfcTable {
  Name?: IfcLabel;
  Rows?: IfcTableRow[];
  Columns?: IfcTableColumn[];
}

/**
 * IfcTableColumn
 */
export interface IfcTableColumn {
  Identifier?: IfcIdentifier;
  Name?: IfcLabel;
  Description?: IfcText;
  Unit?: IfcUnit;
  ReferencePath?: IfcReference;
}

/**
 * IfcTableRow
 */
export interface IfcTableRow {
  RowCells?: IfcValue[];
  IsHeading?: IfcBoolean;
}

/**
 * IfcTank
 * @extends IfcFlowStorageDevice
 */
export interface IfcTank extends IfcFlowStorageDevice {
  PredefinedType?: IfcTankTypeEnum;
}

/**
 * IfcTankType
 * @extends IfcFlowStorageDeviceType
 */
export interface IfcTankType extends IfcFlowStorageDeviceType {
  PredefinedType: IfcTankTypeEnum;
}

/**
 * IfcTask
 * @extends IfcProcess
 */
export interface IfcTask extends IfcProcess {
  Status?: IfcLabel;
  WorkMethod?: IfcLabel;
  IsMilestone: IfcBoolean;
  Priority?: IfcInteger;
  TaskTime?: IfcTaskTime;
  PredefinedType?: IfcTaskTypeEnum;
}

/**
 * IfcTaskTime
 * @extends IfcSchedulingTime
 */
export interface IfcTaskTime extends IfcSchedulingTime {
  DurationType?: IfcTaskDurationEnum;
  ScheduleDuration?: IfcDuration;
  ScheduleStart?: IfcDateTime;
  ScheduleFinish?: IfcDateTime;
  EarlyStart?: IfcDateTime;
  EarlyFinish?: IfcDateTime;
  LateStart?: IfcDateTime;
  LateFinish?: IfcDateTime;
  FreeFloat?: IfcDuration;
  TotalFloat?: IfcDuration;
  IsCritical?: IfcBoolean;
  StatusTime?: IfcDateTime;
  ActualDuration?: IfcDuration;
  ActualStart?: IfcDateTime;
  ActualFinish?: IfcDateTime;
  RemainingTime?: IfcDuration;
  Completion?: number;
}

/**
 * IfcTaskTimeRecurring
 * @extends IfcTaskTime
 */
export interface IfcTaskTimeRecurring extends IfcTaskTime {
  Recurrence: IfcRecurrencePattern;
}

/**
 * IfcTaskType
 * @extends IfcTypeProcess
 */
export interface IfcTaskType extends IfcTypeProcess {
  PredefinedType: IfcTaskTypeEnum;
  WorkMethod?: IfcLabel;
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
  WWWHomePageURL?: IfcURIReference;
  MessagingIDs?: IfcURIReference[];
}

/**
 * IfcTendon
 * @extends IfcReinforcingElement
 */
export interface IfcTendon extends IfcReinforcingElement {
  PredefinedType?: IfcTendonTypeEnum;
  NominalDiameter?: number;
  CrossSectionArea?: number;
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
  PredefinedType?: IfcTendonAnchorTypeEnum;
}

/**
 * IfcTendonAnchorType
 * @extends IfcReinforcingElementType
 */
export interface IfcTendonAnchorType extends IfcReinforcingElementType {
  PredefinedType: IfcTendonAnchorTypeEnum;
}

/**
 * IfcTendonType
 * @extends IfcReinforcingElementType
 */
export interface IfcTendonType extends IfcReinforcingElementType {
  PredefinedType: IfcTendonTypeEnum;
  NominalDiameter?: number;
  CrossSectionArea?: number;
  SheathDiameter?: number;
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
  TextCharacterAppearance?: IfcTextStyleForDefinedFont;
  TextStyle?: IfcTextStyleTextModel;
  TextFontStyle: IfcTextFontSelect;
  ModelOrDraughting?: IfcBoolean;
}

/**
 * IfcTextStyleFontModel
 * @extends IfcPreDefinedTextFont
 */
export interface IfcTextStyleFontModel extends IfcPreDefinedTextFont {
  FontFamily: IfcTextFontName[];
  FontStyle?: IfcFontStyle;
  FontVariant?: IfcFontVariant;
  FontWeight?: IfcFontWeight;
  FontSize: IfcSizeSelect;
}

/**
 * IfcTextStyleForDefinedFont
 * @extends IfcPresentationItem
 */
export interface IfcTextStyleForDefinedFont extends IfcPresentationItem {
  Colour: IfcColour;
  BackgroundColour?: IfcColour;
}

/**
 * IfcTextStyleTextModel
 * @extends IfcPresentationItem
 */
export interface IfcTextStyleTextModel extends IfcPresentationItem {
  TextIndent?: IfcSizeSelect;
  TextAlign?: IfcTextAlignment;
  TextDecoration?: IfcTextDecoration;
  LetterSpacing?: IfcSizeSelect;
  WordSpacing?: IfcSizeSelect;
  TextTransform?: IfcTextTransformation;
  LineHeight?: IfcSizeSelect;
}

/**
 * IfcTextureCoordinateGenerator
 * @extends IfcTextureCoordinate
 */
export interface IfcTextureCoordinateGenerator extends IfcTextureCoordinate {
  Mode: IfcLabel;
  Parameter?: IfcReal[];
}

/**
 * IfcTextureMap
 * @extends IfcTextureCoordinate
 */
export interface IfcTextureMap extends IfcTextureCoordinate {
  Vertices: IfcTextureVertex[];
  MappedTo: IfcFace;
}

/**
 * IfcTextureVertex
 * @extends IfcPresentationItem
 */
export interface IfcTextureVertex extends IfcPresentationItem {
  Coordinates: IfcParameterValue[];
}

/**
 * IfcTextureVertexList
 * @extends IfcPresentationItem
 */
export interface IfcTextureVertexList extends IfcPresentationItem {
  TexCoordsList: IfcParameterValue[][];
}

/**
 * IfcTimePeriod
 */
export interface IfcTimePeriod {
  StartTime: IfcTime;
  EndTime: IfcTime;
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
 * IfcToroidalSurface
 * @extends IfcElementarySurface
 */
export interface IfcToroidalSurface extends IfcElementarySurface {
  MajorRadius: number;
  MinorRadius: number;
}

/**
 * IfcTransformer
 * @extends IfcEnergyConversionDevice
 */
export interface IfcTransformer extends IfcEnergyConversionDevice {
  PredefinedType?: IfcTransformerTypeEnum;
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
  PredefinedType?: IfcTransportElementTypeEnum;
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
 * IfcTriangulatedFaceSet
 * @extends IfcTessellatedFaceSet
 */
export interface IfcTriangulatedFaceSet extends IfcTessellatedFaceSet {
  Normals?: IfcParameterValue[][];
  Closed?: IfcBoolean;
  CoordIndex: IfcPositiveInteger[][];
  PnIndex?: IfcPositiveInteger[];
}

/**
 * IfcTrimmedCurve
 * @extends IfcBoundedCurve
 */
export interface IfcTrimmedCurve extends IfcBoundedCurve {
  BasisCurve: IfcCurve;
  Trim1: IfcTrimmingSelect[];
  Trim2: IfcTrimmingSelect[];
  SenseAgreement: IfcBoolean;
  MasterRepresentation: IfcTrimmingPreference;
}

/**
 * IfcTubeBundle
 * @extends IfcEnergyConversionDevice
 */
export interface IfcTubeBundle extends IfcEnergyConversionDevice {
  PredefinedType?: IfcTubeBundleTypeEnum;
}

/**
 * IfcTubeBundleType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcTubeBundleType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcTubeBundleTypeEnum;
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
}

/**
 * IfcUnitAssignment
 */
export interface IfcUnitAssignment {
  Units: IfcUnit[];
}

/**
 * IfcUnitaryControlElement
 * @extends IfcDistributionControlElement
 */
export interface IfcUnitaryControlElement extends IfcDistributionControlElement {
  PredefinedType?: IfcUnitaryControlElementTypeEnum;
}

/**
 * IfcUnitaryControlElementType
 * @extends IfcDistributionControlElementType
 */
export interface IfcUnitaryControlElementType extends IfcDistributionControlElementType {
  PredefinedType: IfcUnitaryControlElementTypeEnum;
}

/**
 * IfcUnitaryEquipment
 * @extends IfcEnergyConversionDevice
 */
export interface IfcUnitaryEquipment extends IfcEnergyConversionDevice {
  PredefinedType?: IfcUnitaryEquipmentTypeEnum;
}

/**
 * IfcUnitaryEquipmentType
 * @extends IfcEnergyConversionDeviceType
 */
export interface IfcUnitaryEquipmentType extends IfcEnergyConversionDeviceType {
  PredefinedType: IfcUnitaryEquipmentTypeEnum;
}

/**
 * IfcValve
 * @extends IfcFlowController
 */
export interface IfcValve extends IfcFlowController {
  PredefinedType?: IfcValveTypeEnum;
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
 * IfcVibrationIsolator
 * @extends IfcElementComponent
 */
export interface IfcVibrationIsolator extends IfcElementComponent {
  PredefinedType?: IfcVibrationIsolatorTypeEnum;
}

/**
 * IfcVibrationIsolatorType
 * @extends IfcElementComponentType
 */
export interface IfcVibrationIsolatorType extends IfcElementComponentType {
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
 * IfcVoidingFeature
 * @extends IfcFeatureElementSubtraction
 */
export interface IfcVoidingFeature extends IfcFeatureElementSubtraction {
  PredefinedType?: IfcVoidingFeatureTypeEnum;
}

/**
 * IfcWall
 * @extends IfcBuildingElement
 */
export interface IfcWall extends IfcBuildingElement {
  PredefinedType?: IfcWallTypeEnum;
}

/**
 * IfcWallElementedCase
 * @extends IfcWall
 */
export interface IfcWallElementedCase extends IfcWall {
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
 * IfcWasteTerminal
 * @extends IfcFlowTerminal
 */
export interface IfcWasteTerminal extends IfcFlowTerminal {
  PredefinedType?: IfcWasteTerminalTypeEnum;
}

/**
 * IfcWasteTerminalType
 * @extends IfcFlowTerminalType
 */
export interface IfcWasteTerminalType extends IfcFlowTerminalType {
  PredefinedType: IfcWasteTerminalTypeEnum;
}

/**
 * IfcWindow
 * @extends IfcBuildingElement
 */
export interface IfcWindow extends IfcBuildingElement {
  OverallHeight?: number;
  OverallWidth?: number;
  PredefinedType?: IfcWindowTypeEnum;
  PartitioningType?: IfcWindowTypePartitioningEnum;
  UserDefinedPartitioningType?: IfcLabel;
}

/**
 * IfcWindowLiningProperties
 * @extends IfcPreDefinedPropertySet
 */
export interface IfcWindowLiningProperties extends IfcPreDefinedPropertySet {
  LiningDepth?: number;
  LiningThickness?: number;
  TransomThickness?: number;
  MullionThickness?: number;
  FirstTransomOffset?: number;
  SecondTransomOffset?: number;
  FirstMullionOffset?: number;
  SecondMullionOffset?: number;
  ShapeAspectStyle?: IfcShapeAspect;
  LiningOffset?: number;
  LiningToPanelOffsetX?: number;
  LiningToPanelOffsetY?: number;
}

/**
 * IfcWindowPanelProperties
 * @extends IfcPreDefinedPropertySet
 */
export interface IfcWindowPanelProperties extends IfcPreDefinedPropertySet {
  OperationType: IfcWindowPanelOperationEnum;
  PanelPosition: IfcWindowPanelPositionEnum;
  FrameDepth?: number;
  FrameThickness?: number;
  ShapeAspectStyle?: IfcShapeAspect;
}

/**
 * IfcWindowStandardCase
 * @extends IfcWindow
 */
export interface IfcWindowStandardCase extends IfcWindow {
}

/**
 * IfcWindowStyle
 * @extends IfcTypeProduct
 */
export interface IfcWindowStyle extends IfcTypeProduct {
  ConstructionType: IfcWindowStyleConstructionEnum;
  OperationType: IfcWindowStyleOperationEnum;
  ParameterTakesPrecedence: IfcBoolean;
  Sizeable: IfcBoolean;
}

/**
 * IfcWindowType
 * @extends IfcBuildingElementType
 */
export interface IfcWindowType extends IfcBuildingElementType {
  PredefinedType: IfcWindowTypeEnum;
  PartitioningType: IfcWindowTypePartitioningEnum;
  ParameterTakesPrecedence?: IfcBoolean;
  UserDefinedPartitioningType?: IfcLabel;
}

/**
 * IfcWorkCalendar
 * @extends IfcControl
 */
export interface IfcWorkCalendar extends IfcControl {
  WorkingTimes?: IfcWorkTime[];
  ExceptionTimes?: IfcWorkTime[];
  PredefinedType?: IfcWorkCalendarTypeEnum;
}

/**
 * IfcWorkControl
 * @abstract
 * @extends IfcControl
 */
export interface IfcWorkControl extends IfcControl {
  CreationDate: IfcDateTime;
  Creators?: IfcPerson[];
  Purpose?: IfcLabel;
  Duration?: IfcDuration;
  TotalFloat?: IfcDuration;
  StartTime: IfcDateTime;
  FinishTime?: IfcDateTime;
}

/**
 * IfcWorkPlan
 * @extends IfcWorkControl
 */
export interface IfcWorkPlan extends IfcWorkControl {
  PredefinedType?: IfcWorkPlanTypeEnum;
}

/**
 * IfcWorkSchedule
 * @extends IfcWorkControl
 */
export interface IfcWorkSchedule extends IfcWorkControl {
  PredefinedType?: IfcWorkScheduleTypeEnum;
}

/**
 * IfcWorkTime
 * @extends IfcSchedulingTime
 */
export interface IfcWorkTime extends IfcSchedulingTime {
  RecurrencePattern?: IfcRecurrencePattern;
  Start?: IfcDate;
  Finish?: IfcDate;
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
 * @extends IfcSystem
 */
export interface IfcZone extends IfcSystem {
  LongName?: IfcLabel;
}
