/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { HtmlTagDescriptor, Logger, Plugin } from 'vite';
import { featureCatalogueDocument } from '../src/lib/features/catalogue';

export const FEATURES_FILE = 'features.json';
const STOCK_ENTRY = 'src="/src/main.tsx"';
const HOSTED_ENTRY = 'src="/src/main-hosted.tsx"';

/**
 * What a host that deploys the viewer needs from the build.
 *
 * - `features.json` at the build's base path, next to `index.html`: the
 *   feature catalogue, so an administration page lists exactly the switches
 *   this build understands and never hardcodes an id. The dev server answers
 *   the same path.
 * - With `VITE_VIEWER_CONFIG_URL` set, `index.html` loads `main-hosted.tsx`
 *   instead of `main.tsx`: that entry requests the configuration before the
 *   viewer's code loads. Without it the stock entry is untouched.
 * - The hosted page also preloads the viewer's own chunks. The entry imports
 *   them dynamically, and an import starts no download before the entry runs;
 *   the entry, a module script, runs only after the page's stylesheets
 *   (the hosted icon font among them). Without the preload, the whole app
 *   started downloading about 400 ms later than in the stock build and first
 *   paint came about 170 ms later. A preloaded chunk that 404s after a deploy
 *   also trips the boot watchdog's fast path, which reloads the page.
 */
export function viewerHostConfig(): Plugin[] {
  const body = () => `${JSON.stringify(featureCatalogueDocument(), null, 2)}\n`;
  let base = '/';
  let hosted = false;
  let logger: Logger | undefined;
  const preload: Plugin = {
    name: 'ifc-lite-viewer-host-preload',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!hosted || context.path !== '/index.html' || !context.bundle) return html;
        // An absolute base ('/viewer/') or a CDN base ('https://cdn.example/viewer/')
        // prefixes every asset the way Vite's own tags and runtime do. A relative
        // base resolves against the page instead; rather than guess, preload nothing.
        if (!(base.startsWith('/') || /^([a-z][a-z0-9+.-]*:)?\/\//i.test(base))) {
          logger?.warn(`viewer-host-config: base "${base}" is relative; the hosted page does not preload the viewer's chunks.`);
          return html;
        }
        const chunks = Object.values(context.bundle).filter((output) => output.type === 'chunk');
        const viewer = chunks.find((chunk) => chunk.facadeModuleId?.endsWith('/src/bootstrap.tsx'));
        if (!viewer) throw new Error('viewer-host-config: no chunk for src/bootstrap.tsx in the hosted build');
        const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
        const files = new Set<string>();
        const styles = new Set<string>();
        const visit = (fileName: string) => {
          if (files.has(fileName)) return;
          files.add(fileName);
          const chunk = byFile.get(fileName);
          for (const css of chunk?.viteMetadata?.importedCss ?? []) styles.add(css);
          for (const imported of chunk?.imports ?? []) visit(imported);
        };
        visit(viewer.fileName);
        const tags: HtmlTagDescriptor[] = [
          ...[...files].filter((file) => !html.includes(file)).map((file) => ({
            tag: 'link', injectTo: 'head' as const, attrs: { rel: 'modulepreload', crossorigin: true, href: `${base}${file}` },
          })),
          // Preload, not a stylesheet link: a stylesheet would hold back the entry and so the request.
          ...[...styles].filter((file) => !html.includes(file)).map((file) => ({
            tag: 'link', injectTo: 'head' as const, attrs: { rel: 'preload', as: 'style', crossorigin: true, href: `${base}${file}` },
          })),
        ];
        return { html, tags };
      },
    },
  };
  return [preload, {
    name: 'ifc-lite-viewer-host-config',
    configResolved(config) {
      base = config.base;
      logger = config.logger;
      hosted = Boolean(config.env.VITE_VIEWER_CONFIG_URL);
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        // Only the viewer page; other HTML inputs (the E2E probe pages) keep their own scripts.
        if (!hosted || context.path !== '/index.html') return html;
        if (!html.includes(STOCK_ENTRY)) throw new Error(`index.html no longer loads ${STOCK_ENTRY}; update viewer-host-config.ts`);
        return html.replace(STOCK_ENTRY, HOSTED_ENTRY);
      },
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: FEATURES_FILE, source: body() });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? '').split('?')[0];
        if (pathname !== `${base}${FEATURES_FILE}`) return next();
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(body());
      });
    },
  }];
}
