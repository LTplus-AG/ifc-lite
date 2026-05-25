/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type DesktopPlanTier = 'free' | 'pro';
export type DesktopEntitlementStatus = 'anonymous' | 'signed_out' | 'active' | 'trial' | 'expired' | 'grace_offline';
export type DesktopEntitlementSource = 'anonymous' | 'clerk_claims' | 'cached';

export type DesktopFeature =
  | 'viewer_basic'
  | 'workspace_restore'
  | 'exports'
  | 'ids_validation'
  | 'bcf_issue_management'
  | 'ai_assistant'
  | 'extensions';

export interface DesktopEntitlement {
  tier: DesktopPlanTier;
  status: DesktopEntitlementStatus;
  source: DesktopEntitlementSource;
  userId: string | null;
  validatedAt: number | null;
  graceUntil: number | null;
  trialEndsAt: number | null;
}

export interface DesktopUsageSummary {
  type: 'credits' | 'requests';
  used: number;
  limit: number;
  pct?: number;
  resetAt?: number;
}

interface DesktopFeatureDefinition {
  label: string;
  description: string;
  free: boolean;
}

const DESKTOP_FEATURES: Record<DesktopFeature, DesktopFeatureDefinition> = {
  viewer_basic: {
    label: 'Viewer features',
    description: 'Core model viewing and inspection capabilities.',
    free: true,
  },
  workspace_restore: {
    label: 'Workspace restore',
    description: 'Host-provided workspace persistence features.',
    free: true,
  },
  exports: {
    label: 'Exports',
    description: 'Host-provided export integrations.',
    free: true,
  },
  ids_validation: {
    label: 'IDS validation',
    description: 'Host-provided IDS workflows.',
    free: true,
  },
  bcf_issue_management: {
    label: 'BCF issue management',
    description: 'Host-provided BCF workflows.',
    free: true,
  },
  ai_assistant: {
    label: 'Host AI assistant',
    description: 'Optional host-provided AI integrations.',
    free: true,
  },
  extensions: {
    label: 'Extensions & flavors',
    description: 'Install user-authored extensions, manage flavors, and access the authoring loop.',
    free: true,
  },
};

export function isDesktopBillingEnforced(): boolean {
  return false;
}

export function getDesktopPlanTier(entitlementOrHasPro: DesktopEntitlement | boolean): DesktopPlanTier {
  return typeof entitlementOrHasPro === 'boolean'
    ? (entitlementOrHasPro ? 'pro' : 'free')
    : entitlementOrHasPro.tier;
}

export function hasDesktopPro(entitlementOrHasPro: DesktopEntitlement | boolean): boolean {
  return getDesktopPlanTier(entitlementOrHasPro) === 'pro';
}

export function hasDesktopFeatureAccess(entitlementOrHasPro: DesktopEntitlement | boolean, feature: DesktopFeature): boolean {
  return hasDesktopPro(entitlementOrHasPro) || DESKTOP_FEATURES[feature].free;
}

export function getDesktopFeatureCatalog(entitlementOrHasPro: DesktopEntitlement | boolean) {
  return (Object.entries(DESKTOP_FEATURES) as Array<[DesktopFeature, DesktopFeatureDefinition]>).map(([key, value]) => ({
    key,
    ...value,
    enabled: hasDesktopFeatureAccess(entitlementOrHasPro, key),
  }));
}

export function buildDesktopUpgradeUrl(returnTo?: string): string {
  const fallbackReturnTo = typeof window !== 'undefined'
    ? `${window.location.pathname}${window.location.search}`
    : '/';
  const nextReturnTo = returnTo ?? fallbackReturnTo;
  return `/upgrade?returnTo=${encodeURIComponent(nextReturnTo)}`;
}

export function getDefaultDesktopEntitlement(): DesktopEntitlement {
  return {
    tier: 'free',
    status: 'anonymous',
    source: 'anonymous',
    userId: null,
    validatedAt: null,
    graceUntil: null,
    trialEndsAt: null,
  };
}

export function getDesktopPlanSummary(entitlementOrHasPro: DesktopEntitlement | boolean, usage: DesktopUsageSummary | null): string {
  void entitlementOrHasPro;
  void usage;
  return 'Desktop entitlements are host-defined and disabled in the open-source web viewer build.';
}
