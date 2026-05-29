/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main application component.
 *
 * Routing is intentionally lo-fi (no router lib): we read window.location.pathname
 * at boot, react to popstate, and switch by prefix. The handful of routes:
 *
 *   /                  → main WebGL viewer (default)
 *   /settings          → desktop-shell account / API-key management (Tauri)
 *   /mcp[/...]         → @ifc-lite/mcp marketing surface
 */

import { ViewerLayout } from './components/viewer/ViewerLayout';
import { SettingsPage } from './components/viewer/SettingsPage';
import { McpLanding } from './components/mcp/McpLanding';
import { McpPlayground } from './components/mcp/McpPlayground';
import { BimProvider } from './sdk/BimProvider';
import { ExtensionHostProvider } from './sdk/ExtensionHostProvider';
import { Toaster } from './components/ui/toast';
import { useEffect, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';

export function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onRouteChange = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onRouteChange);
    return () => window.removeEventListener('popstate', onRouteChange);
  }, []);

  // /mcp lives outside BimProvider — it’s a pure marketing surface that
  // doesn’t need the WASM viewer context. Skips a chunky dependency boot
  // so cold-loading the landing page is cheap. /mcp/playground does parse
  // IFCs in-browser, but uses its own minimal pipeline (parser → headless
  // backend → BimContext) rather than the full viewer stack.
  //
  // Normalise the trailing slash before matching so `/mcp/playground/`
  // (e.g. shared from a browser address bar that auto-appends `/`) hits
  // the playground branch instead of falling through to the landing.
  const normalizedPath = pathname.length > 1 && pathname.endsWith('/')
    ? pathname.slice(0, -1)
    : pathname;
  if (normalizedPath === '/mcp/playground') {
    return (
      <>
        <McpPlayground />
        <Toaster />
        <Analytics />
      </>
    );
  }
  if (normalizedPath === '/mcp' || normalizedPath.startsWith('/mcp/')) {
    return (
      <>
        <McpLanding />
        <Toaster />
        <Analytics />
      </>
    );
  }

  return (
    <BimProvider>
      <ExtensionHostProvider>
        {pathname === '/settings' ? <SettingsPage /> : <ViewerLayout />}
        <Toaster />
        <Analytics />
      </ExtensionHostProvider>
    </BimProvider>
  );
}

export default App;
