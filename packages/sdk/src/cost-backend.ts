/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  evaluateCostItem, evaluateCostValue, extractCostOnDemand,
  type CostAppliedValue, type CostDiagnostic, type CostEvaluationResult,
  type CostGraphExtraction, type CostRelationshipInfo, type IfcDataStore,
} from '@ifc-lite/parser';
import type { EntityRef } from './types.js';
import type {
  CostAppliedValueData, CostBackendMethods, CostDiagnosticData, CostEvaluationData,
  CostEvaluationOptions,
  CostGraphData, CostRelationshipData,
} from './cost-types.js';

export interface ResolvedCostModel { modelId: string; store: IfcDataStore }
export type CostModelResolver = (modelId?: string) => ResolvedCostModel;

function ref(modelId: string, expressId: number): EntityRef { return { modelId, expressId }; }
function refs(modelId: string, ids: number[]): EntityRef[] { return ids.map(expressId => ref(modelId, expressId)); }

function projectDiagnostic(modelId: string, value: CostDiagnostic): CostDiagnosticData {
  return {
    Code: value.Code, Message: value.Message, Severity: value.Severity,
    ...(value.expressId === undefined ? {} : { ref: ref(modelId, value.expressId) }),
    ...(value.RelatedExpressId === undefined ? {} : { RelatedRef: ref(modelId, value.RelatedExpressId) }),
  };
}

function projectApplied(modelId: string, value: CostAppliedValue): CostAppliedValueData {
  if (value.Kind === 'Reference') return { Kind: value.Kind, ref: ref(modelId, value.expressId) };
  if (value.Kind === 'Typed') return { Kind: value.Kind, Type: value.Type, Value: value.Value };
  return { Kind: value.Kind, Raw: structuredClone(value.Raw), ...(value.InvalidNumber === undefined ? {} : { InvalidNumber: value.InvalidNumber }) };
}

