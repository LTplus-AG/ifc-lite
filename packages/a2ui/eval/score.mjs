/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Score one reply: compiles through the real parser, which components it
 * used, and whether any Text/Callout states a number the model could only have
 * invented (it has no counts in its context, so a digit run in display text
 * next to an entity word is a literal fact).
 */

// The end check is a lookahead, not `\b`: `\b` cannot match after `²`.
const FACT_PATTERN = /\b\d+(?:[.,]\d+)?\s*(?:doors?|windows?|walls?|slabs?|spaces?|rooms?|elements?|entities|m²|m2|sqm|items?)(?![\p{L}\p{N}_])/iu;

export function scoreReply(agent, text, testCase) {
  let parts;
  let compileError = null;
  try {
    parts = agent.parse(text);
  } catch (error) {
    compileError = String(error.message ?? error).slice(0, 400);
    parts = error.partialResults ?? [];
  }
  const blocks = (text.match(/<a2ui>/g) ?? []).length;
  const messages = parts.filter((p) => p.type === 'a2ui').flatMap((p) => p.a2ui);
  const components = messages.flatMap((m) => m.createSurface?.components ?? m.updateComponents?.components ?? []);
  const used = [...new Set(components.map((c) => c.component))];
  const literalFacts = components
    .filter((c) => c.component === 'Text' || c.component === 'Callout')
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .filter((t) => FACT_PATTERN.test(t));
  return {
    expectSurface: testCase.expectSurface,
    blocks,
    compiled: compileError === null && (blocks === 0 || messages.length > 0),
    compileError,
    surfaces: messages.filter((m) => m.createSurface).length,
    used,
    missingComponents: testCase.expect.filter((name) => !used.includes(name)),
    literalFacts,
  };
}
