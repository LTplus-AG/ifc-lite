/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `check_rules` (#5138 PR 7b): run a `.rules.json` information-validation
 * rule set — the SAME `@ifc-lite/rules` engine `ifc-lite check` and the
 * viewer's Data Validation panel run — against every model the scope
 * allows. No second evaluator, no parity fixture.
 */

import { readFile } from 'node:fs/promises';
import { parseRuleSetFile, runRuleSet, type EvaluatorModel } from '@ifc-lite/rules';
import type { Tool } from './types.js';
import { okResult } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { resolveSafePath } from '../safe-path.js';
import { modelAllowed } from '../auth/scope.js';
import type { ToolContext } from '../context.js';

async function loadRulesJson(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  let raw: string;
  if (typeof input.rules_json === 'string') {
    raw = input.rules_json;
  } else if (typeof input.rules_path === 'string') {
    const abs = await resolveSafePath(input.rules_path, ctx, 'read');
    raw = await readFile(abs, 'utf-8');
  } else {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Provide rules_json or rules_path.' });
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ToolExecutionError({ code: ToolErrorCode.PARSE_FAILED, message: `Rule set is not valid JSON: ${(err as Error).message}` });
  }
}

const checkRules: Tool = {
  name: 'check_rules',
  description: 'Run a .rules.json information-validation rule set against every model in scope. Either pass `rules_json` inline or `rules_path` to read from disk.',
  scope: 'validate',
  inputSchema: {
    type: 'object',
    properties: {
      rules_json: { type: 'string', description: 'Inline .rules.json content.' },
      rules_path: { type: 'string', description: 'Path to .rules.json file (subject to allowedPaths).' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const raw = await loadRulesJson(input, ctx);
    const parsed = parseRuleSetFile(raw);
    if (!parsed.ok) {
      throw new ToolExecutionError({ code: ToolErrorCode.PARSE_FAILED, message: `Rule set is invalid: ${parsed.error}` });
    }

    const models: EvaluatorModel[] = ctx.registry
      .list()
      .filter((m) => modelAllowed(ctx.scope, m.id))
      // `filterIdentity` carries the model's source identity so a rule set
      // whose `targets.modelFingerprints` were authored in the viewer resolves
      // here too; without it every targeted rule came back unevaluable (#5138
      // PR 7b review).
      .map((m) => ({ id: m.id, filterIdentity: m.sourceFingerprint, store: m.store }));
    if (models.length === 0) {
      throw new ToolExecutionError({ code: ToolErrorCode.MODEL_NOT_FOUND, message: 'No models loaded. Call `model_load` first or start the server with a file path.' });
    }

    const report = await runRuleSet({ ruleSet: parsed.file, models, signal: ctx.signal });
    return okResult(
      `Rules: ${report.summary.passedSpecifications}/${report.summary.totalSpecifications} rules passed.`,
      { report },
    );
  },
};

export const checkRulesTools: Tool[] = [checkRules];
