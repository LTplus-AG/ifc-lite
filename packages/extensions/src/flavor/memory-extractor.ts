/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Memory extractor — propose overlay deltas from session transcripts.
 *
 * After a long chat session the assistant has likely surfaced
 * preferences ("I want CSV exports", "always default to red for
 * IfcWall"). Rather than ask the user to retype these into their
 * overlay, the extractor walks a session transcript and emits a
 * proposed delta.
 *
 * **Privacy is the headline feature.** The extractor never emits a
 * proposal containing model content, file names, GlobalIds, IDs of any
 * kind, or PII. It does emit phrasing that looks like a stable
 * preference. The output filter is strict: anything matching the
 * blocklist is dropped silently, not edited, so the UI can never
 * surface "we couldn't remove the GlobalId from this suggestion".
 *
 * v1 is rule-based — keyword + phrase matching against the assistant
 * and user turns. The LLM-assisted version with structured-output
 * round trips is a follow-up; the rule extractor is sufficient for
 * the explicit-preference cases that dominate (per RFC §06 §4.2).
 *
 * Spec: docs/architecture/ai-customization/06-self-improvement.md §4.2.
 */

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'system';
  /** Message body. The extractor reads but never echoes it whole. */
  content: string;
  /** Optional ISO timestamp — used to age out very old turns. */
  ts?: string;
}

export interface MemoryProposal {
  /** Short one-line phrasing suitable for the overlay editor. */
  phrasing: string;
  /** Which turn(s) the proposal was sourced from (indexes into transcript). */
  sourceTurns: number[];
  /** Confidence 0..1 from the rule heuristics. */
  confidence: number;
}

export interface ExtractMemoryOptions {
  /** Maximum proposals to return. Default 6. */
  maxProposals?: number;
  /**
   * Optional regex filter that further screens phrasing. Anything matching
   * is dropped (in addition to the built-in blocklist). Used for
   * org-specific PII patterns.
   */
  extraBlocklist?: readonly RegExp[];
}

/**
 * Built-in blocklist. Matches anything that smells like model content,
 * a path, a GlobalId, a credential, or a long alphanumeric blob. We
 * err on the side of dropping good proposals rather than leaking
 * content.
 */
const DEFAULT_BLOCKLIST: readonly RegExp[] = [
  // GUIDs / GlobalIds
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
  /\b[0-9A-Za-z_$]{22}\b/,
  // Express ids in a path-like context
  /#\d{2,}/,
  // File paths / extensions
  /[a-zA-Z]:\\[^\s]+|\/[^\s]*\/[^\s]*|[\w-]+\.(ifc|csv|json|glb|gltf|pdf|png|jpg|step|stp|sat|dwg|dxf)/i,
  // Email-like — accept truncated forms (e.g. "ops@example.") that
  // get cut by the sentence-boundary capture, not just full RFC
  // addresses. Any `@` with surrounding non-whitespace is suspect.
  /\b\S+@\S+\b/,
  // API key fragments
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bsk-ant-[A-Za-z0-9-]+/,
  // Long mixed-case alphanum blobs (likely IDs)
  /\b[A-Z0-9]{12,}\b/,
];

/**
 * Phrases that flag a turn as containing a stable user preference.
 * Each entry includes a `template` the extractor uses to phrase the
 * proposal. `{verb}` is filled from the matched verb in the turn.
 */
/**
 * Modal verbs that turn `always` from a stable preference into a
 * hypothetical / observation ("the wall is always IFC", "I will always
 * check"). When the captured fragment contains one of these we drop
 * the proposal — it's noise, not a preference.
 */
const MODAL_NOISE_RE = /\b(?:will|would|might|may|should|could|might've|would've|users? )\b/i;

