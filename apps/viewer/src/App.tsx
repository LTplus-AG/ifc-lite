/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main application component
 */

import { ViewerLayout } from './components/viewer/ViewerLayout';
import { SettingsPage } from './components/viewer/SettingsPage';
import { UpgradePage } from './components/viewer/UpgradePage';
import { BimProvider } from './sdk/BimProvider';
import { Toaster } from './components/ui/toast';
import { ClerkChatSync } from './lib/llm/ClerkChatSync';
import { isClerkConfigured } from './lib/llm/clerk-auth';
import { useEffect, useState } from 'react';

export function App() {
  const clerkEnabled = isClerkConfigured();
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onRouteChange = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onRouteChange);
    return () => window.removeEventListener('popstate', onRouteChange);
  }, []);

  const isUpgradeRoute = pathname === '/upgrade';
  const isSettingsRoute = pathname === '/settings';

  return (
    <BimProvider>
      {clerkEnabled && <ClerkChatSync />}
      {isUpgradeRoute ? <UpgradePage /> : isSettingsRoute ? <SettingsPage /> : <ViewerLayout />}
      <Toaster />
    </BimProvider>
  );
}

export default App;
