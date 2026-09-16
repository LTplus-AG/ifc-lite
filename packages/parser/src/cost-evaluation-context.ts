/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Decimal } from 'decimal.js';
import { quantityEvaluationCache, type QuantityEvaluationCache } from './cost-quantity-evaluator.js';
import { isZeroCostNumericLexeme } from './cost-step-lexemes.js';
import type {
  CostDiagnostic, CostEvaluationOptions, CostGraphExtraction, CostMeasureWithUnitInfo,
  CostQuantityDimension, CostQuantityInfo, CostUnitInfo, CostValueInfo,
} from './cost-types.js';

export interface CostEvaluationContext {
  DecimalValue: Decimal.Constructor;
  extraction: CostGraphExtraction;
  values: Map<number, CostValueInfo>;
  quantities: Map<number, CostQuantityInfo>;
  units: Map<number, CostUnitInfo>;
  measures: Map<number, CostMeasureWithUnitInfo>;
  mixedProjectCurrency: boolean;
  quantityCache: QuantityEvaluationCache;
  diagnostics: CostDiagnostic[];
  invalidOptions: boolean;
}

export function diagnostic(context: CostEvaluationContext, Code: CostDiagnostic['Code'], Message: string,
  expressId: number, Severity: CostDiagnostic['Severity'] = 'error'): void {
  context.diagnostics.push({ Code, Message, Severity, expressId });
}

export function decimal(
  value: string, expressId: number, context: CostEvaluationContext,
): Decimal | undefined {
  try {
    const parsed = new context.DecimalValue(value);
    if (parsed.isFinite() && !(parsed.isZero() && !isZeroCostNumericLexeme(value))) return parsed;
  } catch (error) {
    diagnostic(context, 'INVALID_NUMBER', `#${expressId} contains an invalid decimal: ${String(error)}`, expressId);
    return undefined;
  }
  diagnostic(context, 'INVALID_NUMBER', `#${expressId} contains a non-finite or underflowed decimal`, expressId);
  return undefined;
}

export function projectUnit(
  dimension: CostQuantityDimension, context: CostEvaluationContext,
): CostUnitInfo | undefined {
  const id = context.extraction.ProjectUnits[dimension];
  return id === undefined ? undefined : context.units.get(id);
}

export function createContext(
  extraction: CostGraphExtraction, options?: CostEvaluationOptions,
): CostEvaluationContext {
  const maximumPrecision = 10_000;
  const requestedPrecision = options?.Precision;
  const invalidOptions = requestedPrecision !== undefined &&
    (!Number.isInteger(requestedPrecision) || requestedPrecision < 1 || requestedPrecision > maximumPrecision);
  const diagnostics: CostDiagnostic[] = invalidOptions ? [{
    Code: 'INVALID_NUMBER',
    Message: `Cost evaluation Precision must be an integer from 1 through ${maximumPrecision}; received ${String(requestedPrecision)}`,
    Severity: 'error',
  }] : [];
  const DecimalValue = Decimal.clone({
    precision: invalidOptions ? 34 : requestedPrecision ?? 34,
    rounding: Decimal.ROUND_HALF_EVEN, maxE: 6144, minE: -6144,
  });
  const values = new Map<number, CostValueInfo>();
  for (const value of extraction.CostValues) if (value.expressId !== undefined) values.set(value.expressId, value);
  return {
    DecimalValue, extraction, values,
    quantities: new Map(extraction.CostQuantities.map(value => [value.expressId, value])),
    units: new Map(extraction.Units.map(value => [value.expressId, value])),
    measures: new Map(extraction.MeasuresWithUnit.map(value => [value.expressId, value])),
    mixedProjectCurrency: extraction.Diagnostics.some(entry => entry.Code === 'MIXED_CURRENCY'),
    quantityCache: quantityEvaluationCache(), diagnostics, invalidOptions,
  };
}
