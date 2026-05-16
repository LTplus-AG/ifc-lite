/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Audit event types.
 *
 * The audit log captures security-relevant lifecycle events for
 * extensions. Records are append-only, local-only, and capped by both
 * count and byte size.
 *
 * What goes in:
 *   - install / uninstall / update
 *   - capability grant / revoke
 *   - activation / deactivation
 *   - mutation summary (count + scope, never content)
 *   - network fetch (URL + status + byte count, never body)
 *   - unhealthy / killed extension events
 *
 * What does NOT go in:
 *   - model content
 *   - chat content
 *   - file contents
 *   - BYOK keys (by construction; the log never sees them)
 *
 * Spec: docs/architecture/ai-customization/02-security.md §12.
 */

export type AuditEventKind =
  | 'install'
  | 'uninstall'
  | 'update'
  | 'enable'
  | 'disable'
  | 'capability_grant'
  | 'capability_revoke'
  | 'activate'
  | 'deactivate'
  | 'mutation_summary'
  | 'network_fetch'
  | 'unhealthy'
  | 'killed';

export interface AuditEventBase {
  /** Monotonic-ish ID assigned by the log; useful for cursor pagination. */
  seq: number;
  /** ISO timestamp the log writes; not user-supplied. */
  ts: string;
  /** Stable event kind. */
  kind: AuditEventKind;
  /** Extension this event pertains to. */
  extensionId: string;
  /** Optional version (where relevant). */
  version?: string;
}

export interface InstallEvent extends AuditEventBase {
  kind: 'install' | 'uninstall' | 'update';
  /** For install/update only: granted capability set. */
  grantedCapabilities?: string[];
  /** For update only: the previous version. */
  previousVersion?: string;
}

export interface EnableEvent extends AuditEventBase {
  kind: 'enable' | 'disable';
}

export interface CapabilityChangeEvent extends AuditEventBase {
  kind: 'capability_grant' | 'capability_revoke';
  capabilities: string[];
}

export interface ActivationEvent extends AuditEventBase {
  kind: 'activate' | 'deactivate';
  /** The activation event id that triggered this activation. */
  trigger?: string;
}

export interface MutationSummaryEvent extends AuditEventBase {
  kind: 'mutation_summary';
  /** Number of entities affected. */
  entityCount: number;
  /** Property-set patterns touched. */
  psetPatterns: string[];
}

export interface NetworkFetchEvent extends AuditEventBase {
  kind: 'network_fetch';
  host: string;
  status: number;
  bytes: number;
}

export interface HealthEvent extends AuditEventBase {
  kind: 'unhealthy' | 'killed';
  /** Short, plain-text reason. No content. */
  reason: string;
}

export type AuditEvent =
  | InstallEvent
  | EnableEvent
  | CapabilityChangeEvent
  | ActivationEvent
  | MutationSummaryEvent
  | NetworkFetchEvent
  | HealthEvent;

export interface AuditFilter {
  extensionId?: string;
  kind?: AuditEventKind;
  /** Inclusive lower bound on `seq`. */
  sinceSeq?: number;
  /** Inclusive upper bound on `seq`. */
  untilSeq?: number;
}
