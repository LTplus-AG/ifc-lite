/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Start for a build that names a configuration URL
 * (`VITE_VIEWER_CONFIG_URL`, entry `main-hosted.tsx`): fetch the host's
 * configuration while the viewer's code downloads, then mount.
 *
 * It mounts with the configuration or not at all. When the fetch fails or
 * times out the page shows why and offers a reload; it never falls back to
 * the unconfigured viewer, because that would show a restricted deployment's
 * users every feature the host switched off.
 *
 * Stale deploys have one mechanism, the boot watchdog in `index.html`: it
 * clears the deployment pin and keeps its own reload budget. So `#root` stays
 * empty until the viewer mounts or the configuration fails, and a viewer
 * chunk that stalls or fails to load is left to the watchdog. The
 * configuration request times out (15 s) and the error screen's translations
 * are bounded (3 s), both inside the watchdog's 30 s backstop, so a slow
 * endpoint is never mistaken for a failed boot. Only when the watchdog has
 * not healed a failed viewer load (its budget is spent) does a screen say
 * that the viewer could not be loaded.
 *
 * The screen is plain DOM, not the app's `Button`, and the translations load
 * only for it: this module runs before the viewer's code has arrived, and
 * anything it imports statically delays the configuration request.
 */

import type { TranslationKey, TranslationParameters } from '@/i18n';
import { loadViewerRuntimeConfig, ViewerConfigError, type ViewerRuntimeConfig } from './runtime-config';

export type Translate = (key: TranslationKey, params?: TranslationParameters) => string;

/** The part of `bootstrap.tsx` the hosted start drives. */
export interface HostedViewer {
  prepareViewer(): void;
  mountViewer(container: HTMLElement, options: { config: ViewerRuntimeConfig }): void;
}

export interface HostStartDeps {
  /** `import('../../bootstrap')`, started at once so it overlaps the configuration request. */
  loadViewer: () => Promise<HostedViewer>;
  fetch: typeof fetch;
  /** The page's `location.href`. */
  pageUrl: string;
  reload: () => void;
  /**
   * The translator for the error screen, after negotiating the browser's
   * languages. Loaded only on failure; the viewer never mounts after it.
   */
  loadTranslator: () => Promise<Translate>;
  timeoutMs?: number;
  /** How long the error screen waits for its translations before showing English. */
  translatorTimeoutMs?: number;
  /** How long a failed viewer load is left to the boot watchdog before its own screen shows. */
  watchdogGraceMs?: number;
}

const TRANSLATOR_TIMEOUT_MS = 3_000;
/** The watchdog's backstop fires 30 s after `load`; this comes after it, so it only shows when the watchdog gave up. */
const WATCHDOG_GRACE_MS = 35_000;

/** A failure of the viewer's own code, as opposed to its configuration. */
class ViewerLoadFailure extends Error {
  constructor(cause: unknown) {
    super('The viewer code could not be loaded', { cause });
    this.name = 'ViewerLoadFailure';
  }
}

type ScreenKey = 'viewerShell.hostConfig.errorTitle' | 'viewerShell.hostConfig.errorBody'
  | 'viewerShell.hostConfig.viewerLoadTitle' | 'viewerShell.hostConfig.viewerLoadBody'
  | 'viewerShell.hostConfig.errorDetail' | 'viewerShell.chunkError.reload';

/**
 * The screen in English for when the translations themselves fail to load
 * (the same outage that broke the start). The same text as the catalogue,
 * which a test pins; never a placeholder that leaves the page blank.
 */
export const FALLBACK_TEXT: Readonly<Record<ScreenKey, string>> = {
  'viewerShell.hostConfig.errorTitle': 'The viewer could not start',
  'viewerShell.hostConfig.errorBody': 'Its settings could not be loaded, so nothing is shown. Reload the page. If this keeps happening, tell the people who run this site.',
  'viewerShell.hostConfig.viewerLoadTitle': 'The viewer could not be loaded',
  'viewerShell.hostConfig.viewerLoadBody': 'Its program files could not be downloaded, so nothing is shown. Reload the page. If this keeps happening, tell the people who run this site.',
  'viewerShell.hostConfig.errorDetail': 'Technical detail: {detail}',
  'viewerShell.chunkError.reload': 'Reload',
};

