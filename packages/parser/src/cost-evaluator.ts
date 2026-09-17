/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appendCategoryValues, combineCategoryValues } from './cost-category-buckets.js';
import { combineCosts, type EvaluatedCost } from './cost-evaluation-arithmetic.js';
import { createContext, decimal, diagnostic, projectUnit,
  type CostEvaluationContext as Context } from './cost-evaluation-context.js';
import { costEvaluationResult, unsupportedCostEvaluation } from './cost-evaluation-result.js';
import { itemQuantities, type QuantityValue } from './cost-quantity-evaluator.js';
import { consumeValueEvaluationWork, valueEvaluationBudget,
  valueEvaluationSession } from './cost-value-evaluation-session.js';
import type { CostEvaluationOptions, CostEvaluationResult, CostGraphExtraction,
  CostQuantityDimension, CostValueInfo } from './cost-types.js';
function typedValue(value: CostValueInfo, valueId: number, context: Context): EvaluatedCost {
  const operand = value.AppliedValue;
  if (!operand) return {};
  if (operand.Kind === 'Unsupported') {
    diagnostic(context, operand.InvalidNumber ? 'INVALID_NUMBER' : 'UNSUPPORTED_APPLIED_VALUE',
      `IfcAppliedValue #${valueId} uses an unsupported select member`, valueId);
    return { invalid: true };
  }
  if (operand.Kind === 'Reference') {
    const measure = context.measures.get(operand.expressId);
    const unit = measure ? context.units.get(measure.UnitComponent) : undefined;
    if (!measure || !unit) {
      diagnostic(context, 'MISSING_REFERENCE', `AppliedValue reference #${operand.expressId} cannot be evaluated`, valueId);
      return { invalid: true };
    }
    const amount = decimal(measure.ValueComponent, valueId, context);
    if (!amount) return { invalid: true };
    if (unit.Currency) {
      if (measure.ValueType !== 'IFCMONETARYMEASURE') {
        diagnostic(context, 'INCOMPATIBLE_UNIT', `Measure #${operand.expressId} is not monetary`, valueId);
        return { invalid: true };
      }
      return { amount, currency: unit.Currency, monetary: true };
    }
    if (!unit.Dimension || unit.Scale === undefined) {
      diagnostic(context, 'UNSUPPORTED_UNIT', `Unit #${unit.expressId} cannot be evaluated`, valueId);
      return { invalid: true };
    }
    if (measure.ValueDimension !== unit.Dimension) {
      diagnostic(context, 'INCOMPATIBLE_UNIT',
        `Measure #${operand.expressId} uses ${measure.ValueDimension ?? 'unsupported'} with a ${unit.Dimension} unit`, valueId);
      return { invalid: true };
    }
    const normalized = amount.mul(unit.Scale);
    if (!normalized.isFinite() || (normalized.isZero() && !amount.isZero())) {
      diagnostic(context, 'INVALID_NUMBER', `Measure #${operand.expressId} has a non-finite normalized value`, valueId);
      return { invalid: true };
    }
    return { amount: normalized, dimension: unit.Dimension };
  }
  const amount = decimal(operand.Value, valueId, context);
  if (!amount) return { invalid: true };
  if (operand.Type === 'IFCMONETARYMEASURE') {
    if (!context.extraction.Currency) {
      if (context.mixedProjectCurrency) {
        diagnostic(context, 'MIXED_CURRENCY', `IfcCostValue #${valueId} has an ambiguous project currency`, valueId);
        return { invalid: true };
      }
      diagnostic(context, 'MISSING_CURRENCY', `IfcCostValue #${valueId} has no project currency`, valueId, 'warning');
    }
    return { amount, currency: context.extraction.Currency, monetary: true };
  }
  const dimensions: Record<string, CostQuantityDimension | 'ratio'> = {
    IFCLENGTHMEASURE: 'length', IFCAREAMEASURE: 'area', IFCVOLUMEMEASURE: 'volume',
    IFCMASSMEASURE: 'mass', IFCTIMEMEASURE: 'time', IFCCOUNTMEASURE: 'count',
    IFCNUMERICMEASURE: 'ratio', IFCRATIOMEASURE: 'ratio', IFCNORMALISEDRATIOMEASURE: 'ratio',
    IFCREAL: 'ratio', IFCINTEGER: 'ratio',
  };
  const dimension = dimensions[operand.Type];
  if (!dimension) {
    diagnostic(context, 'UNSUPPORTED_APPLIED_VALUE', `Typed value ${operand.Type} is not supported`, valueId);
    return { invalid: true };
  }
  if (dimension === 'ratio' || dimension === 'count') return { amount, dimension };
  const unit = projectUnit(dimension, context);
  if (!unit?.Scale) {
    diagnostic(context, 'UNSUPPORTED_UNIT', `No project ${dimension} unit can be resolved`, valueId);
    return { invalid: true };
  }
  const normalized = amount.mul(unit.Scale);
  if (!normalized.isFinite() || (normalized.isZero() && !amount.isZero())) {
    diagnostic(context, 'INVALID_NUMBER', `IfcCostValue #${valueId} has a non-finite normalized value`, valueId);
    return { invalid: true };
  }
  return { amount: normalized, dimension };
}
function normalizeUnitBasis(value: CostValueInfo, valueId: number, evaluated: EvaluatedCost,
  context: Context, apply = true): EvaluatedCost {
  if (evaluated.invalid || evaluated.amount === undefined) return evaluated;
  if (value.InvalidUnitBasis) {
    diagnostic(context, 'UNSUPPORTED_UNIT', `UnitBasis on #${valueId} is not an entity reference`, valueId);
    return { invalid: true };
  }
  if (value.UnitBasis === undefined) return evaluated;
  if (evaluated.rateDimension !== undefined) {
    diagnostic(context, 'INCOMPATIBLE_UNIT', `UnitBasis on #${valueId} produces a compound cost rate`, valueId);
    return { invalid: true };
  }
  const basis = context.measures.get(value.UnitBasis);
  const unit = basis ? context.units.get(basis.UnitComponent) : undefined;
  const basisValue = basis ? decimal(basis.ValueComponent, valueId, context) : undefined;
  if (!basis || !basisValue || !unit?.Dimension || !unit.Scale || basis.ValueDimension !== unit.Dimension) {
    diagnostic(context, 'UNSUPPORTED_UNIT', `UnitBasis #${value.UnitBasis} cannot be resolved`, valueId);
    return { invalid: true };
  }
  const denominator = basisValue.mul(unit.Scale);
  if (!denominator.isFinite() || denominator.isZero() || denominator.isNegative()) {
    diagnostic(context, denominator.isZero() ? 'DIVISION_BY_ZERO' : 'INVALID_NUMBER',
      `UnitBasis #${value.UnitBasis} is not positive`, valueId);
    return { invalid: true };
  }
  if (!apply) return evaluated;
  const amount = evaluated.amount.div(denominator);
  if (!amount.isFinite() || (amount.isZero() && !evaluated.amount.isZero())) {
    diagnostic(context, 'INVALID_NUMBER', `IfcCostValue #${valueId} produced a non-finite rate`, valueId);
    return { invalid: true };
  }
  return { ...evaluated, amount, rateDimension: unit.Dimension };
}
function normalizeImplicitRate(
  operand: EvaluatedCost, dimension: CostQuantityDimension, valueId: number, context: Context,
): EvaluatedCost {
  if (operand.invalid || operand.amount === undefined) return operand;
  const scale = dimension === 'count' || dimension === 'number' ? '1' : projectUnit(dimension, context)?.Scale;
  if (!scale) {
    diagnostic(context, 'UNSUPPORTED_UNIT', `No project ${dimension} unit can be resolved`, valueId);
    return { invalid: true };
  }
  const amount = operand.amount.div(scale);
  if (!amount.isFinite() || (amount.isZero() && !operand.amount.isZero())) {
    diagnostic(context, 'INVALID_NUMBER', `IfcCostValue #${valueId} produced an invalid implicit rate`, valueId);
    return { invalid: true };
  }
  return { ...operand, amount, rateDimension: dimension };
}
function extendQuantity(
  valueId: number, evaluated: EvaluatedCost, quantities: QuantityValue[], context: Context,
): EvaluatedCost {
  if (evaluated.invalid || evaluated.amount === undefined || quantities.length === 0) return evaluated;
  const dimensions = new Set(quantities.map(entry => entry.dimension));
  if (dimensions.size !== 1) {
    diagnostic(context, 'INCOMPATIBLE_UNIT', 'Direct CostQuantities have incompatible dimensions', valueId);
    return { invalid: true };
  }
  const dimension = quantities[0].dimension;
  if (evaluated.rateDimension !== undefined && evaluated.rateDimension !== dimension) {
    diagnostic(context, 'INCOMPATIBLE_UNIT',
      `Cost rate for ${evaluated.rateDimension} cannot use ${dimension} quantities`, valueId);
    return { invalid: true };
  }
  const normalized = quantities.reduce((sum, entry) => sum.plus(entry.amount), new context.DecimalValue(0));
  const projectScale = dimension === 'count' || dimension === 'number'
    ? '1' : projectUnit(dimension, context)?.Scale;
  if (evaluated.rateDimension === undefined && !projectScale) {
    diagnostic(context, 'UNSUPPORTED_UNIT', `No project ${dimension} unit can be resolved`, valueId);
    return { invalid: true };
  }
  const factor = evaluated.rateDimension === undefined ? normalized.div(projectScale as string) : normalized;
  const quantityApplied = factor;
  const amount = evaluated.amount.mul(factor);
  if (!factor.isFinite() || (factor.isZero() && !normalized.isZero()) || !amount.isFinite() ||
      (amount.isZero() && !evaluated.amount.isZero() && !factor.isZero())) {
    diagnostic(context, 'INVALID_NUMBER', `IfcCostValue #${valueId} produced a non-finite total`, valueId);
    return { invalid: true };
  }
  return { ...evaluated, amount, quantityApplied, rateDimension: undefined };
}
function evaluateValueGraph(root: number, context: Context, quantities: QuantityValue[], implicitRoot: boolean,
  categoryTotals?: Map<string, EvaluatedCost[]>, applyUnitBasis = true,
  session = valueEvaluationSession(root)): EvaluatedCost {
  if (session.exhausted) return { invalid: true };
  const { memo, state } = session;
  const cached = memo.get(root);
  if (cached !== undefined) {
    return implicitRoot ? extendQuantity(root, cached, quantities, context) : cached;
  }
  const stack: Array<{ id: number; expanded: boolean }> = [{ id: root, expanded: false }];
  while (stack.length > 0) {
    const frame = stack.pop() as { id: number; expanded: boolean };
    if (memo.has(frame.id)) continue;
    if (!frame.expanded && !consumeValueEvaluationWork(session)) {
      diagnostic(context, 'INVALID_LIST',
        `IfcAppliedValue graph on #${session.owner} exceeds the evaluation budget`, session.owner);
      return { invalid: true };
    }
    const value = context.values.get(frame.id);
    if (!value) {
      diagnostic(context, 'MISSING_REFERENCE', `IfcAppliedValue #${frame.id} cannot be resolved`, frame.id);
      memo.set(frame.id, { invalid: true });
      continue;
    }
    if (!frame.expanded) {
      if (state.get(frame.id) === 1) {
        diagnostic(context, 'VALUE_CYCLE', `IfcAppliedValue cycle includes #${frame.id}`, frame.id);
        memo.set(frame.id, { invalid: true });
        continue;
      }
      state.set(frame.id, 1);
      stack.push({ id: frame.id, expanded: true });
      const components = value.Components ?? [];
      if (!consumeValueEvaluationWork(session, components.length)) {
        diagnostic(context, 'INVALID_LIST', `IfcAppliedValue graph on #${session.owner} exceeds the evaluation budget`, session.owner);
        return { invalid: true };
      }
      const scheduled = new Set<number>();
      for (let index = components.length - 1; index >= 0; index--) {
        const component = components[index];
        if (!memo.has(component) && !scheduled.has(component)) {
          scheduled.add(component);
          stack.push({ id: component, expanded: false });
        }
      }
      continue;
    }
    state.set(frame.id, 2);
    if (value.Condition || value.InvalidCondition) {
      diagnostic(context, 'UNSUPPORTED_CONDITION', `Condition on IfcAppliedValue #${frame.id} requires external context`, frame.id, 'warning');
      memo.set(frame.id, { invalid: true });
      continue;
    }
    // An explicit empty Category ('', kept distinct from $ since #4881) names no
    // category, so it is not a category total: it falls through to typedValue.
    const category = value.AppliedValue === undefined && value.Components === undefined
      ? value.Category || undefined : undefined;
    const base = category !== undefined
      ? combineCategoryValues(category, categoryTotals, frame.id, session,
        () => diagnostic(context, 'INVALID_LIST', `IfcAppliedValue graph on #${session.owner} exceeds the evaluation budget`, session.owner),
        (Code, Message, id, Severity) => diagnostic(context, Code, Message, id, Severity))
      : value.Components === undefined
        ? typedValue(value, frame.id, context)
      : combineCosts(value.ArithmeticOperator ?? '', value.Components.map(id => memo.get(id) ?? { invalid: true }), frame.id,
        (Code, Message, id, Severity) => diagnostic(context, Code, Message, id, Severity),
        (operand, dimension) => normalizeImplicitRate(operand, dimension, frame.id, context));
    const evaluated = normalizeUnitBasis(value, frame.id, base, context, applyUnitBasis);
    if (!evaluated.invalid && evaluated.amount === undefined) {
      diagnostic(context, 'MISSING_VALUE', `IfcAppliedValue #${frame.id} has no evaluable value`, frame.id, 'warning');
    }
    memo.set(frame.id, evaluated);
  }
  const evaluated = memo.get(root) ?? { invalid: true };
  return implicitRoot ? extendQuantity(root, evaluated, quantities, context) : evaluated;
}
/** Evaluate one IFC4/IFC4X3 applied-value expression using decimal arithmetic. */
export function evaluateCostValue(extraction: CostGraphExtraction, expressId: number,
  options?: CostEvaluationOptions): CostEvaluationResult {
  const refused = unsupportedCostEvaluation(extraction, expressId);
  if (refused) return refused;
  const context = createContext(extraction, options);
  if (context.invalidOptions) return costEvaluationResult(expressId, { invalid: true }, context.diagnostics);
  return costEvaluationResult(expressId, evaluateValueGraph(expressId, context, [], false), context.diagnostics);
}
interface ItemResult extends EvaluatedCost { byCategory: Map<string, EvaluatedCost[]> }
/** Evaluate a cost item, including IFC category-based totals of nested cost items. */
export function evaluateCostItem(extraction: CostGraphExtraction, expressId: number,
  options?: CostEvaluationOptions): CostEvaluationResult {
  const refused = unsupportedCostEvaluation(extraction, expressId);
  if (refused) return refused;
  const context = createContext(extraction, options);
  if (context.invalidOptions) return costEvaluationResult(expressId, { invalid: true }, context.diagnostics);
  const items = new Map(extraction.CostItems.map(item => [item.expressId, item]));
  const children = new Map<number, number[]>();
  const parentByChild = new Map<number, number>();
  const invalidNesting = new Set<number>();
  for (const relation of extraction.Relationships) {
    if (relation.Type === 'IfcRelNests' && relation.RelatingObject !== undefined) {
      const related = (relation.RelatedObjects ?? []).filter(id =>
        items.has(id) || relation.InvalidReferences === true);
      if (relation.InvalidRelatedObjects || relation.InvalidReferences) invalidNesting.add(relation.RelatingObject);
      const nested = children.get(relation.RelatingObject);
      if (nested) {
        for (const child of related) nested.push(child);
      } else {
        children.set(relation.RelatingObject, [...related]);
      }
      for (const child of related) {
        const previous = parentByChild.get(child);
        if (previous !== undefined) {
          invalidNesting.add(previous);
          invalidNesting.add(relation.RelatingObject);
          invalidNesting.add(child);
        } else parentByChild.set(child, relation.RelatingObject);
      }
    }
  }
  if (!items.has(expressId)) {
    return { expressId, Diagnostics: [{ Code: 'MISSING_REFERENCE',
      Message: `IfcCostItem #${expressId} cannot be resolved`, Severity: 'error', expressId }] };
  }
  const memo = new Map<number, ItemResult>();
  const state = new Map<number, 1 | 2>();
  const evaluationBudget = valueEvaluationBudget();
  const stack: Array<{ id: number; expanded: boolean }> = [{ id: expressId, expanded: false }];
  while (stack.length > 0) {
    const frame = stack.pop() as { id: number; expanded: boolean };
    if (memo.has(frame.id)) continue;
    if (!frame.expanded) {
      if (state.get(frame.id) === 1) {
        diagnostic(context, 'NESTING_CYCLE', `Cost item nesting cycle includes #${frame.id}`, frame.id);
        memo.set(frame.id, { invalid: true, byCategory: new Map() });
        continue;
      }
      state.set(frame.id, 1);
      stack.push({ id: frame.id, expanded: true });
      for (const child of [...(children.get(frame.id) ?? [])].reverse()) {
        if (!memo.has(child)) stack.push({ id: child, expanded: false });
      }
      continue;
    }
    state.set(frame.id, 2);
    const item = items.get(frame.id);
    if (!item) {
      diagnostic(context, 'MISSING_REFERENCE', `Nested cost item #${frame.id} cannot be resolved`, frame.id);
      memo.set(frame.id, { invalid: true, byCategory: new Map() });
      continue;
    }
    if (invalidNesting.has(item.expressId)) {
      diagnostic(context, 'MULTIPLE_NESTING_PARENTS', `Cost item #${item.expressId} participates in duplicate nesting`, item.expressId);
      memo.set(frame.id, { invalid: true, byCategory: new Map() });
      continue;
    }
    const quantities = itemQuantities(item, context, context.quantityCache);
    const categoryTotals = new Map<string, EvaluatedCost[]>();
    const valueSession = valueEvaluationSession(item.expressId, evaluationBudget);
    const categoryBudgetExhausted = () => diagnostic(context, 'INVALID_LIST',
      `IfcAppliedValue graph on #${item.expressId} exceeds the evaluation budget`, item.expressId);
    for (const childId of children.get(item.expressId) ?? []) {
      const child = memo.get(childId);
      if (!child) continue;
      if (!appendCategoryValues(categoryTotals, '*', [child], valueSession, categoryBudgetExhausted)) break;
      if (child.invalid &&
          !appendCategoryValues(categoryTotals, '', [child], valueSession, categoryBudgetExhausted)) break;
      for (const [category, values] of child.byCategory) {
        if (category === '*') continue;
        if (!appendCategoryValues(categoryTotals, category, values, valueSession, categoryBudgetExhausted)) break;
      }
      if (valueSession.exhausted) break;
    }
    const entries: Array<{ category?: string; evaluated: EvaluatedCost }> = [];
    const costValueIds = item.CostValues ?? [];
    const wasExhausted = valueSession.exhausted;
    const costValuesWithinBudget = consumeValueEvaluationWork(valueSession, costValueIds.length);
    if (!costValuesWithinBudget && !wasExhausted) categoryBudgetExhausted();
    for (const valueId of costValuesWithinBudget ? costValueIds : []) {
      const value = context.values.get(valueId);
      if (!value) {
        diagnostic(context, 'MISSING_REFERENCE', `IfcCostValue #${valueId} cannot be resolved`, item.expressId);
        entries.push({ evaluated: { invalid: true } });
        continue;
      }
      if (value.Type === 'IfcAppliedValue') {
        diagnostic(context, 'INVALID_LIST', `CostValues on IfcCostItem #${item.expressId} must reference IfcCostValue`, item.expressId);
        entries.push({ evaluated: { invalid: true } });
        continue;
      }
      if (value.Condition || value.InvalidCondition) {
        diagnostic(context, 'UNSUPPORTED_CONDITION', `Condition on IfcAppliedValue #${valueId} requires external context`, valueId, 'warning');
        entries.push({ category: value.Category, evaluated: { invalid: true } });
      } else if (quantities === undefined) {
        entries.push({ category: value.Category, evaluated: { invalid: true } });
      } else {
        entries.push({ category: value.Category,
          evaluated: evaluateValueGraph(valueId, context, quantities, quantities.length > 0,
            categoryTotals, quantities.length > 0, valueSession) });
      }
    }
    if (entries.length === 0) {
      diagnostic(context, 'MISSING_VALUE', `IfcCostItem #${item.expressId} has no evaluable CostValues`, item.expressId, 'warning');
    }
    const byCategory = new Map<string, EvaluatedCost[]>();
    for (const entry of entries) {
      if (entry.category) {
        if (!appendCategoryValues(byCategory, entry.category, [entry.evaluated], valueSession,
          categoryBudgetExhausted)) break;
      } else {
        const uncategorized = byCategory.get('') ?? [];
        if (!byCategory.has('')) byCategory.set('', uncategorized);
        uncategorized.push(entry.evaluated);
      }
    }
    const combined = valueSession.exhausted
      ? { invalid: true }
      : combineCosts('ADD', entries.map(entry => entry.evaluated), item.expressId,
          (Code, Message, id, Severity) => diagnostic(context, Code, Message, id, Severity));
    const quantityApplied = entries.find(entry => entry.evaluated.quantityApplied)?.evaluated.quantityApplied;
    memo.set(frame.id, { ...combined, quantityApplied, byCategory });
  }
  return costEvaluationResult(expressId, memo.get(expressId) ?? { invalid: true }, context.diagnostics);
}
