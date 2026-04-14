/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PricingTable, SignInButton, SignedIn, SignedOut } from '@clerk/clerk-react';
import { useCallback, useEffect, useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { hasDesktopPro } from '@/lib/desktop-product';
import { navigateToPath } from '@/services/app-navigation';

export function UpgradePage() {
  const desktopEntitlement = useViewerStore((s) => s.desktopEntitlement);
  const chatHasPro = useViewerStore((s) => s.chatHasPro);
  const hasPro = chatHasPro || hasDesktopPro(desktopEntitlement);
  const returnTo = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const candidate = params.get('returnTo');
    return candidate && candidate.startsWith('/') ? candidate : '/';
  }, []);
  const upgradeRedirectUrl = useMemo(
    () => `/upgrade?returnTo=${encodeURIComponent(returnTo)}`,
    [returnTo],
  );

  const navigateBack = useCallback(() => {
    navigateToPath(returnTo, { replace: true });
  }, [returnTo]);

  // Automatically return to the previous app view once upgrade is active.
  useEffect(() => {
    if (!hasPro) return;
    const timer = window.setTimeout(() => {
      navigateBack();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [hasPro, navigateBack]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={navigateBack}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Viewer
          </Button>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h1 className="text-2xl font-semibold">Upgrade to Pro</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Free keeps the core desktop viewer available. Pro unlocks advanced desktop features, plus the AI assistant with the same monthly limits and routing used on web.
          </p>

          <div className="mt-6">
            <SignedOut>
              <div className="flex items-center justify-center py-12">
                <SignInButton
                  mode="modal"
                  fallbackRedirectUrl={upgradeRedirectUrl}
                  forceRedirectUrl={upgradeRedirectUrl}
                >
                  <Button>Sign in to continue</Button>
                </SignInButton>
              </div>
            </SignedOut>
            <SignedIn>
              <PricingTable />
            </SignedIn>
          </div>
        </div>
      </div>
    </div>
  );
}