const fallbackTranslate = (key: ScreenKey, params?: { detail?: string }) =>
  FALLBACK_TEXT[key].replace('{detail}', params?.detail ?? '');

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(container: HTMLElement, error: unknown, reload: () => void, t: (key: ScreenKey, params?: { detail: string }) => string): void {
  const viewerCode = error instanceof ViewerLoadFailure;
  const detail = viewerCode ? 'viewer-code' : error instanceof ViewerConfigError ? error.code : 'unexpected';
  const screen = element('div', 'flex h-screen items-center justify-center bg-background p-6 text-foreground');
  screen.dataset.viewerConfig = 'error';
  screen.setAttribute('role', 'alert');
  const card = element('div', 'flex max-w-md flex-col items-start gap-3');
  const button = element('button', 'mt-2 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90', t('viewerShell.chunkError.reload'));
  button.type = 'button';
  button.addEventListener('click', reload);
  card.append(
    element('h1', 'text-2xl font-bold tracking-tight', t(viewerCode ? 'viewerShell.hostConfig.viewerLoadTitle' : 'viewerShell.hostConfig.errorTitle')),
    element('p', 'text-sm leading-relaxed text-muted-foreground', t(viewerCode ? 'viewerShell.hostConfig.viewerLoadBody' : 'viewerShell.hostConfig.errorBody')),
    element('p', 'font-mono text-xs text-muted-foreground', t('viewerShell.hostConfig.errorDetail', { detail })),
    button,
  );
  screen.append(card);
  container.replaceChildren(screen);
}

async function fail(container: HTMLElement, error: unknown, deps: HostStartDeps): Promise<false> {
  console.error('[viewer] The viewer does not start: its configuration or its code could not be loaded.', error);
  let t: (key: ScreenKey, params?: { detail: string }) => string = fallbackTranslate;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bounded: a translator that hangs must not keep the screen from appearing.
    t = await Promise.race([
      deps.loadTranslator(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), deps.translatorTimeoutMs ?? TRANSLATOR_TIMEOUT_MS);
      }),
    ]);
  } catch (translatorError) {
    console.warn('[viewer] The error screen could not load its translations; showing it in English.', translatorError);
  } finally {
    clearTimeout(timer);
  }
  showError(container, error, deps.reload, t);
  return false;
}

/** Resolves `true` when the viewer mounted, `false` when it did not (error screen, or a reload under way). */
export async function startHostedViewer(container: HTMLElement, url: string, deps: HostStartDeps): Promise<boolean> {
  const config = loadViewerRuntimeConfig({ url, pageUrl: deps.pageUrl, fetch: deps.fetch, timeoutMs: deps.timeoutMs });
  // What needs no configuration runs as soon as the code is here, while the
  // request may still be out. Behind a configuration that then fails this was
  // wasted work, but only the failure path pays; waiting would undo the overlap.
  const viewer = deps.loadViewer().then(
    (loaded) => { loaded.prepareViewer(); return loaded; },
    (error: unknown) => { throw new ViewerLoadFailure(error); },
  );
  let ready: [ViewerRuntimeConfig, HostedViewer];
  try {
    ready = await Promise.all([config, viewer]);
  } catch (error) {
    // Both settle either way; the one not reported here must not surface as unhandled.
    void config.catch(() => undefined);
    void viewer.catch(() => undefined);
    if (error instanceof ViewerLoadFailure) {
      // The watchdog's case (see the module comment): leave the root empty. If
      // it is still empty after the watchdog's backstop, the watchdog gave up.
      console.error('[viewer] The viewer code could not be loaded; leaving it to the boot watchdog.', error);
      setTimeout(() => {
        if (container.childElementCount === 0) void fail(container, error, deps);
      }, deps.watchdogGraceMs ?? WATCHDOG_GRACE_MS);
      return false;
    }
    return fail(container, error, deps);
  }
  ready[1].mountViewer(container, { config: ready[0] });
  return true;
}
