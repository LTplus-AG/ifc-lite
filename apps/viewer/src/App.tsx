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
 *   /mcp[/...]         → @ifc-lite/mcp marketing surface
 */

import { ViewerLayout } from './components/viewer/ViewerLayout';
import { BimProvider } from './sdk/BimProvider';
import { ExtensionHostProvider } from './sdk/ExtensionHostProvider';
import { Toaster } from './components/ui/toast';
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary';
import { Suspense, lazy, useEffect, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';

// The /mcp marketing surface pulls in three.js (HeroScene / PlaygroundViewer)
// and its own component tree — none of which the main `/` viewer route needs.
// Statically importing McpLanding/McpPlayground dragged all of it into the
// entry's static import graph, so `/` preloaded three.js (~140 KB br) and the
// marketing chunks on every first paint. Loading these two roots lazily moves
// three.js + the marketing code into their own async chunks, off the `/`
// critical path. ViewerLayout stays static — it IS the `/` route, so keeping it
// eager avoids an extra round-trip for the overwhelmingly common case.
const McpLanding = lazy(() =>
  import('./components/mcp/McpLanding').then((m) => ({ default: m.McpLanding })),
);
const McpPlayground = lazy(() =>
  import('./components/mcp/McpPlayground').then((m) => ({ default: m.McpPlayground })),
);

// Neutral full-viewport placeholder while a lazy MCP route chunk loads. Both
// /mcp routes render on a near-black stage (McpLanding's `NIGHT` = #0a0a0c), so
// matching it here means the async chunk resolves with no color flash.
function RouteFallback() {
  return <div style={{ minHeight: '100vh', background: '#0a0a0c' }} />;
}

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
        <ChunkErrorBoundary label="MCP playground" tone="night">
          <Suspense fallback={<RouteFallback />}>
            <McpPlayground />
          </Suspense>
        </ChunkErrorBoundary>
        <Toaster />
        <Analytics />
      </>
    );
  }
  if (normalizedPath === '/mcp' || normalizedPath.startsWith('/mcp/')) {
    return (
      <>
        <ChunkErrorBoundary label="MCP page" tone="night">
          <Suspense fallback={<RouteFallback />}>
            <McpLanding />
          </Suspense>
        </ChunkErrorBoundary>
        <Toaster />
        <Analytics />
      </>
    );
  }

  return (
    <BimProvider>
      <ExtensionHostProvider>
        <ViewerLayout />
        <Toaster />
        <Analytics />
      </ExtensionHostProvider>
    </BimProvider>
  );
}

export default App;
