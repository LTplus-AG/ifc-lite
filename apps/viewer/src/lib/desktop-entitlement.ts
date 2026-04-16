/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  getDefaultDesktopEntitlement,
  hasDesktopFeatureAccess,
  type DesktopEntitlement,
  type DesktopFeature,
} from './desktop-product';

type HasFn = ((params: { plan?: string; feature?: string }) => boolean) | undefined;

interface ResolveDesktopEntitlementOptions {
  userId: string | null;
  token: string | null;
  has: HasFn;
  publicMetadata: Record<string, unknown> | null | undefined;
  now?: number;
}

interface ResolvedDesktopEntitlement {
  entitlement: DesktopEntitlement;
  aiAssistantEnabled: boolean;
}

export function resolveDesktopEntitlement(options: ResolveDesktopEntitlementOptions): ResolvedDesktopEntitlement {
  // NOTE: `token`, `has`, `publicMetadata`, and `now` are accepted but
  // intentionally unused in this implementation. They are kept for future
  // extensibility if a desktop-specific entitlement provider is added.
  const { userId } = options;
  const entitlement: DesktopEntitlement = {
    ...getDefaultDesktopEntitlement(),
    userId,
  };
  const aiAssistantEnabled = hasDesktopFeatureAccess(entitlement, 'ai_assistant');
  return { entitlement, aiAssistantEnabled };
}

export function canUseDesktopFeatureOffline(entitlement: DesktopEntitlement, feature: DesktopFeature, now = Date.now()): boolean {
  void now;
  return hasDesktopFeatureAccess(entitlement, feature);
}
