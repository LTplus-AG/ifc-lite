/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Capability } from '@ifc-lite/extensions';
import type { FetchTransport } from '@ifc-lite/sandbox';
import type { BcfWriteGateway, BcfWriteIntent } from './bcf-write-gateway.js';
import type { BcfPublicationFailure } from './bcf-publication.js';

export interface NativeBcfPublicationOptions {
  directory?: string;
  /** Storage isolation, e.g. a stable authenticated MCP principal. Never a credential. */
  namespace?: string;
  /** Known run secrets: an intent containing one is refused before persistence. */
  secrets?: readonly string[];
}
export interface NativeBcfPublicationCheckOptions {
  token?: string;
  networkGrants: readonly Capability[];
  signal?: AbortSignal;
  networkTransport?: FetchTransport;
  /** Operator confirms an unverifiable owner stopped; never overrides an observed live process. */
  confirmOwnerStopped?: boolean;
  /** Operator asserts this read sees the complete target collection in the original write access scope. */
  confirmFullReadAccess?: boolean;
}
export type NativeBcfOwnerStatus = 'alive' | 'dead' | 'unknown';
export interface NativeBcfPublicationCheck {
  at: string;
  /** A match remains a candidate until an explicit reconciliation. */
  result: 'ambiguous' | 'absent' | 'unavailable';
  candidates: { guid: string }[];
  /** Present only on complete absence proven under an explicit full-visibility assertion. */
  fullReadAccessConfirmed?: true;
}
export interface NativeBcfPublicationEntry {
  id: string;
  intent: BcfWriteIntent;
  state: 'sending' | 'uncertain' | 'failed' | 'done';
  queuedAt: string;
  receipt?: { remoteGuid: string; at: string; evidence: 'response' | 'reconciled' };
  failure?: BcfPublicationFailure;
  check?: NativeBcfPublicationCheck;
  ownerStatus?: NativeBcfOwnerStatus;
}
export interface NativeBcfPublicationPage {
  entries: NativeBcfPublicationEntry[];
  nextCursor?: string;
}
export interface NativeBcfPublicationPageOptions { cursor?: string; limit?: number }
export interface NativeBcfWriteGateway extends BcfWriteGateway {
  list(): Promise<NativeBcfPublicationEntry[]>;
  listPage(options?: NativeBcfPublicationPageOptions): Promise<NativeBcfPublicationPage>;
  check(entryId: string, options: NativeBcfPublicationCheckOptions): Promise<NativeBcfPublicationEntry>;
  reconcile(entryId: string, candidateGuid: string): Promise<NativeBcfPublicationEntry>;
  /** Explicitly release an unresolved intent after the latest successful check found no effect. */
  confirmAbsent(entryId: string): Promise<NativeBcfPublicationEntry>;
}

/** Stored immutable attempt; PID ownership is conservative and never stolen. */
export interface StoredBcfAttempt {
  version: 1;
  id: string;
  digest: string;
  generation: number;
  intent: BcfWriteIntent;
  queuedAt: string;
  owner: { pid: number; host: string; boot?: string; domain?: string; instance?: string };
}
export interface StoredBcfOwnerConfirmation {
  version: 1;
  id: string;
  digest: string;
  at: string;
  assertion: 'owner-stopped';
}
export interface StoredBcfOutcome {
  version: 1;
  id: string;
  digest: string;
  state: 'done' | 'failed' | 'uncertain';
  receipt?: NativeBcfPublicationEntry['receipt'];
  failure?: BcfPublicationFailure;
}
export interface StoredBcfCheck {
  version: 1;
  id: string;
  digest: string;
  checkId: string;
  check: NativeBcfPublicationCheck;
  settlement?: { outcome: StoredBcfOutcome; proofCheckId: string };
}
