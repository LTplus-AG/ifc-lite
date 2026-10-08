/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF topic drafts from coordination cards (P18, #6922), through the native
 * draft batch model (#6911): one topic per card. Clash findings become exact
 * draft members (framed by the clash BCF bridge); other evidence is listed in
 * the description and its validated elements are selected in the viewpoint.
 * Cards that already reference a BCF topic, or hold only historical evidence,
 * are excluded and reported, never drafted silently.
 */

import type { BCFPoint, BCFViewpoint } from '@ifc-lite/bcf';
import type { Clash } from '@ifc-lite/clash';
import { draftTopic, findingFromClash } from '../bcf-drafts/draft-create';
import { digestStrings } from '../bcf-drafts/draft-footer';
import { DRAFT_LIMITS, type DraftBatch, type DraftTopic } from '../bcf-drafts/draft-types';
import type { CoordinationCard } from './cards';

export type CardDraftExclusion = { cardKey: string; reason: 'has-topic' | 'not-current' };
export interface CardDraftResult { batch: DraftBatch | null; exclusions: CardDraftExclusion[] }

/** Stable, compact reference to a card's durable identity for the topic origin. */
export function cardDigest(card: Pick<CoordinationCard, 'key'>): string {
  return digestStrings([card.key]);
}

export function cardTitle(card: CoordinationCard): string {
  const named = card.elements.map(element => element.name ? `${element.ifcType ?? 'IFC'} ${element.name}` : element.ifcType ?? element.globalId);
  return [...new Set(named)].slice(0, 3).join(' · ') || card.findings[0]?.title || 'Coordination card';
}

export function cardDescription(card: CoordinationCard): string {
  const lines = [`Coordination review card: ${card.findings.length} finding(s) from ${card.sources.join(', ')}.`, ''];
  for (const finding of card.findings) {
    lines.push(`- [${finding.source}, ${finding.run.temporal}: ${finding.run.label}] ${finding.title} · native status ${finding.nativeStatus || 'n/a'}`);
    for (const detail of finding.detail.slice(0, 3)) lines.push(`  ${detail}`);
  }
  lines.push('', `Elements: ${card.elements.map(element => `${element.globalId}${element.modelName ? ` (${element.modelName})` : ''}`).join(', ')}`);
  const text = lines.join('\n');
  return text.length > DRAFT_LIMITS.description ? `${text.slice(0, DRAFT_LIMITS.description - 2)}\n…` : text;
}

function selectionViewpoint(card: CoordinationCard): BCFViewpoint | undefined {
  const selection = card.elements.flatMap(element => element.key ? [{ ifcGuid: element.globalId }] : []);
  return selection.length ? { guid: crypto.randomUUID(), components: { selection } } : undefined;
}

/**
 * @param liveClashes the current clash run; members are taken from it by id, so
 *   a card whose clash is no longer in the live run cannot carry a stale member.
 */
export async function draftBatchFromCards(name: string, cards: readonly CoordinationCard[], liveClashes: readonly Clash[],
  options: { worldOffset?: BCFPoint; now?: () => Date } = {}): Promise<CardDraftResult> {
  const exclusions: CardDraftExclusion[] = [];
  const byId = new Map(liveClashes.map(clash => [clash.id, clash]));
  const topics: DraftTopic[] = [];
  for (const card of cards) {
    if (card.topics.length) { exclusions.push({ cardKey: card.key, reason: 'has-topic' }); continue; }
    if (card.state !== 'current') { exclusions.push({ cardKey: card.key, reason: 'not-current' }); continue; }
    const members = card.findings.flatMap(finding => {
      if (finding.evidence.kind !== 'clash' || finding.run.temporal !== 'current') return [];
      const clash = byId.get(finding.evidence.clashId);
      return clash ? [findingFromClash(clash)] : [];
    });
    const topic = await draftTopic(cardTitle(card), members, { kind: 'review', card: cardDigest(card) }, options.worldOffset);
    topic.description = cardDescription(card);
    if (members.length === 0) {
      // No clash member: no severity to map, and no clash bounds to frame.
      topic.topicType = 'Issue';
      delete topic.priority;
      const viewpoint = selectionViewpoint(card);
      if (viewpoint) topic.viewpoint = viewpoint;
    }
    topics.push(topic);
  }
  if (topics.length === 0) return { batch: null, exclusions };
  const at = (options.now?.() ?? new Date()).toISOString();
  const findingCount = topics.reduce((count, topic) => count + topic.members.length, 0);
  return { exclusions, batch: { version: 1, id: crypto.randomUUID(), name: name.trim().slice(0, 200) || 'Coordination review', createdAt: at,
    modifiedAt: at, topics, source: { kind: 'review', runDigest: digestStrings(cards.map(card => card.key)), rules: [], findingCount, capturedAt: at,
      ...(options.worldOffset ? { worldOffset: { ...options.worldOffset } } : {}) } } };
}
