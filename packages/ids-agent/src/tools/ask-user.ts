/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ids_ask_user`: structured clarification (ADR-008). The model offers 2–4
 * answers, each a ready op batch; the user picks one and that batch is
 * applied to the sandbox like any other. Every choice is checked by the gate
 * BEFORE the user sees it, so the user is never offered an ungrounded
 * answer. Headless runs answer with the first choice.
 */

import { checkOps, type StudioOp } from '@ifc-lite/ids-authoring';
import type { AskUserChoice } from '../bridges.js';
import { objectSchema, type AgentToolContext, type IdsAgentTool } from './context.js';
import { agentOpSchema } from './op-schema.js';
import { applyResult } from './act-tools.js';
import { defineTool, failure, success } from './registry.js';

export const ASK_USER_MAX_CHOICES = 4;

const askUser = defineTool<{ question: string; choices: { label: string; rationale?: string; ops: unknown[] }[] }, AgentToolContext>({
  name: 'ids_ask_user', group: 'ids', strict: false, readOnly: false,
  description: [
    'Ask the user to choose between 2 to 4 materially different answers, each a ready op batch (may be empty).',
    'Ask only when lookups return two or more candidates that differ in meaning or model counts; otherwise choose and state the assumption in the rationale.',
    'The chosen batch is applied for you; its result is returned.',
  ].join(' '),
  inputSchema: objectSchema({
    question: { type: 'string', minLength: 1 },
    choices: {
      type: 'array', minItems: 2,
      items: objectSchema({ label: { type: 'string', minLength: 1 }, rationale: { type: 'string' }, ops: { type: 'array', items: agentOpSchema().op } }, ['label', 'ops']),
    },
  }, ['question', 'choices']),
  defs: agentOpSchema().defs,
  async run(input, ctx) {
    if (input.choices.length > ASK_USER_MAX_CHOICES) {
      return failure('too many choices', { error: `Offer at most ${ASK_USER_MAX_CHOICES} choices.` }, ['ASK:choices']);
    }
    const choices: AskUserChoice[] = [];
    for (const [index, choice] of input.choices.entries()) {
      const ops = ctx.sandbox.handles.resolve(choice.ops);
      const gate = checkOps(ops, ctx.sandbox.doc, ctx.gate);
      if (!gate.ok) {
        return failure(`choice ${index} refused by the gate`, {
          error: `Choice ${index} ("${choice.label}") does not pass the gate; fix it before asking.`,
          issues: gate.issues.map((i) => ({ code: i.code, path: i.path, message: i.message, candidates: i.candidates.slice(0, 5).map((c) => c.value) })),
        }, gate.issues.map((i) => `${i.code}:${i.value ?? i.path}`));
      }
      // The gate accepted them, so they are well-formed ops.
      choices.push({ label: choice.label, ...(choice.rationale ? { rationale: choice.rationale } : {}), ops: ops as StudioOp[] });
    }
    const picked = await ctx.askUser({ id: ctx.callId, question: input.question, choices }, ctx.signal);
    if (picked === null || !choices[picked]) {
      return success('user dismissed the question', { answered: false, note: 'The user did not choose. Record the statement with ids_mark_unresolved (category "ambiguous") or proceed with a stated assumption.' });
    }
    const choice = choices[picked];
    if (choice.ops.length === 0) return success(`user chose "${choice.label}"`, { answered: true, choice: picked, label: choice.label, applied: false });
    const outcome = ctx.sandbox.apply(choice.ops, { origin: 'ask_user', rationale: `${input.question} → ${choice.label}`, sources: [] });
    const result = applyResult(outcome, `answer "${choice.label}"`);
    return { ...result, data: { answered: true, choice: picked, label: choice.label, result: result.data } };
  },
});

export const ASK_USER_TOOLS: readonly IdsAgentTool[] = [askUser];
