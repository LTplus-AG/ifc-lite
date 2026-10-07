/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stable deep links to panels and assistant/review artifacts (#6927).
 *
 *   ?panel=<panel id>                         open a workspace panel
 *   ?panel=assistant&conversation=<id>        a saved assistant conversation
 *   ?panel=changes&receipt=<id>               a reviewed-change receipt
 *   ?panel=bcf&bcfDraft=<id>                  a BCF draft batch
 *
 * Panel ids are the registry ids the rail, palette and Alt+digit shortcuts
 * already use; a retired id (`ids`) still resolves through `migratePanelId`.
 * An artifact parameter alone implies its panel. Artifacts live in this
 * browser's own content library, so a link resolves only where the artifact
 * was saved; elsewhere it reports the artifact as missing, never guesses.
 */

import { migratePanelId, type WorkspacePanelId } from '@/lib/panels/registry';

export type ArtifactKind = 'conversation' | 'receipt' | 'bcfDraft';

export const ARTIFACT_PANEL: Readonly<Record<ArtifactKind, WorkspacePanelId>> = {
  conversation: 'assistant',
  receipt: 'changes',
  bcfDraft: 'bcf',
};

const ARTIFACT_KINDS = Object.keys(ARTIFACT_PANEL) as ArtifactKind[];
/** Every query parameter this module owns, removed once a link is handled. */
export const DEEP_LINK_PARAMS: readonly string[] = ['panel', ...ARTIFACT_KINDS];

export interface ArtifactRef { kind: ArtifactKind; id: string }

export type ParsedDeepLink =
  | { ok: true; panel: WorkspacePanelId; artifact: ArtifactRef | null }
  | { ok: false; reason: 'unknown-panel'; panel: string }
  | { ok: false; reason: 'conflicting-target'; panel: WorkspacePanelId; artifact: ArtifactRef | null }
  | { ok: false; reason: 'invalid-id'; kind: ArtifactKind };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** Parse the deep-link part of a query string; null when it carries none. */
export function parseDeepLink(search: string | URLSearchParams): ParsedDeepLink | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const rawPanel = params.get('panel');
  const kinds = ARTIFACT_KINDS.filter((kind) => params.has(kind));
  if (rawPanel === null && kinds.length === 0) return null;
  let artifact: ArtifactRef | null = null;
  if (kinds.length > 0) {
    // One artifact per link; ambiguous destinations are refused.
    const kind = kinds[0];
    const id = params.get(kind) ?? '';
    if (params.getAll(kind).length !== 1 || !ID_PATTERN.test(id)) return { ok: false, reason: 'invalid-id', kind };
    artifact = { kind, id };
    if (kinds.length > 1) return { ok: false, reason: 'conflicting-target', panel: ARTIFACT_PANEL[kind], artifact };
  }
  if (rawPanel === null) return { ok: true, panel: ARTIFACT_PANEL[artifact!.kind], artifact };
  const panel = migratePanelId(rawPanel);
  if (params.getAll('panel').some(value => migratePanelId(value) !== panel)) {
    if (panel === undefined) return { ok: false, reason: 'unknown-panel', panel: rawPanel.slice(0, 80) };
    return { ok: false, reason: 'conflicting-target', panel, artifact };
  }
  if (panel === undefined) return { ok: false, reason: 'unknown-panel', panel: rawPanel.slice(0, 80) };
  if (artifact && ARTIFACT_PANEL[artifact.kind] !== panel) return { ok: false, reason: 'conflicting-target', panel, artifact };
  return { ok: true, panel, artifact };
}

/** Build a link on `base` (keeps its other parameters, e.g. `?model=`). */
export function buildDeepLink(base: string, panel: WorkspacePanelId, artifact?: ArtifactRef): string {
  const url = new URL(base);
  for (const name of DEEP_LINK_PARAMS) url.searchParams.delete(name);
  // Artifacts are personal: a share invite (room + token) never rides along.
  url.searchParams.delete('room');
  url.searchParams.delete('t');
  url.searchParams.set('panel', panel);
  if (artifact) url.searchParams.set(artifact.kind, artifact.id);
  url.hash = '';
  return url.toString();
}

export function artifactLink(base: string, artifact: ArtifactRef): string {
  return buildDeepLink(base, ARTIFACT_PANEL[artifact.kind], artifact);
}

/** The query string with every deep-link parameter removed (one-shot links). */
export function withoutDeepLink(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of DEEP_LINK_PARAMS) params.delete(name);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/** `assistant:<conversation id>:<turns>` receipt origins link back to their conversation. */
export function conversationIdFromOrigin(origin: string): string | null {
  const match = /^assistant:([^:]+):\d+$/.exec(origin);
  return match && ID_PATTERN.test(match[1]) ? match[1] : null;
}
