#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A2UI generation eval: does a model, given the IFC catalog prompt, write
 * surfaces that compile and follow the "facts are bound" rule?
 *
 * Talks to any OpenAI-compatible endpoint (the hosted proxy's upstream).
 *   LLM_API_BASE=https://openrouter.ai/api/v1 LLM_API_KEY=... \
 *     node packages/a2ui/eval/run-eval.mjs --models a,b --out report.json
 *
 * Needs `pnpm --filter @ifc-lite/a2ui build` first (imports dist/).
 */

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createIfcAgent } from '../dist/agent.js';
import { CASES, MODEL_CONTEXT } from './cases.mjs';
import { scoreReply } from './score.mjs';

const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    out: { type: 'string', default: 'a2ui-eval.json' },
    cases: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
  },
});

const base = process.env.LLM_API_BASE;
const key = process.env.LLM_API_KEY;
if (!base || !key || !values.models) {
  console.error('usage: LLM_API_BASE=… LLM_API_KEY=… run-eval.mjs --models m1,m2 [--cases id1,id2] [--out file]');
  process.exit(2);
}

const agent = createIfcAgent();
const system = `You are the assistant inside the ifc-lite BIM viewer. Answer the user's question about the loaded building model. When a visual result helps, include an A2UI block.\n\n${MODEL_CONTEXT}\n\n${agent.promptSnippet}`;
const models = values.models.split(',').map((m) => m.trim()).filter(Boolean);
const cases = values.cases ? CASES.filter((c) => values.cases.split(',').includes(c.id)) : CASES;

async function complete(model, prompt) {
  const started = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'X-Title': 'ifc-lite a2ui eval' },
    body: JSON.stringify({ model, temperature: 0.3, max_tokens: 4000, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return { text: body.choices?.[0]?.message?.content ?? '', ms: Date.now() - started, usage: body.usage ?? null };
}

const jobs = models.flatMap((model) => cases.map((c) => ({ model, c })));
const results = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { model, c } = jobs[next++];
    try {
      const reply = await complete(model, c.prompt);
      results.push({ model, case: c.id, ms: reply.ms, usage: reply.usage, ...scoreReply(agent, reply.text, c), reply: reply.text });
    } catch (error) {
      results.push({ model, case: c.id, transportError: String(error.message ?? error) });
    }
    process.stderr.write('.');
  }
}
await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
process.stderr.write('\n');

const summary = models.map((model) => {
  const rows = results.filter((r) => r.model === model);
  const ok = rows.filter((r) => !r.transportError);
  const count = (pred) => ok.filter(pred).length;
  return {
    model,
    cases: rows.length,
    transportErrors: rows.length - ok.length,
    compiled: count((r) => r.compiled),
    usedSurfaceWhenExpected: count((r) => r.expectSurface ? r.surfaces > 0 : r.surfaces === 0),
    usedExpectedComponents: count((r) => r.missingComponents?.length === 0),
    literalFactViolations: count((r) => r.literalFacts.length > 0),
    medianMs: median(ok.map((r) => r.ms)),
  };
});

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

writeFileSync(values.out, JSON.stringify({ promptChars: system.length, summary, results }, null, 2));
console.table(summary);