function projectRelationship(modelId: string, value: CostRelationshipInfo): CostRelationshipData {
  const scalar = (id: number | undefined) => id === undefined ? undefined : ref(modelId, id);
  const list = (ids: number[] | undefined) => ids === undefined ? undefined : refs(modelId, ids);
  return {
    ref: ref(modelId, value.expressId), Type: value.Type,
    ...(value.GlobalId === undefined ? {} : { GlobalId: value.GlobalId }),
    ...(value.Name === undefined ? {} : { Name: value.Name }),
    ...(value.Description === undefined ? {} : { Description: value.Description }),
    ...(list(value.RelatedObjects) === undefined ? {} : { RelatedObjects: list(value.RelatedObjects) }),
    ...(value.InvalidRelatedObjects === undefined ? {} : { InvalidRelatedObjects: value.InvalidRelatedObjects }),
    ...(value.InvalidReferences === undefined ? {} : { InvalidReferences: value.InvalidReferences }),
    ...(list(value.RelatedDefinitions) === undefined ? {} : { RelatedDefinitions: list(value.RelatedDefinitions) }),
    ...(scalar(value.RelatingControl) === undefined ? {} : { RelatingControl: scalar(value.RelatingControl) }),
    ...(scalar(value.RelatingObject) === undefined ? {} : { RelatingObject: scalar(value.RelatingObject) }),
    ...(scalar(value.RelatingProduct) === undefined ? {} : { RelatingProduct: scalar(value.RelatingProduct) }),
    ...(scalar(value.RelatingProcess) === undefined ? {} : { RelatingProcess: scalar(value.RelatingProcess) }),
    ...(scalar(value.RelatingContext) === undefined ? {} : { RelatingContext: scalar(value.RelatingContext) }),
    ...(scalar(value.RelatingAppliedValue) === undefined ? {} : { RelatingAppliedValue: scalar(value.RelatingAppliedValue) }),
    ...(scalar(value.ComponentOfTotal) === undefined ? {} : { ComponentOfTotal: scalar(value.ComponentOfTotal) }),
    ...(list(value.Components) === undefined ? {} : { Components: list(value.Components) }),
    ...(value.ArithmeticOperator === undefined ? {} : { ArithmeticOperator: value.ArithmeticOperator }),
  };
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function projectCostGraph(modelId: string, graph: CostGraphExtraction): CostGraphData {
  const graphRef = (id: number) => ref(modelId, id);
  const valueRef = (id: number | undefined): EntityRef => {
    if (id === undefined) throw new Error('Cost graph contains a value without an expressId');
    return graphRef(id);
  };
  return {
    modelId, source: 'loaded-source', SchemaVersion: graph.SchemaVersion,
    CostSchedules: graph.CostSchedules.map(value => defined({
      ref: graphRef(value.expressId), GlobalId: value.GlobalId, Name: value.Name,
      Description: value.Description, ObjectType: value.ObjectType,
      Identification: value.Identification, PredefinedType: value.PredefinedType,
      Status: value.Status, SubmittedOn: value.SubmittedOn, UpdateDate: value.UpdateDate, ID: value.ID,
    })),
    CostItems: graph.CostItems.map(value => defined({
      ref: graphRef(value.expressId), GlobalId: value.GlobalId, Name: value.Name,
      Description: value.Description, ObjectType: value.ObjectType,
      Identification: value.Identification, PredefinedType: value.PredefinedType,
      CostValues: value.CostValues?.map(graphRef), CostQuantities: value.CostQuantities?.map(graphRef),
    })),
    CostValues: graph.CostValues.map(value => defined({
      ref: valueRef(value.expressId), Type: value.Type, Name: value.Name,
      Description: value.Description, AppliedValue: value.AppliedValue && projectApplied(modelId, value.AppliedValue),
      UnitBasis: value.UnitBasis === undefined ? undefined : graphRef(value.UnitBasis),
      InvalidUnitBasis: value.InvalidUnitBasis, ApplicableDate: value.ApplicableDate,
      FixedUntilDate: value.FixedUntilDate, Category: value.Category, Condition: value.Condition,
      InvalidCondition: value.InvalidCondition, ArithmeticOperator: value.ArithmeticOperator,
      Components: value.Components?.map(graphRef), CostType: value.CostType,
    })),
    CostQuantities: graph.CostQuantities.map(value => defined({
      ref: graphRef(value.expressId), Type: value.Type, Name: value.Name,
      Description: value.Description, Unit: value.Unit === undefined ? undefined : graphRef(value.Unit),
      InvalidUnit: value.InvalidUnit, LengthValue: value.LengthValue, AreaValue: value.AreaValue,
      VolumeValue: value.VolumeValue, CountValue: value.CountValue, WeightValue: value.WeightValue,
      TimeValue: value.TimeValue, NumberValue: value.NumberValue, Formula: value.Formula,
      Dimension: value.Dimension, HasQuantities: value.HasQuantities?.map(graphRef),
      InvalidHasQuantities: value.InvalidHasQuantities,
    })),
    Units: graph.Units.map(value => defined({
      ref: graphRef(value.expressId), Type: value.Type, UnitType: value.UnitType,
      Prefix: value.Prefix, Name: value.Name, Symbol: value.Symbol, Currency: value.Currency,
      Dimension: value.Dimension, Scale: value.Scale,
    })),
    MeasuresWithUnit: graph.MeasuresWithUnit.map(value => defined({
      ref: graphRef(value.expressId), ValueComponent: value.ValueComponent,
      UnitComponent: graphRef(value.UnitComponent), ValueType: value.ValueType,
      ValueDimension: value.ValueDimension,
    })),
    ProjectUnits: Object.fromEntries(Object.entries(graph.ProjectUnits).map(([key, id]) => [key, graphRef(id)])),
    Relationships: graph.Relationships.map(value => projectRelationship(modelId, value)),
    Diagnostics: graph.Diagnostics.map(value => projectDiagnostic(modelId, value)),
    HasCostData: graph.HasCostData,
    ...(graph.Currency === undefined ? {} : { Currency: graph.Currency }),
  };
}

function projectEvaluation(modelId: string, value: CostEvaluationResult): CostEvaluationData {
  return defined({
    ref: ref(modelId, value.expressId), Amount: value.Amount, Currency: value.Currency,
    Dimension: value.Dimension, QuantityApplied: value.QuantityApplied,
    Diagnostics: value.Diagnostics.map(item => projectDiagnostic(modelId, item)),
  });
}

function validateEvaluationTarget(target: EntityRef): void {
  if (!target || typeof target.modelId !== 'string' || target.modelId.length === 0) {
    throw new Error('bim.cost evaluation requires a model-qualified EntityRef');
  }
  if (!Number.isSafeInteger(target.expressId) || target.expressId < 0) {
    throw new Error('bim.cost evaluation requires a non-negative safe integer expressId');
  }
}

function validateEvaluationOptions(options: CostEvaluationOptions | undefined): void {
  if (options?.Precision !== undefined
    && (!Number.isInteger(options.Precision) || options.Precision < 1 || options.Precision > 10_000)) {
    throw new Error('bim.cost evaluation Precision must be an integer from 1 through 10000');
  }
}

export function createCostBackend(resolveModel: CostModelResolver): CostBackendMethods {
  const cache = new WeakMap<IfcDataStore, {
    source: IfcDataStore['source']; schemaVersion: IfcDataStore['schemaVersion'];
    entityIndex: IfcDataStore['entityIndex']; graph: CostGraphExtraction;
  }>();
  const resolve = (modelId?: string) => {
    const resolved = resolveModel(modelId);
    if (!resolved.store.source || resolved.store.source.byteLength === 0) {
      throw new Error(`bim.cost requires loaded IFC source bytes for model '${resolved.modelId}'`);
    }
    let cached = cache.get(resolved.store);
    if (!cached || cached.source !== resolved.store.source
      || cached.schemaVersion !== resolved.store.schemaVersion
      || cached.entityIndex !== resolved.store.entityIndex) {
      cached = {
        source: resolved.store.source, schemaVersion: resolved.store.schemaVersion,
        entityIndex: resolved.store.entityIndex, graph: extractCostOnDemand(resolved.store),
      };
      cache.set(resolved.store, cached);
    }
    return { ...resolved, graph: cached.graph };
  };
  const data = (modelId?: string) => { const value = resolve(modelId); return projectCostGraph(value.modelId, value.graph); };
  return {
    data,
    schedules: modelId => data(modelId).CostSchedules,
    items: modelId => data(modelId).CostItems,
    values: modelId => data(modelId).CostValues,
    evaluateItem: (target, options) => {
      validateEvaluationTarget(target); validateEvaluationOptions(options);
      const value = resolve(target.modelId);
      return projectEvaluation(value.modelId, evaluateCostItem(value.graph, target.expressId, options));
    },
    evaluateValue: (target, options) => {
      validateEvaluationTarget(target); validateEvaluationOptions(options);
      const value = resolve(target.modelId);
      return projectEvaluation(value.modelId, evaluateCostValue(value.graph, target.expressId, options));
    },
  };
}
