/* SPDX-License-Identifier: MPL-2.0 */
/** Matches rust/export/src/schema_structural_varying_constant.rs (#11354). */
import { holdsValue } from './step-comment-skip.js';
import type { StructuralRewrite } from './schema-converter-structural-source.js';

/** The slots a configuration would have held, with the words the warning uses. */
const OMITTED_SLOTS = [
  { slot: 12, attribute: 'VaryingAppliedLoadLocation', words: 'varying locations' },
  { slot: 13, attribute: 'SubsequentAppliedLoads', words: 'subsequent loads' },
] as const;
const lossFor = (words: readonly string[]): string => `The retained varying structural action has no complete load configuration; its ${words.join(' and ')} were omitted (#11037).`;

/**
 * The IFC2X3 attributes the constant action drops of `args` (the 14 attributes
 * of a varying action): VaryingAppliedLoadLocation and SubsequentAppliedLoads
 * when they hold a value, and AppliedLoad when `load` is false and it holds one.
 * What the loss preview names (#11354).
 */
export function constantActionLosses(args: readonly string[], load: boolean): string[] {
  return [...(load || !holdsValue(args[7]) ? [] : ['AppliedLoad']), ...OMITTED_SLOTS.filter((o) => holdsValue(args[o.slot])).map((o) => o.attribute)];
}
const MISSING_LOAD = 'The retained varying structural action has no usable AppliedLoad; the required IFC4 slot was left unset (#11037).';

/**
 * The constant IFC4 action an IFC2X3 varying action is written as when its
 * locations and subsequent loads cannot be written as an IfcStructuralLoadConfiguration
 * (#11037): the initial load stays, PredefinedType is CONST. The one home of
 * that fallback, for the edited or subset export (`finishEffectiveVarying`) and the
 * full one (`StructuralVarying.constant`), so the two cannot drift.
 *
 * `args` are the 14 IFC2X3 attributes. `load` is whether AppliedLoad names an
 * IfcStructuralLoad. `carried`: a 'Causes' relationship holds the CausedBy.
 */
export function constantAction(target: string, entity: string, args: readonly string[], load: boolean, carried: boolean): StructuralRewrite {
  const omitted = OMITTED_SLOTS.filter((o) => holdsValue(args[o.slot])).map((o) => o.words);
  // Reported only when a slot held a value, and naming only those (#11354).
  const losses = omitted.length ? [lossFor(omitted)] : [];
  if (!load) losses.push(MISSING_LOAD);
  if (!carried && holdsValue(args[10])) losses.push(`${entity}.CausedBy has no slot in IFC4; its value is omitted (#11037).`);
  const applied = load ? args[7] : '$';
  return { body: `${target}(${[...args.slice(0, 7), applied, args[8], args[9], args[11], '.CONST.'].join(',')})`, losses };
}
