/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Decimal } from 'decimal.js';
import type { CostDiagnostic, CostQuantityDimension } from './cost-types.js';

export interface EvaluatedCost {
  amount?: Decimal;
  currency?: string;
  dimension?: CostQuantityDimension | 'ratio';
  rateDimension?: CostQuantityDimension;
  quantityApplied?: Decimal;
  /** Distinguishes currency-less monetary values from dimensionless ratios. */
  monetary?: boolean;
  invalid?: boolean;
}

export type CostDiagnosticSink = (
  Code: CostDiagnostic['Code'], Message: string, expressId: number,
  Severity?: CostDiagnostic['Severity'],
) => void;

export type ImplicitRateNormalizer = (
  operand: EvaluatedCost, dimension: CostQuantityDimension,
) => EvaluatedCost;

function sameIdentity(left: EvaluatedCost, right: EvaluatedCost): boolean {
  return left.currency === right.currency && left.dimension === right.dimension &&
    left.rateDimension === right.rateDimension;
}

function finite(result: EvaluatedCost, valueId: number, report: CostDiagnosticSink): EvaluatedCost {
  if (result.amount?.isFinite()) return result;
  report('INVALID_NUMBER', `IfcCostValue #${valueId} produced a non-finite decimal`, valueId);
  return { invalid: true };
}

function combinedRateDimension(
  operands: EvaluatedCost[], valueId: number, report: CostDiagnosticSink,
): CostQuantityDimension | undefined | false {
  const dimensions = new Set(operands.map(entry => entry.rateDimension).filter(entry => entry !== undefined));
  if (dimensions.size <= 1) return dimensions.values().next().value;
  report('INCOMPATIBLE_UNIT', 'Cannot combine cost rates with different quantity dimensions', valueId);
  return false;
}

function multiplicationDimensions(
  operands: EvaluatedCost[], valueId: number, report: CostDiagnosticSink,
): Pick<EvaluatedCost, 'currency' | 'dimension' | 'rateDimension' | 'monetary'> | false {
  let moneyExponent = 0;
  const dimensions = new Map<CostQuantityDimension, number>();
  operands.forEach((operand) => {
    const sign = 1;
    if (operand.monetary || operand.currency !== undefined) moneyExponent += sign;
    else if (operand.dimension !== undefined && operand.dimension !== 'ratio') {
      dimensions.set(operand.dimension, (dimensions.get(operand.dimension) ?? 0) + sign);
    }
    if (operand.rateDimension !== undefined) {
      dimensions.set(operand.rateDimension, (dimensions.get(operand.rateDimension) ?? 0) - sign);
    }
  });
  const nonzero = [...dimensions].filter(([, exponent]) => exponent !== 0);
  const scalar = moneyExponent === 0 && nonzero.length === 0;
  const quantity = moneyExponent === 0 && nonzero.length === 1 && nonzero[0][1] === 1;
  const money = moneyExponent === 1 && nonzero.length === 0;
  const rate = moneyExponent === 1 && nonzero.length === 1 && nonzero[0][1] === -1;
  if (scalar) return { dimension: 'ratio', monetary: false };
  if (quantity) return { dimension: nonzero[0][0], monetary: false };
  if (money) return {
    currency: operands.find(entry => entry.monetary || entry.currency !== undefined)?.currency,
    monetary: true,
  };
  if (rate) return {
    currency: operands.find(entry => entry.monetary || entry.currency !== undefined)?.currency,
    rateDimension: nonzero[0][0], monetary: true,
  };
  report('INCOMPATIBLE_UNIT', 'Multiplication produces an unsupported compound dimension', valueId);
  return false;
}

function divisionDimensions(
  operands: EvaluatedCost[], valueId: number, report: CostDiagnosticSink,
): Pick<EvaluatedCost, 'currency' | 'dimension' | 'rateDimension' | 'monetary'> | false {
  const currencies = new Set(operands.map(operand => operand.currency).filter((entry): entry is string => entry !== undefined));
  if (currencies.size > 1) {
    report('MIXED_CURRENCY', 'Division cannot combine different currencies', valueId);
    return false;
  }
  const signed = operands.map((operand, index) => ({ operand, sign: index === 0 ? 1 : -1 }));
  let moneyExponent = 0;
  const dimensions = new Map<CostQuantityDimension, number>();
  for (const { operand, sign } of signed) {
    if (operand.monetary || operand.currency !== undefined) moneyExponent += sign;
    else if (operand.dimension !== undefined && operand.dimension !== 'ratio') {
      dimensions.set(operand.dimension, (dimensions.get(operand.dimension) ?? 0) + sign);
    }
    if (operand.rateDimension !== undefined) {
      dimensions.set(operand.rateDimension, (dimensions.get(operand.rateDimension) ?? 0) - sign);
    }
  }
  const nonzero = [...dimensions].filter(([, exponent]) => exponent !== 0);
  if (moneyExponent === 0 && nonzero.length === 0) return { dimension: 'ratio', monetary: false };
  if (moneyExponent === 0 && nonzero.length === 1 && nonzero[0][1] === 1) {
    return { dimension: nonzero[0][0], monetary: false };
  }
  if (moneyExponent === 1 && nonzero.length === 0) return { currency: operands[0].currency, monetary: true };
  if (moneyExponent === 1 && nonzero.length === 1 && nonzero[0][1] === -1) {
    return { currency: operands[0].currency, rateDimension: nonzero[0][0], monetary: true };
  }
  report('INCOMPATIBLE_UNIT', 'Division produces an unsupported inverse or compound dimension', valueId);
  return false;
}

