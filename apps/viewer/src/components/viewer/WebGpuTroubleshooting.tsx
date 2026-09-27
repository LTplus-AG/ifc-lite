/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ExternalLink } from 'lucide-react';
import type { WebGPUUnavailableReason } from '@/hooks/useWebGPU';
import { useTranslation } from '@/i18n';
import { resolve } from '@/i18n/registry';

/** One-line caption under the disabled demo and Open buttons on the empty-state card. */
export function WebGpuDisabledCaption() {
  const { t } = useTranslation();
  return (
    <>
      {t('webgpuTroubleshooting.disabledCaption.intro')}{' '}
      <a
        href="https://ifclite.dev/docs/guide/cli/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        {t('webgpuTroubleshooting.disabledCaption.cliLink')}
      </a>{' '}
      {t('webgpuTroubleshooting.disabledCaption.orThe')}{' '}
      <a
        href="https://ifclite.dev/docs/guide/mcp/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        {t('webgpuTroubleshooting.disabledCaption.mcpLink')}
      </a>
    </>
  );
}

/**
 * The banner's headline sentence, branched by *why* `navigator.gpu` never
 * came up — not just "unsupported". The three causes have almost disjoint
 * remedies, and lumping them together hands a GPU-blocklist flag to someone
 * whose real problem is an insecure origin, which cannot be fixed by any
 * browser setting. See useWebGPU.ts for what each category can and cannot
 * observe.
 *
 * A plain function, not a component — it cannot call `useTranslation()` —
 * so it resolves directly against the locale registry, the same
 * `t: typeof resolve = resolve` shape `bulk-property-value.ts` uses.
 */
export function webGpuBannerBlurb(
  category: WebGPUUnavailableReason | null,
  t: typeof resolve = resolve,
): string {
  switch (category) {
    case 'insecure-context':
      return t('webgpuTroubleshooting.banner.insecureContext');
    case 'no-api':
      return t('webgpuTroubleshooting.banner.noApi');
    case 'no-gpu':
    default:
      return t('webgpuTroubleshooting.banner.noGpu');
  }
}

/**
 * Category-specific troubleshooting steps, shown inside the collapsible
 * "Troubleshooting" section. Each category gets only the advice that can
 * plausibly fix it:
 * - insecure-context: change the origin — no browser flag helps.
 * - no-api (secure context, API still missing): embedded webview,
 *   enterprise policy, or a browser too old for WebGPU. We cannot tell
 *   these apart from the page, so they're listed as possibilities.
 * - no-gpu (adapter request failed/empty): the genuine hardware/driver
 *   case — this is the only branch where the blocklist-override flags,
 *   per-browser flag toggles, and GPU status pages belong.
 */
