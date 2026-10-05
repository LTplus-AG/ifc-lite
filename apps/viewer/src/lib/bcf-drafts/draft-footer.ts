/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The draft mapping travels in a generated description footer (#6896): plain
 * text every BCF tool and BCF API server already preserves, unlike labels or
 * snippet types, which a project's extensions may restrict. Archives carry
 * the full member list so a reimport restores the finding <-> topic mapping;
 * server publication carries only the batch, topic and member digest, which
 * is what reconciliation needs to recognise its own topic after a lost
 * response.
 */

import { decodeFinding, isRecord } from './draft-codec.js';
import { findingIdentity, type DraftFinding, type DraftOrigin, type DraftTopic } from './draft-types.js';

export const DRAFT_FOOTER_MARKER = '-- ifc-lite BCF draft mapping v1 (generated; do not edit below) --';

/** Order-independent 64-bit FNV-1a digest (two 32-bit lanes) of a set of strings. */
export function digestStrings(values: readonly string[]): string {
  const text = [...values].sort().join('\n');
  let low = 0x811c9dc5, high = 0xcbf29ce4;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ (code + index), 0x01000193) >>> 0;
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}

export function membersDigest(members: readonly Pick<DraftFinding, 'reviewKey' | 'occurrenceKey'>[]): string {
  return digestStrings(members.map(member => `${findingIdentity(member)}\u0000${member.reviewKey}`));
}

export interface FooterOptions {
  batchId: string;
  /** Archive footers also carry the batch name, origin and every member. */
  full?: { batchName: string; source: unknown };
}

export function draftFooter(topic: DraftTopic, options: FooterOptions): string {
  const lines = [DRAFT_FOOTER_MARKER, `batch: ${encodeURIComponent(options.batchId)}`, `topic: ${topic.guid}`,
    `members: ${topic.members.length} ${membersDigest(topic.members)}`];
  if (options.full) {
    lines.push(`batch-name: ${encodeURIComponent(options.full.batchName)}`,
      `source: ${encodeURIComponent(JSON.stringify(options.full.source))}`,
      `origin: ${encodeURIComponent(JSON.stringify(topic.origin))}`);
    for (const member of topic.members) lines.push(`m: ${encodeURIComponent(JSON.stringify(member))}`);
  }
  return lines.join('\n');
}

export function describeWithFooter(topic: DraftTopic, options: FooterOptions): string {
  const human = topic.description.trim();
  return `${human ? `${human}\n\n` : ''}${draftFooter(topic, options)}`;
}

export interface ParsedFooter {
  /** The description above the footer, as a human wrote it. */
  human: string;
  batchId: string;
  topicGuid: string;
  memberCount: number;
  digest: string;
  batchName?: string;
  source?: unknown;
  origin?: DraftOrigin;
  /** Present only for archive footers; validated and consistent with the digest. */
  members?: DraftFinding[];
}

function json(text: string): unknown {
  try { return JSON.parse(decodeURIComponent(text)); }
  catch (error) { console.warn('[BCF drafts] Unreadable footer value', error); return undefined; }
}

/**
 * Parse a generated footer. Returns null for a plain description or a footer
 * that was edited into inconsistency (member lines not matching the digest):
 * a damaged mapping is reported as unmapped, never half-trusted.
 */
export function parseDraftFooter(description: string | undefined): ParsedFooter | null {
  if (!description) return null;
  const at = description.lastIndexOf(DRAFT_FOOTER_MARKER);
  if (at < 0) return null;
  const human = description.slice(0, at).trim();
  const fields = new Map<string, string>();
  const memberLines: string[] = [];
  for (const line of description.slice(at + DRAFT_FOOTER_MARKER.length).split('\n')) {
    const match = /^([a-z-]+): (.*)$/.exec(line.trim());
    if (!match) continue;
    if (match[1] === 'm') memberLines.push(match[2]);
    else fields.set(match[1], match[2]);
  }
  const counted = /^(\d+) ([0-9a-f]{16})$/.exec(fields.get('members') ?? '');
  const batch = fields.get('batch'), topic = fields.get('topic');
  if (!counted || !batch || !topic) return null;
  let batchId: string;
  try { batchId = decodeURIComponent(batch); }
  catch (error) { console.warn('[BCF drafts] Unreadable batch id in footer', error); return null; }
  const parsed: ParsedFooter = { human, batchId, topicGuid: topic, memberCount: Number(counted[1]), digest: counted[2] };
  const name = fields.get('batch-name');
  if (name !== undefined) {
    try { parsed.batchName = decodeURIComponent(name); }
    catch (error) { console.warn('[BCF drafts] Unreadable batch name in footer', error); }
  }
  if (fields.has('source')) parsed.source = json(fields.get('source') ?? '');
  const origin = fields.has('origin') ? json(fields.get('origin') ?? '') : undefined;
  if (isRecord(origin) && (origin.kind === 'selection' || origin.kind === 'archive')) parsed.origin = { kind: origin.kind };
  if (isRecord(origin) && origin.kind === 'group' && typeof origin.workspaceId === 'string' && typeof origin.groupId === 'string') {
    parsed.origin = { kind: 'group', workspaceId: origin.workspaceId, groupId: origin.groupId };
  }
  if (memberLines.length > 0 || fields.has('batch-name')) {
    const members = memberLines.map(line => decodeFinding(json(line)));
    if (members.some(member => !member)) return null;
    const valid = members.flatMap(member => member ? [member] : []);
    if (valid.length !== parsed.memberCount || membersDigest(valid) !== parsed.digest) return null;
    parsed.members = valid;
  }
  return parsed;
}