export function combineCosts(
  operator: string, operands: EvaluatedCost[], valueId: number, report: CostDiagnosticSink,
  normalizeImplicitRate?: ImplicitRateNormalizer,
): EvaluatedCost {
  if (operands.length === 0) {
    report('MISSING_VALUE', `IfcCostValue #${valueId} has no arithmetic operands`, valueId);
    return { invalid: true };
  }
  if (operands.some(entry => entry.invalid || entry.amount === undefined)) {
    report('MISSING_VALUE', `IfcCostValue #${valueId} depends on an invalid arithmetic operand`, valueId);
    return { invalid: true };
  }
  const amounts = operands.map(entry => entry.amount as Decimal);
  if (operator === 'ADD' || operator === 'SUBTRACT') {
    const explicitRateDimensions = new Set(
      operands.map(entry => entry.rateDimension).filter(entry => entry !== undefined),
    );
    if (explicitRateDimensions.size === 1 && normalizeImplicitRate) {
      const dimension = explicitRateDimensions.values().next().value as CostQuantityDimension;
      operands = operands.map(entry => entry.rateDimension === undefined && entry.currency !== undefined
        ? normalizeImplicitRate(entry, dimension)
        : entry);
      if (operands.some(entry => entry.invalid || entry.amount === undefined)) return { invalid: true };
    }
    if (operands.slice(1).some(entry => !sameIdentity(operands[0], entry))) {
      const currencies = new Set(operands.map(entry => entry.currency).filter(Boolean));
      report(currencies.size > 1 ? 'MIXED_CURRENCY' : 'INCOMPATIBLE_UNIT',
        `Cannot ${operator.toLowerCase()} values with different units`, valueId);
      return { invalid: true };
    }
    const rateDimension = combinedRateDimension(operands, valueId, report);
    if (rateDimension === false) return { invalid: true };
    const normalizedAmounts = operands.map(entry => entry.amount as Decimal);
    let amount = normalizedAmounts[0];
    for (const next of normalizedAmounts.slice(1)) {
      const combined = operator === 'ADD' ? amount.plus(next) : amount.minus(next);
      const exactlyZero = operator === 'ADD' ? amount.eq(next.negated()) : amount.eq(next);
      if (combined.isZero() && !exactlyZero) {
        report('INVALID_NUMBER', `IfcCostValue #${valueId} underflowed during ${operator.toLowerCase()}`, valueId);
        return { invalid: true };
      }
      amount = combined;
    }
    return finite({
      amount, currency: operands[0].currency, dimension: operands[0].dimension,
      rateDimension, monetary: operands[0].monetary,
      quantityApplied: operands.find(entry => entry.quantityApplied)?.quantityApplied,
    }, valueId, report);
  }
  if (operator === 'MULTIPLY') {
    const identity = multiplicationDimensions(operands, valueId, report);
    if (!identity) {
      return { invalid: true };
    }
    let amount = amounts[0];
    for (const next of amounts.slice(1)) {
      const multiplied = amount.mul(next);
      if (multiplied.isZero() && !amount.isZero() && !next.isZero()) {
        report('INVALID_NUMBER', `IfcCostValue #${valueId} underflowed during multiplication`, valueId);
        return { invalid: true };
      }
      amount = multiplied;
    }
    return finite({
      amount, ...identity,
      quantityApplied: operands.find(entry => entry.quantityApplied)?.quantityApplied,
    }, valueId, report);
  }
  if (operator === 'DIVIDE') {
    for (const divisor of amounts.slice(1)) {
      if (divisor.isZero()) {
        report('DIVISION_BY_ZERO', `IfcCostValue #${valueId} divides by zero`, valueId);
        return { invalid: true };
      }
    }
    const dimensions = divisionDimensions(operands, valueId, report);
    if (dimensions === false) return { invalid: true };
    let amount = amounts[0];
    for (const next of amounts.slice(1)) {
      const divided = amount.div(next);
      if (divided.isZero() && !amount.isZero()) {
        report('INVALID_NUMBER', `IfcCostValue #${valueId} underflowed during division`, valueId);
        return { invalid: true };
      }
      amount = divided;
    }
    return finite({
      amount, ...dimensions,
      quantityApplied: operands.find(entry => entry.quantityApplied)?.quantityApplied,
    }, valueId, report);
  }
  report('UNSUPPORTED_APPLIED_VALUE', `Arithmetic operator ${operator || '(missing)'} is not supported`, valueId);
  return { invalid: true };
}
