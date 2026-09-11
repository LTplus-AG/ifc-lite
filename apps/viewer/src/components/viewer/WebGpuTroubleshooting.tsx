/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ExternalLink } from 'lucide-react';
import type { WebGPUUnavailableReason } from '@/hooks/useWebGPU';

/** One-line caption under the disabled "Open .ifc file" button on the empty-state card. */
export function WebGpuDisabledCaption() {
  return (
    <>
      file upload disabled — the toolkit still works from the{' '}
      <a
        href="https://ifclite.dev/docs/guide/cli/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        CLI
      </a>{" or the "}
      <a
        href="https://ifclite.dev/docs/guide/mcp/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        MCP server
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
 */
export function webGpuBannerBlurb(category: WebGPUUnavailableReason | null): string {
  switch (category) {
    case 'insecure-context':
      return "This page isn't loaded over a secure connection, so no browser exposes WebGPU here — that says nothing about whether your device can run it.";
    case 'no-api':
      return 'Your browser does not expose the WebGPU API on this page. This viewer requires WebGPU for the 3D viewport.';
    case 'no-gpu':
    default:
      return 'This viewer requires WebGPU, and your browser could not create a GPU adapter here.';
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
  return (
    <div className="mt-4 p-4 bg-[#1f2335] border border-[#3b4261] text-xs font-mono space-y-4">
      {category === 'insecure-context' ? (
        <div>
          <h4 className="font-bold text-[#ff9e64] uppercase tracking-wide mb-2">Insecure Origin</h4>
          <p className="text-[#a9b1d6]">
            WebGPU is only available on a secure context: an{' '}
            <code className="bg-[#16161e] px-1.5 py-0.5">https://</code> URL, or{' '}
            <code className="bg-[#16161e] px-1.5 py-0.5">http://localhost</code>. Open this page over
            HTTPS, or via <code className="bg-[#16161e] px-1.5 py-0.5">localhost</code> if you are
            running it yourself — plain HTTP on an IP address or hostname disables WebGPU in every
            browser, regardless of your GPU.
          </p>
        </div>
      ) : category === 'no-api' ? (
        <div>
          <h4 className="font-bold text-[#ff9e64] uppercase tracking-wide mb-2">
            Browser Not Exposing WebGPU
          </h4>
          <p className="text-[#a9b1d6] mb-2">
            The page is secure, but this browser still doesn't offer{' '}
            <code className="bg-[#16161e] px-1.5 py-0.5">navigator.gpu</code>. We can't tell which of
            these applies from here — check the ones that fit your setup:
          </p>
          <ul className="list-disc list-inside text-[#a9b1d6] space-y-1">
            <li>
              An embedded webview (an in-app browser, an Electron/CEF shell) that doesn't ship WebGPU
              — try opening this page in a standalone Chrome, Edge, Firefox, or Safari window instead.
            </li>
            <li>
              An enterprise or MDM policy disabling WebGPU — check{' '}
              <code className="bg-[#16161e] px-1.5 py-0.5">chrome://policy</code> for a
              <code className="bg-[#16161e] px-1.5 py-0.5">DefaultWebGPUAccess</code> or
              hardware-acceleration restriction.
            </li>
            <li>A browser older than Chrome/Edge 113, Firefox 141, or Safari 26.</li>
          </ul>
        </div>
      ) : (
        <>
          <div>
            <h4 className="font-bold text-[#ff9e64] uppercase tracking-wide mb-2">Blocklist Override</h4>
            <p className="text-[#a9b1d6] mb-2">
              WebGPU may be disabled due to GPU/driver blocklist. Try these flags:
            </p>
            <div className="space-y-1 text-[#7dcfff]">
              <p><code className="bg-[#16161e] px-1.5 py-0.5">chrome://flags/#enable-unsafe-webgpu</code> → Enable</p>
              <p><code className="bg-[#16161e] px-1.5 py-0.5">chrome://flags/#ignore-gpu-blocklist</code> → Enable</p>
            </div>
          </div>

          <div>
            <h4 className="font-bold text-[#bb9af7] uppercase tracking-wide mb-2">Firefox</h4>
            <p className="text-[#a9b1d6] mb-2">
              WebGPU enabled by default in Firefox 141+. For older versions:
            </p>
            <p className="text-[#7dcfff]">
              <code className="bg-[#16161e] px-1.5 py-0.5">about:config</code> → <code className="bg-[#16161e] px-1.5 py-0.5">dom.webgpu.enabled</code> → true
            </p>
          </div>

          <div>
            <h4 className="font-bold text-[#9ece6a] uppercase tracking-wide mb-2">Safari</h4>
            <p className="text-[#a9b1d6]">
              Safari → Settings → Feature Flags → Enable "WebGPU"
            </p>
          </div>

          <div>
            <h4 className="font-bold text-[#7aa2f7] uppercase tracking-wide mb-2">Verify Status</h4>
            <p className="text-[#a9b1d6] mb-2">Check your GPU status page:</p>
            <div className="space-y-1 text-[#7dcfff]">
              <p>Chrome/Edge: <code className="bg-[#16161e] px-1.5 py-0.5">chrome://gpu</code></p>
              <p>Firefox: <code className="bg-[#16161e] px-1.5 py-0.5">about:support</code></p>
            </div>
          </div>

          <a
            href="https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[#7aa2f7] hover:underline"
          >
            Full Troubleshooting Guide
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
  const intro =
    category === 'no-gpu'
      ? 'If none of the above helped, this is likely a hardware or driver limit (blocklisted GPU, a VM/remote session with no GPU passthrough, or missing Vulkan/Metal/D3D12 drivers) — no browser flag fixes that.'
      : "Even once that's sorted, the 3D viewport is the only part of ifc-lite that needs WebGPU.";
  return (
    <div className="mt-4 pt-4 border-t border-[#3b4261] text-xs font-mono space-y-2">
      <h4 className="font-bold text-[#9ece6a] uppercase tracking-wide">Rest Of The Toolkit</h4>
      <p className="text-[#a9b1d6]">
        {intro} The rest of the toolkit runs on the CPU with no browser at all:
      </p>
      <p className="text-[#7dcfff]">
        <code className="bg-[#16161e] px-1.5 py-0.5">npx @ifc-lite/cli query model.ifc --type IfcWall</code>
      </p>
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        <a
          href="https://ifclite.dev/docs/guide/cli/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[#7aa2f7] hover:underline"
        >
          CLI Toolkit Docs
          <ExternalLink className="h-3 w-3" />
        </a>
        <a
          href="https://ifclite.dev/docs/guide/mcp/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[#7aa2f7] hover:underline"
        >
          MCP Server Docs
          <ExternalLink className="h-3 w-3" />
        </a>
      </p>
    </div>
  );
}
