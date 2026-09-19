/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MethodSchema } from './bridge-schema.js';

const ENTITY_REF = '{ modelId: string; expressId: number }';

function paramsMethod<K extends 'addCostSchedule' | 'addCostItem' | 'addCostValue' | 'addCostQuantity'>(
  name: K,
  paramsType: string,
): MethodSchema {
  return {
    name,
    doc: `Add an Ifc${name.slice(3)} to a parsed model.`,
    args: ['string', 'dump'],
    paramNames: ['modelId', 'params'],
    tsParamTypes: ['string', paramsType],
    tsReturn: ENTITY_REF,
    call: (sdk, args) => {
      const method = sdk.store[name] as (
        modelId: string,
        params: Parameters<typeof sdk.store[K]>[1],
      ) => ReturnType<typeof sdk.store[K]>;
      return method.call(sdk.store, args[0] as string, args[1] as Parameters<typeof sdk.store[K]>[1]);
    },
    returns: 'value',
  };
}

function relationshipMethod(
  name: 'nestCostItems' | 'assignCostItemsToSchedule' | 'assignToCostItem',
  ownerName: string,
  membersName: string,
): MethodSchema {
  return {
    name,
    doc: `Create or update the loaded-model cost relationship for ${name}.`,
    args: ['string', 'number', 'dump'],
    paramNames: ['modelId', ownerName, membersName],
    tsParamTypes: ['string', 'number', 'number[]'],
    tsReturn: ENTITY_REF,
    call: (sdk, args) => sdk.store[name](args[0] as string, args[1] as number, args[2] as number[]),
    returns: 'value',
  };
}

/** The loaded-model 5D authoring surface exposed through `bim.store`. */
export function buildStoreCostMethods(): MethodSchema[] {
  return [
    paramsMethod('addCostSchedule', '{ Name: string; Description?: string; ObjectType?: string; Identification?: string; PredefinedType?: "BUDGET" | "COSTPLAN" | "ESTIMATE" | "TENDER" | "PRICEDBILLOFQUANTITIES" | "UNPRICEDBILLOFQUANTITIES" | "SCHEDULEOFRATES" | "USERDEFINED" | "NOTDEFINED"; Status?: string; SubmittedOn?: string; UpdateDate?: string }'),
    paramsMethod('addCostItem', '{ Name: string; Description?: string; ObjectType?: string; Identification?: string; PredefinedType?: "USERDEFINED" | "NOTDEFINED"; CostValues?: number[]; CostQuantities?: number[] }'),
    paramsMethod('addCostValue', '{ Name?: string; Description?: string; AppliedValue?: { Type: "IfcMonetaryMeasure" | "IfcAreaMeasure" | "IfcVolumeMeasure" | "IfcLengthMeasure" | "IfcMassMeasure" | "IfcTimeMeasure" | "IfcCountMeasure" | "IfcNumericMeasure" | "IfcRatioMeasure" | "IfcReal" | "IfcInteger"; Value: number }; AppliedValueRef?: number; UnitBasis?: number; ApplicableDate?: string; FixedUntilDate?: string; Category?: string; Condition?: string; ArithmeticOperator?: "ADD" | "DIVIDE" | "MULTIPLY" | "SUBTRACT"; Components?: number[] }'),
    paramsMethod('addCostQuantity', '{ Kind: "IfcQuantityLength" | "IfcQuantityArea" | "IfcQuantityVolume" | "IfcQuantityWeight" | "IfcQuantityTime" | "IfcQuantityCount" | "IfcQuantityNumber"; Name: string; Value: number; Description?: string; Unit?: number; Formula?: string }'),
    relationshipMethod('nestCostItems', 'parentExpressId', 'childExpressIds'),
    relationshipMethod('assignCostItemsToSchedule', 'scheduleExpressId', 'itemExpressIds'),
    relationshipMethod('assignToCostItem', 'costItemExpressId', 'objectExpressIds'),
    {
      name: 'setCostItemValues',
      doc: 'Replace an IfcCostItem CostValues list; pass [] to clear it.',
      args: ['string', 'number', 'dump'],
      paramNames: ['modelId', 'itemExpressId', 'valueExpressIds'],
      tsParamTypes: ['string', 'number', 'number[]'],
      call: (sdk, args) => sdk.store.setCostItemValues(args[0] as string, args[1] as number, args[2] as number[]),
      returns: 'void',
    },
    {
      name: 'removeCostEntity',
      doc: 'Safely remove an IfcCostSchedule, IfcCostItem, or IfcCostValue from a parsed model.',
      args: ['string', 'number', 'dump'],
      paramNames: ['modelId', 'expressId', 'options'],
      tsParamTypes: ['string', 'number', '{ detach?: boolean } | undefined'],
      call: (sdk, args) => sdk.store.removeCostEntity(
        args[0] as string,
        args[1] as number,
        args[2] as { detach?: boolean } | undefined,
      ),
      returns: 'void',
    },
  ];
}
