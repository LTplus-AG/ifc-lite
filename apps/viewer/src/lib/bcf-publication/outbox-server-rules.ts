/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What publication must know about a server beyond the BCF API: the parts of
 * its profile (`services/bcf-server-profiles.ts`) that change how topics are
 * listed and what a topic keeps, plus the coordinator's choice of topic type
 * where the server's fixed list lacks the draft's. A server without a
 * profile follows the BCF API.
 */

import { bcfServerProfile, type BcfServerProfile } from '../../services/bcf-server-profiles.js';
import type { PreflightReport } from './outbox-preflight.js';

export type PublicationServerRules = Partial<Pick<BcfServerProfile, 'topicPaging' | 'topicStatusTypes'>>;

/** Draft topic type to the server type the coordinator publishes it as. */
export type TopicTypeChoice = Readonly<Record<string, string>>;

/** The connection's own rules when it carries them, else its server's profile. */
export function publicationRules(connection: { serverUrl: string; rules?: PublicationServerRules | null }): PublicationServerRules {
  return connection.rules ?? bcfServerProfile(connection.serverUrl) ?? {};
}

/**
 * The write as this server can keep it: the chosen server type in place of an
 * unknown draft type, and no status for a type that keeps none (returned as
 * `withheld`, so preflight can say it was not sent).
 */
export function adaptTopicWrite(write: Record<string, unknown>, rules: PublicationServerRules, topicTypes: TopicTypeChoice):
  { write: Record<string, unknown>; withheld?: Record<string, unknown> } {
  const draftType = write.topic_type;
  const chosen = typeof draftType === 'string' && Object.hasOwn(topicTypes, draftType) ? topicTypes[draftType] : undefined;
  const typed = chosen ? { ...write, topic_type: chosen } : write;
  const status = typed.topic_status;
  if (!rules.topicStatusTypes || status === undefined || status === null || rules.topicStatusTypes.includes(String(typed.topic_type))) {
    return { write: typed };
  }
  const { topic_status: _status, ...kept } = typed;
  return { write: kept, withheld: { topic_status: status } };
}

/**
 * The server type to preselect for a draft type it lacks: a case-only
 * difference, then a type naming the draft type, then (for clash and issue
 * drafts) a type naming an issue, such as buildagil's `Model Issue`, else the
 * server's first type.
 */
export function closestTopicType(type: string, allowed: readonly string[]): string | undefined {
  const wanted = type.trim().toLowerCase();
  const named = (word: string) => allowed.find(item => item.toLowerCase().split(/\W+/).includes(word));
  return allowed.find(item => item.toLowerCase() === wanted)
    ?? (wanted ? named(wanted) : undefined)
    ?? (wanted === 'clash' || wanted === 'issue' ? named('issue') : undefined)
    ?? allowed[0];
}

/** Draft topic types the preflight found missing from the server's topic type list, with that list. */
export function unknownTopicTypes(report: PreflightReport | null): Array<{ type: string; allowed: string[] }> {
  const found = new Map<string, string[]>();
  for (const issue of report?.issues ?? []) {
    if (issue.kind === 'vocabulary' && issue.field === 'topic_type' && issue.value && issue.allowed?.length) found.set(issue.value, issue.allowed);
  }
  return [...found].map(([type, allowed]) => ({ type, allowed }));
}

/** Keep valid earlier choices; preselect the closest server type for every other unknown draft type. */
export function preselectTopicTypes(report: PreflightReport | null, current: TopicTypeChoice): TopicTypeChoice {
  const next: Record<string, string> = { ...current };
  for (const { type, allowed } of unknownTopicTypes(report)) {
    const choice = allowed.includes(next[type] ?? '') ? next[type] : closestTopicType(type, allowed);
    if (choice) next[type] = choice;
  }
  return next;
}
