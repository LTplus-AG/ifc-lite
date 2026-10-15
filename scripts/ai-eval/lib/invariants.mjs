/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic release invariants over one provider answer and the frozen
 * evidence it was given (#6928, plan "Evaluation and test strategy"). These
 * are machine checks with zero tolerated violations in the release corpus;
 * they never judge whether a claim is semantically supported — that is the
 * human claim label (`labels.mjs`).
 *
 * What a check CANNOT see is stated on each entry, so a pass is never read as
 * more than it proves.
 */

export const INVARIANTS = [
  { id: 'citations-valid', description: 'Every cited evidence id (E<n>) names a row in the captured evidence.',
    limit: 'Existence only: a valid citation does not prove the claim it supports.' },
  { id: 'findings-accounted', description: 'A clash grouping cites each captured finding at most once, only complete rows, and the native population partitions into proposed + unclassified.',
    limit: 'Checks the proposal text against captured rows; the native preview re-checks against the live result.' },
  { id: 'no-duplicate-topics', description: 'No two proposed groups share a name (case/space-insensitive) or an identical membership.',
    limit: 'Detects literal duplicates, not semantically overlapping topics.' },
  { id: 'count-claims-match-facts', description: 'Every "<number> <counted noun>" claim in prose equals a number present in the native evidence or, on a live run, in the prompt\'s model-schema summary (element, class and model counts, each only for its own noun).',
    limit: 'Presence, not denominator: a number taken from the wrong field still passes and needs a human claim label.' },
  { id: 'no-effect-claims', description: 'The answer never claims to have applied, changed, created, run or published anything.',
    limit: 'First-person phrase match; paraphrased effect claims need a human claim label.' },
  { id: 'proposal-kind-allowed', description: 'A declared typed proposal kind is one the evidence source offers.',
    limit: 'Kind only; the native preview decides whether the proposal itself is valid.' },
  { id: 'budget-respected', description: 'Reported output stays within the request ceiling and a run stays within its root budget.',
    limit: 'Only provider-reported usage is checked; unreported usage is counted separately, never estimated.' },
];
export const INVARIANT_IDS = INVARIANTS.map(entry => entry.id);

const KINDS_BY_SOURCE = {
  flow: ['flow.patch'],
  clash: ['clash.groups', 'model.changes', 'model.authoring'],
  validation: ['model.changes', 'model.authoring'],
  compare: ['model.changes', 'model.authoring'],
  loadReport: ['model.changes', 'model.authoring'],
};
const DECLARED_KIND = /"kind"\s*:\s*"(clash\.groups|flow\.patch|model\.changes|model\.authoring|[a-z]+\.[a-z.]+)"/;
const COUNT_CLAIM = /(?<![\w.,])(\d{1,7})\s+(?:(?:native|captured|hard|clearance|failing|failed|passing|open|unique|distinct|total)\s+)?(clash(?:es)?|findings?|failures?|walls?|slabs?|elements?|entities|specifications?|requirements?|rows?|issues?|groups?|models?|spaces?)\b/gi;
const EFFECT_CLAIM = /\bI(?:\s+have|'ve)?\s+(?:now\s+)?(?:applied|changed|updated|modified|created|deleted|removed|executed|ran|run|published|saved|fixed|assigned)\b/i;

const record = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** The typed proposal JSON in an answer, as the viewer reads it (whole answer, optionally fenced). */
export function proposalJson(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) return null;
  const kind = DECLARED_KIND.exec(text)?.[1];
  if (!kind) return null;
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  try { return { kind, value: JSON.parse(fenced ? fenced[1] : trimmed) }; }
  catch (error) { return { kind, value: null, parseError: error instanceof Error ? error.message : String(error) }; }
}

function evidenceRows(evidence) {
  const rows = new Map();
  for (const row of Array.isArray(evidence?.evidence?.rows) ? evidence.evidence.rows : []) {
    if (record(row) && typeof row.citation === 'string') rows.set(row.citation, row);
  }
  return rows;
}

function evidenceNumbers(value, out = new Set()) {
  if (typeof value === 'number' && Number.isFinite(value)) out.add(value);
  else if (Array.isArray(value)) { out.add(value.length); value.forEach(item => evidenceNumbers(item, out)); }
  else if (record(value)) Object.values(value).forEach(item => evidenceNumbers(item, out));
  else if (typeof value === 'string') for (const match of value.matchAll(/\b\d+\b/g)) out.add(Number(match[0]));
  return out;
}

const SUMMARY_HEAD = 'Model schema (exact names';
const SUMMARY_PARTIAL = 'counts cover the first scanned';
const SUMMARY_COUNTED = /^(Models|Classes|Properties|Quantities): (.*)$/;
// Nouns the digest counts. Clashes, findings, rows... are not. A class noun is
// backed only by its own classes: each class count and the family sum.
const ELEMENT_NOUN = /^(?:elements?|entities)$/i;
const MODEL_NOUN = /^models?$/i;
const CLASS_NOUNS = [[/^walls?$/i, 'walls', /^IfcWall/], [/^slabs?$/i, 'slabs', /^IfcSlab/], [/^spaces?$/i, 'spaces', /^IfcSpace$/]];

/**
 * The counts the viewer's model-schema digest (`schemaDigest` in
 * apps/viewer/src/lib/assistant/artifacts/artifact-guidance.ts) gave the model
 * in its system prompt, as sets per noun: `elements` holds `name (N elements)`
 * per model and `name N` per class, property and quantity; `models` the number
 * of models listed; `walls`/`slabs`/`spaces` the counts of their IFC classes and
 * the family sum. Only the digest lines are read, so numbers in the prompt's
 * instructions and names (`AC20-...`) are not facts.
 * A partial digest scanned only some elements for properties and quantities
 * (model-schema.ts `SCHEMA_SCAN_LIMIT`), so those counts are dropped; model
 * and class counts cover every element either way.
 * Items are split on ", ", so a model name containing one miscounts the models (rare; accepted).
 */
export function modelSummaryNumbers(system) {
  const facts = { elements: new Set(), models: new Set(), walls: new Set(), slabs: new Set(), spaces: new Set() };
  if (typeof system !== 'string') return facts;
  const lines = system.split('\n');
  const head = lines.findIndex(line => line.startsWith(SUMMARY_HEAD));
  if (head < 0) return facts;
  const partial = lines[head].includes(SUMMARY_PARTIAL);
  for (const line of lines.slice(head + 1)) {
    const section = SUMMARY_COUNTED.exec(line);
    if (!section) break;
    const [, label, body] = section;
    const more = / \(\+(\d+) more\)$/.exec(body);
    const items = (more ? body.slice(0, more.index) : body).split(', ').filter(Boolean);
    if (label === 'Models') facts.models.add(items.length + (more ? Number(more[1]) : 0));
    else if (partial && label !== 'Classes') continue;
    const count = label === 'Models' ? / \((\d+) elements\)$/ : /^(.*) (\d+)$/;
    const sums = new Map();
    for (const item of items) {
      const match = count.exec(item);
      if (!match) continue;
      const value = Number(match[match.length - 1]);
      facts.elements.add(value);
      if (label !== 'Classes') continue;
      for (const [, key, family] of CLASS_NOUNS) {
        if (!family.test(match[1])) continue;
        facts[key].add(value);
        sums.set(key, (sums.get(key) ?? 0) + value);
      }
    }
    for (const [key, sum] of sums) facts[key].add(sum);
  }
  return facts;
}

/** The prompt facts that can back a claim about `noun`, or null. */
function promptFactsFor(promptFacts, noun) {
  if (!promptFacts) return null;
  if (ELEMENT_NOUN.test(noun)) return promptFacts.elements;
  if (MODEL_NOUN.test(noun)) return promptFacts.models;
  const entry = CLASS_NOUNS.find(([pattern]) => pattern.test(noun));
  return entry ? promptFacts[entry[1]] : null;
}

/**
 * Check one answer. `answer`: `{ text, source, evidence, usage, maxOutputTokens, promptFacts }`
 * where `evidence` is the captured payload object (`comparableEvidence`) and
 * `promptFacts` the counts the prompt itself gave the model
 * (`modelSummaryNumbers`), accepted only for the nouns they count; committed
 * recordings keep no prompt, so none.
 * Returns `{ violations: [{ id, detail }], facts }`.
 */
export function checkAnswer({ text, source, evidence, usage = null, maxOutputTokens = null, promptFacts = null }) {
  const violations = [];
  const flag = (id, detail) => violations.push({ id, detail });
  const rows = evidenceRows(evidence);
  const cited = [...new Set([...text.matchAll(/\bE\d+\b/g)].map(match => match[0]))];
  const unknown = cited.filter(citation => !rows.has(citation));
  if (unknown.length) flag('citations-valid', `unknown citations: ${unknown.join(', ')}`);

  const proposal = proposalJson(text);
  const facts = { cited, declaredKind: proposal?.kind ?? null, proposalParsed: proposal ? proposal.value !== null : null,
    accounting: null, countClaims: [] };
  if (proposal && !(KINDS_BY_SOURCE[source] ?? []).includes(proposal.kind)) {
    flag('proposal-kind-allowed', `${proposal.kind} is not offered for ${source} evidence`);
  }
  if (proposal?.kind === 'clash.groups' && record(proposal.value) && Array.isArray(proposal.value.groups)) {
    const seen = new Map();
    const names = new Map();
    const memberships = new Map();
    for (const group of proposal.value.groups) {
      const citations = Array.isArray(group?.citations) ? group.citations.filter(item => typeof item === 'string') : [];
      for (const citation of citations) {
        if (seen.has(citation)) flag('findings-accounted', `${citation} is in "${seen.get(citation)}" and "${group.name}"`);
        else seen.set(citation, group.name);
        const row = rows.get(citation);
        if (row && (row.rowProjectionTruncated || !record(row.data))) flag('findings-accounted', `${citation} is not a complete captured finding`);
      }
      const name = String(group?.name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
      if (names.has(name)) flag('no-duplicate-topics', `group name "${group.name}" repeats`);
      names.set(name, true);
      const membership = [...citations].sort().join(',');
      if (membership && memberships.has(membership)) flag('no-duplicate-topics', `"${group.name}" has the same members as "${memberships.get(membership)}"`);
      memberships.set(membership, group.name);
    }
    const total = typeof evidence?.totalRows === 'number' ? evidence.totalRows : rows.size;
    const proposed = [...seen.keys()].filter(citation => rows.has(citation)).length;
    facts.accounting = { total, proposed, unclassified: total - proposed, omittedFromEvidence: total - rows.size };
    if (proposed > total) flag('findings-accounted', `${proposed} proposed findings exceed the native population of ${total}`);
  }
  if (!proposal) {
    const known = evidenceNumbers(evidence);
    for (const match of text.matchAll(COUNT_CLAIM)) {
      const value = Number(match[1]);
      const matched = known.has(value) || !!promptFactsFor(promptFacts, match[2])?.has(value);
      facts.countClaims.push({ value, noun: match[2], matched });
      if (!matched) flag('count-claims-match-facts', `"${match[0]}" matches no native number in the evidence or model summary`);
    }
  }
  if (EFFECT_CLAIM.test(text)) flag('no-effect-claims', `claims an effect: "${EFFECT_CLAIM.exec(text)[0]}"`);
  if (usage?.outputTokens != null && maxOutputTokens != null && usage.outputTokens > maxOutputTokens) {
    flag('budget-respected', `reported ${usage.outputTokens} output tokens above the ${maxOutputTokens} ceiling`);
  }
  return { violations, facts };
}

/** Run-level budget: request count and reported output tokens against the root budget. */
export function checkRunBudget(receipts, budget) {
  const violations = [];
  const reported = receipts.filter(receipt => receipt.usageReported);
  const outputTokens = reported.reduce((sum, receipt) => sum + (receipt.outputTokens ?? 0), 0);
  if (receipts.length > budget.maxRequests) violations.push({ id: 'budget-respected', detail: `${receipts.length} requests above ${budget.maxRequests}` });
  if (outputTokens > budget.maxOutputTokens) violations.push({ id: 'budget-respected', detail: `${outputTokens} output tokens above ${budget.maxOutputTokens}` });
  return { violations, requests: receipts.length, reportedOutputTokens: outputTokens, unreported: receipts.length - reported.length };
}
