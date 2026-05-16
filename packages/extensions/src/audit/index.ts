/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { AuditLog, type AuditLogOptions } from './log.js';
export type {
  AuditEvent,
  AuditEventBase,
  AuditEventKind,
  AuditFilter,
  InstallEvent,
  EnableEvent,
  CapabilityChangeEvent,
  ActivationEvent as AuditActivationEvent,
  MutationSummaryEvent,
  NetworkFetchEvent,
  HealthEvent,
} from './types.js';
