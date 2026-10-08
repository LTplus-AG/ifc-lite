/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { create } from 'zustand';

/**
 * Texts the user explicitly attaches for requirement extraction and mapping
 * evidence: a pasted specification or the current records document. Session
 * only; attaching is the consent to include passages in assistant evidence.
 */
export interface SourceText { id: string; title: string; text: string }
export const SOURCE_TEXT_LIMITS = Object.freeze({ sources: 5, characters: 60_000, title: 120 });

interface SourceTextState { sources: SourceText[] }
export const useSemanticSourceTexts = create<SourceTextState>(() => ({ sources: [] }));

/** Attach a text under the next free id (S1…S9); refuses empty, oversized or excess sources. */
export function attachSourceText(title: string, text: string): SourceText {
  const { sources } = useSemanticSourceTexts.getState();
  if (!text.trim()) throw new Error('The attached text is empty');
  if (text.length > SOURCE_TEXT_LIMITS.characters) throw new Error(`Attached texts are limited to ${SOURCE_TEXT_LIMITS.characters} characters`);
  if (sources.length >= SOURCE_TEXT_LIMITS.sources) throw new Error(`At most ${SOURCE_TEXT_LIMITS.sources} texts can be attached`);
  const used = new Set(sources.map(source => source.id));
  const id = Array.from({ length: 9 }, (_, index) => `S${index + 1}`).find(candidate => !used.has(candidate));
  if (!id) throw new Error('No source id is available');
  const source = { id, title: title.trim().slice(0, SOURCE_TEXT_LIMITS.title) || id, text };
  useSemanticSourceTexts.setState({ sources: [...sources, source] });
  return source;
}

export function detachSourceText(id: string): void {
  useSemanticSourceTexts.setState(state => ({ sources: state.sources.filter(source => source.id !== id) }));
}