const PREFERENCE_PATTERNS: { rx: RegExp; template: string; confidence: number }[] = [
  // Start-of-sentence "always" (or after a sentence boundary) — avoids
  // "I will always", "users always", "the wall is always".
  { rx: /(?:^|[.!?]\s+)always (.{4,80}?)(?:[.!?\n]|$)/i, template: 'Always {0}.', confidence: 0.85 },
  { rx: /\b(?:i (?:always|usually|prefer to)|by default,? i) (.{4,80}?)(?:[.!?\n]|$)/i, template: 'I prefer to {0}.', confidence: 0.8 },
  { rx: /(?:^|[.!?]\s+)never (.{4,80}?)(?:[.!?\n]|$)/i, template: 'Never {0}.', confidence: 0.85 },
  { rx: /\bremind me to (.{4,80}?)(?:[.!?\n]|$)/i, template: 'Remind me to {0}.', confidence: 0.7 },
  { rx: /(?:^|[.!?]\s+)do not (.{4,80}?)(?:[.!?\n]|$)/i, template: 'Do not {0}.', confidence: 0.8 },
  { rx: /\bmy preference (?:is|for [^.]+ is) (.{4,80}?)(?:[.!?\n]|$)/i, template: 'Preference: {0}.', confidence: 0.75 },
];

/**
 * Extract memory proposals from a transcript. Result is sorted by
 * confidence (high → low) and capped at `maxProposals`. Always returns
 * the same shape; on empty/no-match input the array is empty.
 */
export function extractMemoryProposals(
  transcript: readonly TranscriptTurn[],
  opts: ExtractMemoryOptions = {},
): MemoryProposal[] {
  const blocklist = [...DEFAULT_BLOCKLIST, ...(opts.extraBlocklist ?? [])];
  const proposals: MemoryProposal[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < transcript.length; i++) {
    const turn = transcript[i];
    if (turn.role !== 'user') continue; // Only user turns express preferences in v1.
    const text = turn.content;
    if (!text) continue;
    for (const pattern of PREFERENCE_PATTERNS) {
      const m = text.match(pattern.rx);
      if (!m) continue;
      const captured = m[1].trim();
      if (captured.length < 4) continue;
      // Drop hypothetical/observational sentences — "always" alone
      // isn't a preference if it's modified by a modal verb.
      if (MODAL_NOISE_RE.test(captured)) continue;
      const phrasing = renderTemplate(pattern.template, captured);
      if (failsBlocklist(phrasing, blocklist)) continue;
      const key = phrasing.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      proposals.push({
        phrasing,
        sourceTurns: [i],
        confidence: pattern.confidence,
      });
    }
  }

  proposals.sort((a, b) => b.confidence - a.confidence);
  return proposals.slice(0, opts.maxProposals ?? 6);
}

function renderTemplate(template: string, captured: string): string {
  // Normalise spacing / punctuation in the captured fragment.
  const tidy = captured.replace(/\s+/g, ' ').replace(/[\s.,;:]+$/, '');
  return template.replace('{0}', tidy);
}

function failsBlocklist(phrasing: string, blocklist: readonly RegExp[]): boolean {
  for (const rx of blocklist) {
    if (rx.test(phrasing)) return true;
  }
  // Reject if it contains two or more numeric tokens — likely IDs.
  // Privacy-leaning default: prefer dropping a good proposal over
  // surfacing one that may carry an identifier the user didn't notice.
  const numericTokens = phrasing.match(/\b\d+\b/g) ?? [];
  if (numericTokens.length >= 2) return true;
  return false;
}

/**
 * Merge new proposals into an existing overlay body. The proposals are
 * appended under a "Preferences" section if not already present;
 * duplicates (matching by canonical phrasing) are dropped.
 */
export function mergeIntoOverlay(
  existing: string,
  accepted: readonly MemoryProposal[],
): string {
  if (accepted.length === 0) return existing;
  const present = new Set(existing.toLowerCase().split(/\n+/).map((l) => l.replace(/^\s*-\s*/, '').trim()));
  const added: string[] = [];
  for (const proposal of accepted) {
    const canonical = proposal.phrasing.replace(/^\s*-\s*/, '').toLowerCase();
    if (present.has(canonical)) continue;
    added.push(`- ${proposal.phrasing}`);
  }
  if (added.length === 0) return existing;
  const trimmed = existing.trim();
  if (trimmed.length === 0) {
    return `## Preferences\n\n${added.join('\n')}\n`;
  }
  if (/## preferences/i.test(trimmed)) {
    return `${trimmed}\n${added.join('\n')}\n`;
  }
  return `${trimmed}\n\n## Preferences\n\n${added.join('\n')}\n`;
}
