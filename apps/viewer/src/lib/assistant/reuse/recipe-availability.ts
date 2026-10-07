/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host availability for recipe steps. Each step kind derives its
 * requirements; the host snapshot says which are met right now.
 *
 * Two classes of requirement:
 * - grants: things no recipe step can produce (a configured BCF server, a
 *   configured assistant model, a referenced saved graph). A recipe with a
 *   missing grant is refused before it starts, with the reasons.
 * - state: things earlier steps or ordinary use produce (loaded models, a
 *   finished check). A step whose state is missing is disabled with a reason
 *   but the walk-through may still start.
 */

import { loadBcfServerConfig } from '@/services/bcf-server-config';
import { UNCONFIGURED_MODEL_ID } from '@/lib/llm/models';
import type { ViewerState } from '@/store';
import type { AssistantSource } from '../sources';
import type { AssistantRecipe, RecipeStep } from './recipe';

export type HostRequirement =
  | 'models' | 'twoModels' | 'clashResult' | 'validationReport' | 'compareResult' | 'flowGraph'
  | 'assistantModel' | 'bcfServer' | 'savedFlow';
export const GRANT_REQUIREMENTS: ReadonlySet<HostRequirement> = new Set(['assistantModel', 'bcfServer', 'savedFlow']);

export interface HostSnapshot {
  modelCount: number;
  clashResult: boolean;
  validationReport: boolean;
  compareResult: boolean;
  flowGraph: boolean;
  assistantModel: boolean;
  bcfServer: boolean;
  savedFlowIds: ReadonlySet<string>;
}

type HostState = Pick<ViewerState, 'models' | 'clashResult' | 'idsValidationReport' | 'compareResult' | 'flowDoc' | 'savedFlows' | 'chatActiveModel'>;

/** Reads what the host offers now. The BCF connection is read from its native storage. */
export function readHostSnapshot(state: HostState, bcfConfigured = loadBcfServerConfig() !== null): HostSnapshot {
  return {
    modelCount: state.models.size,
    clashResult: !!state.clashResult,
    validationReport: !!state.idsValidationReport,
    compareResult: !!state.compareResult,
    flowGraph: !!state.flowDoc,
    assistantModel: !!state.chatActiveModel && state.chatActiveModel !== UNCONFIGURED_MODEL_ID,
    bcfServer: bcfConfigured,
    savedFlowIds: new Set(state.savedFlows.map(flow => flow.doc.id)),
  };
}

/** The native result each analysis source produces; `loadReport` exists once models load. */
const SOURCE_RESULT: Record<AssistantSource, HostRequirement> = {
  clash: 'clashResult', validation: 'validationReport', compare: 'compareResult', flow: 'flowGraph', loadReport: 'models',
};
const SOURCE_INPUT: Record<AssistantSource, HostRequirement[]> = {
  clash: ['models'], validation: ['models'], compare: ['twoModels'], flow: [], loadReport: ['models'],
};

export function stepRequirements(step: RecipeStep): HostRequirement[] {
  switch (step.kind) {
    case 'analysis': return SOURCE_INPUT[step.source];
    case 'ask': return ['assistantModel', SOURCE_RESULT[step.source]];
    case 'review':
      if (step.action === 'clash.groups' || step.action === 'bcf.drafts') return ['clashResult'];
      if (step.action === 'flow.patch') return ['flowGraph'];
      if (step.action === 'report.draft') return [];
      return ['models'];
    case 'publish': return ['bcfServer'];
    case 'flow': return ['savedFlow'];
  }
}

function met(requirement: HostRequirement, step: RecipeStep, host: HostSnapshot): boolean {
  switch (requirement) {
    case 'models': return host.modelCount > 0;
    case 'twoModels': return host.modelCount >= 2;
    case 'savedFlow': return step.kind === 'flow' && host.savedFlowIds.has(step.flowId);
    default: return host[requirement];
  }
}

export interface StepAvailability { available: boolean; missing: HostRequirement[] }
export function stepAvailability(step: RecipeStep, host: HostSnapshot): StepAvailability {
  const missing = stepRequirements(step).filter(requirement => !met(requirement, step, host));
  return { available: missing.length === 0, missing };
}

/** Whether an analysis or ask step's evidence now exists; other steps are confirmed by the user. */
export function stepProduced(step: RecipeStep, host: HostSnapshot): boolean {
  if (step.kind !== 'analysis') return false;
  const requirement = SOURCE_RESULT[step.source];
  return met(requirement, step, host);
}

export interface RecipeRefusal { stepIndex: number; requirement: HostRequirement }
/** Missing grants refuse the whole recipe before it starts; state requirements never do. */
export function recipeRefusals(recipe: AssistantRecipe, host: HostSnapshot): RecipeRefusal[] {
  return recipe.steps.flatMap((step, stepIndex) => stepAvailability(step, host).missing
    .filter(requirement => GRANT_REQUIREMENTS.has(requirement))
    .map(requirement => ({ stepIndex, requirement })));
}