export function WebGpuTroubleshootingDetails({
  category,
}: {
  category: WebGPUUnavailableReason | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-4 p-4 bg-muted border border-border text-xs font-mono space-y-4">
      {category === 'insecure-context' ? (
        <div>
          <h4 className="font-bold text-status-warn uppercase tracking-wide mb-2">
            {t('webgpuTroubleshooting.insecureOrigin.heading')}
          </h4>
          <p className="text-muted-foreground">
            {t('webgpuTroubleshooting.insecureOrigin.textStart')}{' '}
            <code className="bg-background px-1.5 py-0.5">
              {t('webgpuTroubleshooting.insecureOrigin.httpsScheme')}
            </code>{' '}
            {t('webgpuTroubleshooting.insecureOrigin.urlOr')}{' '}
            <code className="bg-background px-1.5 py-0.5">
              {t('webgpuTroubleshooting.insecureOrigin.httpLocalhost')}
            </code>
            {t('webgpuTroubleshooting.insecureOrigin.openOverHttps')}{' '}
            <code className="bg-background px-1.5 py-0.5">
              {t('webgpuTroubleshooting.insecureOrigin.localhostWord')}
            </code>{' '}
            {t('webgpuTroubleshooting.insecureOrigin.runningYourself')}
          </p>
        </div>
      ) : category === 'no-api' ? (
        <div>
          <h4 className="font-bold text-status-warn uppercase tracking-wide mb-2">
            {t('webgpuTroubleshooting.noApi.heading')}
          </h4>
          <p className="text-muted-foreground mb-2">
            {t('webgpuTroubleshooting.noApi.textStart')}{' '}
            <code className="bg-background px-1.5 py-0.5">
              {t('webgpuTroubleshooting.noApi.navigatorGpu')}
            </code>
            {t('webgpuTroubleshooting.noApi.checkSetup')}
          </p>
          <ul className="list-disc list-inside text-muted-foreground space-y-1">
            <li>{t('webgpuTroubleshooting.noApi.embeddedWebview')}</li>
            <li>
              {t('webgpuTroubleshooting.noApi.enterprisePolicyStart')}{' '}
              <code className="bg-background px-1.5 py-0.5">
                {t('webgpuTroubleshooting.noApi.chromePolicyPath')}
              </code>{' '}
              {t('webgpuTroubleshooting.noApi.forA')}
              <code className="bg-background px-1.5 py-0.5">
                {t('webgpuTroubleshooting.noApi.defaultWebGpuAccess')}
              </code>{' '}
              {t('webgpuTroubleshooting.noApi.hardwareAccelRestriction')}
            </li>
            <li>{t('webgpuTroubleshooting.noApi.olderBrowser')}</li>
          </ul>
        </div>
      ) : (
        <>
          <div>
            <h4 className="font-bold text-status-warn uppercase tracking-wide mb-2">
              {t('webgpuTroubleshooting.noGpu.blocklistHeading')}
            </h4>
            <p className="text-muted-foreground mb-2">{t('webgpuTroubleshooting.noGpu.blocklistIntro')}</p>
            <div className="space-y-1 text-status-info">
              <p>
                <code className="bg-background px-1.5 py-0.5">
                  {t('webgpuTroubleshooting.noGpu.flagUnsafeWebgpu')}
                </code>{' '}
                {t('webgpuTroubleshooting.noGpu.enableFlagArrow')}
              </p>
              <p>
                <code className="bg-background px-1.5 py-0.5">
                  {t('webgpuTroubleshooting.noGpu.flagIgnoreBlocklist')}
                </code>{' '}
                {t('webgpuTroubleshooting.noGpu.enableFlagArrow')}
              </p>
            </div>
          </div>

          <div>
            <h4 className="font-bold text-primary uppercase tracking-wide mb-2">
              {t('webgpuTroubleshooting.firefox.heading')}
            </h4>
            <p className="text-muted-foreground mb-2">{t('webgpuTroubleshooting.firefox.intro')}</p>
            <p className="text-status-info">
              <code className="bg-background px-1.5 py-0.5">
                {t('webgpuTroubleshooting.firefox.aboutConfig')}
              </code>{' '}
              →{' '}
              <code className="bg-background px-1.5 py-0.5">
                {t('webgpuTroubleshooting.firefox.domWebgpuEnabled')}
              </code>{' '}
              {t('webgpuTroubleshooting.firefox.arrowTrue')}
            </p>
          </div>

          <div>
            <h4 className="font-bold text-status-ok uppercase tracking-wide mb-2">
              {t('webgpuTroubleshooting.safari.heading')}
            </h4>
            <p className="text-muted-foreground">{t('webgpuTroubleshooting.safari.instructions')}</p>
          </div>

          <div>
            <h4 className="font-bold text-primary uppercase tracking-wide mb-2">
              {t('webgpuTroubleshooting.verifyStatus.heading')}
            </h4>
            <p className="text-muted-foreground mb-2">{t('webgpuTroubleshooting.verifyStatus.intro')}</p>
            <div className="space-y-1 text-status-info">
              <p>
                {t('webgpuTroubleshooting.verifyStatus.chromeEdgeLabel')}{' '}
                <code className="bg-background px-1.5 py-0.5">
                  {t('webgpuTroubleshooting.verifyStatus.chromeGpuPath')}
                </code>
              </p>
              <p>
                {t('webgpuTroubleshooting.verifyStatus.firefoxLabel')}{' '}
                <code className="bg-background px-1.5 py-0.5">
                  {t('webgpuTroubleshooting.verifyStatus.aboutSupportPath')}
                </code>
              </p>
            </div>
          </div>

          <a
            href="https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-primary hover:underline"
          >
            {t('webgpuTroubleshooting.fullGuideLink')}
            <ExternalLink className="h-3 w-3" />
          </a>
        </>
      )}

      <WebGpuFallbackNotice category={category} />
    </div>
  );
}

/**
 * The CLI/MCP escape hatch. Applies to every category above — whichever the
 * cause, the 3D viewport is the only part of ifc-lite that needs WebGPU.
 * Verified GPU-free: @ifc-lite/cli (packages/cli/package.json) depends on
 * @ifc-lite/wasm, not @ifc-lite/renderer, and its source has no
 * `@ifc-lite/renderer` or `navigator.gpu` reference; same for
 * @ifc-lite/mcp. The 3D viewport itself has no software-rendering fallback
 * yet.
 */
function WebGpuFallbackNotice({ category }: { category: WebGPUUnavailableReason | null }) {
  const { t } = useTranslation();
  const intro =
    category === 'no-gpu'
      ? t('webgpuTroubleshooting.restOfToolkit.introNoGpu')
      : t('webgpuTroubleshooting.restOfToolkit.introOther');
  return (
    <div className="mt-4 pt-4 border-t border-border text-xs font-mono space-y-2">
      <h4 className="font-bold text-status-ok uppercase tracking-wide">
        {t('webgpuTroubleshooting.restOfToolkit.heading')}
      </h4>
      <p className="text-muted-foreground">
        {intro} {t('webgpuTroubleshooting.restOfToolkit.cpuLine')}
      </p>
      <p className="text-status-info">
        <code className="bg-background px-1.5 py-0.5">
          {t('webgpuTroubleshooting.restOfToolkit.cliCommand')}
        </code>
      </p>
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        <a
          href="https://ifclite.dev/docs/guide/cli/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-primary hover:underline"
        >
          {t('webgpuTroubleshooting.restOfToolkit.cliDocsLink')}
          <ExternalLink className="h-3 w-3" />
        </a>
        <a
          href="https://ifclite.dev/docs/guide/mcp/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-primary hover:underline"
        >
          {t('webgpuTroubleshooting.restOfToolkit.mcpDocsLink')}
          <ExternalLink className="h-3 w-3" />
        </a>
      </p>
    </div>
  );
}
