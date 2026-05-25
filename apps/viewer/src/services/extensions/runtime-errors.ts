/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Helpers for turning runtime errors thrown by extension command
 * execution into user-facing messages. The sandbox throws
 * `CapabilityDeniedError` (and friends) by `.name`; we don't want
 * every callsite re-implementing the discrimination, and we want a
 * single place to refine the wording when we revisit copy.
 */

export function describeRunCommandError(commandId: string, err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as { name?: string }).name;
    const message = err instanceof Error ? err.message : String(err);
    if (name === 'CapabilityDeniedError') {
      return (
        `"${commandId}" tried to use a capability that wasn't granted. ` +
        `Re-install with the missing capability checked, or skip this action. (${message})`
      );
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Failed to run "${commandId}": ${message}`;
}
