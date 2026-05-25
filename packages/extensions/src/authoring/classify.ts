/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Intent classifier for chat prompts.
 *
 * Decides what shape of work the user is asking for. Routing is then
 * one-shot script vs. extension authoring vs. fork existing extension
 * vs. out-of-scope.
 *
 * v1 is rule-based: a small set of keyword + structure heuristics.
 * The LLM-fallback (T1 stretch) lands when we have transcript labels
 * to calibrate against; for now the rule classifier is sufficient
 * for >90% of cases by design.
 *
 * Spec: docs/architecture/ai-customization/04-ai-authoring.md §3.
 */

export type ChatIntent = 'one-shot' | 'authoring' | 'fork' | 'out-of-scope';

export interface ClassificationContext {
  /** True iff the user is currently looking at an installed extension
   * (e.g. clicked "Edit" on it). Boosts the fork intent. */
  hasExistingExtension?: boolean;
  /** True iff a model is loaded. Lack of a model often means a meta question. */
  hasLoadedModel?: boolean;
}

export interface Classification {
  intent: ChatIntent;
  /** 0..1 confidence. Below 0.5 should fall back to one-shot. */
  confidence: number;
  /** Free-text reason for the choice — useful in dev logs. */
  reason: string;
}

const AUTHORING_PHRASES = [
  /add (a|the) (button|panel|tool|command|dock|lens|exporter)/i,
  /make (a|this|that) (button|tool|reusable|persistent|one-click)/i,
  /create (a |an )?(extension|panel|tool|button)/i,
  /save .* as .*(tool|extension|button)/i,
  /promote .* to (a )?tool/i,
  /turn .* into (a )?(button|tool|panel|extension)/i,
  /build (a|an) (tool|extension|panel|dashboard|report)/i,
  /\bone-click\b/i,
  /\baddmydirector\b/i,
];

const FORK_PHRASES = [
  /(edit|modify|change|tweak|update) (the|my)(?: [\w-]+){0,4} (extension|tool|panel|button)/i,
  /fork (this|that|the) (extension|tool|panel)/i,
  /add .* (to|in) (my|the) existing (extension|tool|panel)/i,
];

const OUT_OF_SCOPE_PHRASES = [
  /open (\/etc|\/root|\/var|\/home)\//i,
  /(execute|run) shell\b/i,
  /\bnpm install\b/i,
  /\bgit (push|commit|reset)\b/i,
  /(send|post) (this|the) (data|model) to/i,
];

/** Classify a chat message into one of the four intents. */
export function classifyIntent(text: string, ctx: ClassificationContext = {}): Classification {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { intent: 'one-shot', confidence: 0.5, reason: 'empty input' };
  }

  for (const re of OUT_OF_SCOPE_PHRASES) {
    if (re.test(trimmed)) {
      return { intent: 'out-of-scope', confidence: 0.95, reason: `matched ${re}` };
    }
  }

  let forkScore = 0;
  for (const re of FORK_PHRASES) {
    if (re.test(trimmed)) forkScore += 1;
  }
  if (ctx.hasExistingExtension && forkScore === 0 && /\b(edit|change|update|add to)\b/i.test(trimmed)) {
    forkScore = 1;
  }
  if (forkScore > 0) {
    return {
      intent: 'fork',
      confidence: Math.min(0.6 + 0.2 * forkScore, 0.95),
      reason: 'fork phrasing detected',
    };
  }

  let authoringScore = 0;
  for (const re of AUTHORING_PHRASES) {
    if (re.test(trimmed)) authoringScore += 1;
  }
  if (authoringScore > 0) {
    return {
      intent: 'authoring',
      confidence: Math.min(0.65 + 0.1 * authoringScore, 0.95),
      reason: 'authoring phrasing detected',
    };
  }

  return {
    intent: 'one-shot',
    confidence: 0.6,
    reason: 'no authoring/fork/out-of-scope signal',
  };
}
