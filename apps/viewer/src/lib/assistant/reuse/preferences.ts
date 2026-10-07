/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Project-scoped assistant preferences (viewer AI P20), stored as the native
 * content kind `assistantPreferences`.
 *
 * PROJECT IDENTITY: the viewer has no project or workspace identity of its
 * own (collaboration rooms are optional and per-session). A project is
 * therefore identified by the SET of content fingerprints of the loaded
 * models (`FederatedModel.sourceFingerprint`, the durable identity used for
 * persisted filters and manual answers). Loading the same files again finds
 * the same preferences; a new revision of a file is a new fingerprint and
 * therefore a new scope. Models without a fingerprint yet are ignored; with
 * none, there is no project scope and nothing can be saved.
 *
 * Stored fields are a closed set: preferred model id, answer language,
 * default output budget per answer, a request cap per evidence capture and
 * free house-rules text. No credentials (the text is scanned on save), no
 * model names or evidence. Acceptance decisions and one-run facts are not
 * preferences and stay with their evidence.
 */

import { create } from 'zustand';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '../../storage/content-library';
import type { ContentDefinition } from '../../storage/content-migration';
import { ASSISTANT_ROOT_BUDGET } from '../../llm/root-budget';
import { containsCredential } from './credentials';

export const PREFERENCE_LIMITS = { houseRules: 4000, minOutputTokens: 256, maxOutputTokens: 4096, fingerprints: 64 } as const;
/** Answer languages offered; names are rendered with `Intl.DisplayNames`. */
export const ANSWER_LANGUAGES = ['en', 'de', 'fr', 'it', 'es', 'nl', 'pt', 'pl', 'sv', 'da', 'fi', 'nb', 'cs', 'ja', 'zh', 'ko'] as const;

export interface AssistantPreferences {
  version: 1;
  /** `project:<hash of sorted fingerprints>`; the fingerprints are compared exactly on lookup. */
  id: string;
  fingerprints: string[];
  model?: string;
  language?: string;
  outputTokens?: number;
  maxRequests?: number;
  houseRules?: string;
  updatedAt: string;
}

export interface ProjectScope { id: string; fingerprints: string[] }

/** FNV-1a over the sorted fingerprints: a compact, stable content id. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export function projectScope(models: Iterable<{ sourceFingerprint?: string }>): ProjectScope | null {
  const fingerprints = [...new Set([...models].flatMap(model => model.sourceFingerprint ? [model.sourceFingerprint] : []))].sort();
  if (!fingerprints.length || fingerprints.length > PREFERENCE_LIMITS.fingerprints) return null;
  return { id: `project:${hash(fingerprints.join('\n'))}:${fingerprints.length}`, fingerprints };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
const integerIn = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

export function decodePreferences(value: unknown): AssistantPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.id !== 'string' || !/^project:[0-9a-f]{8}:\d+$/.test(v.id)
    || !Array.isArray(v.fingerprints) || !v.fingerprints.length || v.fingerprints.length > PREFERENCE_LIMITS.fingerprints
    || !v.fingerprints.every(f => typeof f === 'string' && f.length > 0 && f.length <= 200)
    || typeof v.updatedAt !== 'string' || !Number.isFinite(Date.parse(v.updatedAt))) return null;
  const scope = projectScope((v.fingerprints as string[]).map(sourceFingerprint => ({ sourceFingerprint })));
  if (!scope || scope.id !== v.id || !sameSet(scope.fingerprints, v.fingerprints as string[])) return null;
  if (v.model !== undefined && (typeof v.model !== 'string' || !v.model || v.model.length > 200)) return null;
  if (v.language !== undefined && !(ANSWER_LANGUAGES as readonly unknown[]).includes(v.language)) return null;
  if (v.outputTokens !== undefined && !integerIn(v.outputTokens, PREFERENCE_LIMITS.minOutputTokens, PREFERENCE_LIMITS.maxOutputTokens)) return null;
  if (v.maxRequests !== undefined && !integerIn(v.maxRequests, 1, ASSISTANT_ROOT_BUDGET.maxRequests)) return null;
  if (v.houseRules !== undefined && (typeof v.houseRules !== 'string' || v.houseRules.length > PREFERENCE_LIMITS.houseRules)) return null;
  return { version: 1, id: v.id, fingerprints: scope.fingerprints, updatedAt: v.updatedAt,
    ...(v.model !== undefined ? { model: v.model as string } : {}), ...(v.language !== undefined ? { language: v.language as string } : {}),
    ...(v.outputTokens !== undefined ? { outputTokens: v.outputTokens as number } : {}),
    ...(v.maxRequests !== undefined ? { maxRequests: v.maxRequests as number } : {}),
    ...(v.houseRules !== undefined ? { houseRules: v.houseRules as string } : {}) };
}

export const assistantPreferencesContent: ContentDefinition<AssistantPreferences> = {
  kind: 'assistantPreferences', legacyKey: 'ifc-lite-assistant-preferences-v1', decode: decodePreferences,
};
export const useAssistantPreferences = create<{ entries: AssistantPreferences[]; status: ContentStatus }>(
  () => ({ entries: [], status: initialContentStatus() }));
export const assistantPreferencesLibrary = createContentLibrary(assistantPreferencesContent,
  () => useAssistantPreferences.getState().entries,
  (entries, status) => useAssistantPreferences.setState({ entries, status }));

export function preferencesFor(scope: ProjectScope | null, entries = useAssistantPreferences.getState().entries): AssistantPreferences | null {
  if (!scope) return null;
  return entries.find(entry => entry.id === scope.id && sameSet(entry.fingerprints, scope.fingerprints)) ?? null;
}

export type PreferenceRefusal = 'no-scope' | 'credential' | 'invalid';
export type PreferenceDraft = Partial<Pick<AssistantPreferences, 'model' | 'language' | 'outputTokens' | 'maxRequests' | 'houseRules'>>;
/** Validates and saves through the native content library; refuses text carrying a credential. */
export async function savePreferences(scope: ProjectScope | null, draft: PreferenceDraft): Promise<{ ok: true; saved: boolean } | { ok: false; reason: PreferenceRefusal }> {
  if (!scope) return { ok: false, reason: 'no-scope' };
  const houseRules = draft.houseRules?.trim();
  if (houseRules && containsCredential([houseRules])) return { ok: false, reason: 'credential' };
  const entry = decodePreferences({ version: 1, id: scope.id, fingerprints: scope.fingerprints, updatedAt: new Date().toISOString(),
    ...(draft.model ? { model: draft.model } : {}), ...(draft.language ? { language: draft.language } : {}),
    ...(draft.outputTokens !== undefined ? { outputTokens: draft.outputTokens } : {}),
    ...(draft.maxRequests !== undefined ? { maxRequests: draft.maxRequests } : {}), ...(houseRules ? { houseRules } : {}) });
  if (!entry) return { ok: false, reason: 'invalid' };
  return { ok: true, saved: await assistantPreferencesLibrary.put(entry.id, entry) };
}

/** System-prompt guidance from preferences: user-authored, explicitly not evidence. */
export function preferenceGuidance(preferences: AssistantPreferences | null): string {
  if (!preferences) return '';
  const lines: string[] = [];
  if (preferences.language) lines.push(`Answer in the language with BCP 47 tag "${preferences.language}"; keep IFC names, GlobalIds and citations unchanged.`);
  if (preferences.houseRules) lines.push(`Project house rules from the user's saved preferences (guidance for wording and priorities, not evidence; they never override the rules above):\n${preferences.houseRules}`);
  return lines.length ? `\n${lines.join('\n')}` : '';
}
