/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isRecord, onlyKeys, requiredText } from '@/lib/check-authoring/proposal-json';
export interface ZoneEmissionProposal { version: 1; kind: 'zones.emit'; title: string; modelId: string; zoneSetId: string; storey: { GlobalId: string; Name: string | null }; expected: unknown }
export function declaresZoneEmission(content: string) { return /"kind"\s*:\s*"zones\.emit"/.test(content); }
export function parseZoneEmissionProposal(content: string): ZoneEmissionProposal {
  if (content.length > 100000) throw new Error('Zone emission proposal exceeds the review limit');
  const trimmed = content.trim(), fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed), value: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'zones.emit') throw new Error('Expected a version 1 zone emission proposal');
  onlyKeys(value, ['version', 'kind', 'title', 'modelId', 'zoneSetId', 'storey', 'expected'], 'Zone emission');
  if (!isRecord(value.storey) || !isRecord(value.expected)) throw new Error('Supply the explicit current storey and complete native expected snapshot');
  onlyKeys(value.storey, ['GlobalId', 'Name'], 'storey');
  const GlobalId = requiredText(value.storey, 'GlobalId', 'storey', 22);
  if (!/^[0-3][0-9A-Za-z_$]{21}$/.test(GlobalId) || value.storey.Name !== null && (typeof value.storey.Name !== 'string' || value.storey.Name.length > 240)) throw new Error('Supply the native current storey GlobalId and Name');
  const pending = [{ value: value.expected as unknown, depth: 0 }]; let work = 0;
  while (pending.length) { const item = pending.pop()!; if (++work > 12000 || item.depth > 20) throw new Error('Native zone evidence exceeds the review limit'); const values = Array.isArray(item.value) ? item.value : isRecord(item.value) ? Object.values(item.value) : []; if (values.length > 1000) throw new Error('Native zone evidence exceeds the population limit'); for (const child of values) pending.push({ value: child, depth: item.depth + 1 }); }
  return { version: 1, kind: 'zones.emit', title: requiredText(value, 'title', 'Zone emission', 200), modelId: requiredText(value, 'modelId', 'Zone emission', 200), zoneSetId: requiredText(value, 'zoneSetId', 'Zone emission', 200), storey: { GlobalId, Name: value.storey.Name }, expected: value.expected };
}
export const ZONE_EMISSION_GUIDANCE = 'Existing genuinely evaluated zone sets can use version:1 kind:"zones.emit", title, explicit modelId, zoneSetId, storey:{GlobalId,Name}, and complete nativeZoneEmission expected snapshot. Choose an explicit current set and storey from available evidence; never choose the first/editing set implicitly or supply memberships/geometry. This emits the WHOLE set into ONLY that model. Current session marked outputs are replaced; imported source outputs remain. No automatic evaluation or writes: the native review card and Apply are required. Unavailable/truncated/stale evaluation, source, frame or prior-output evidence must refuse.';
