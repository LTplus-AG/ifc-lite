/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The WebGPU-unavailable surface's own chrome (#4918 slice: webgpu/script).
 * Covers `WebGpuTroubleshooting.tsx` in full: the empty-state disabled-file
 * caption (`WebGpuDisabledCaption`), the category-branched banner headline
 * (`webGpuBannerBlurb`), the collapsible troubleshooting steps for each of
 * the three `WebGPUUnavailableReason` categories (`WebGpuTroubleshootingDetails`),
 * and the always-shown CLI/MCP fallback notice (`WebGpuFallbackNotice`).
 *
 * `webGpuBannerBlurb` is a plain function, not a component — it cannot call
 * `useTranslation()` — so it resolves directly against the locale registry
 * via `resolve` (`@/i18n/registry`), the same `t: typeof resolve = resolve`
 * default-parameter shape `bulk-property-value.ts` already uses for a
 * non-hook translator with a test-injectable override.
 *
 * Browser flag names, config paths, and CLI incantations
 * (`chrome://flags/#enable-unsafe-webgpu`, `about:config`,
 * `dom.webgpu.enabled`, `npx @ifc-lite/cli query model.ifc --type IfcWall`)
 * are catalogued like every other literal here even though they are
 * technical values a translator is expected to leave unchanged — the same
 * reasoning the clash-tools catalogue documents for a composite IFC
 * class-selector pattern: the gate does not distinguish "prose" from
 * "technical string", so consistent cataloguing is simpler than carving out
 * an exception.
 */
export const webgpuTroubleshootingEn = {
  // WebGpuDisabledCaption
  'webgpuTroubleshooting.disabledCaption.intro':
    'file upload disabled — the toolkit still works from the',
  'webgpuTroubleshooting.disabledCaption.cliLink': 'CLI',
  'webgpuTroubleshooting.disabledCaption.orThe': 'or the',
  'webgpuTroubleshooting.disabledCaption.mcpLink': 'MCP server',

  // webGpuBannerBlurb
  'webgpuTroubleshooting.banner.insecureContext':
    "This page isn't loaded over a secure connection, so no browser exposes WebGPU here — that says nothing about whether your device can run it.",
  'webgpuTroubleshooting.banner.noApi':
    'Your browser does not expose the WebGPU API on this page. This viewer requires WebGPU for the 3D viewport.',
  'webgpuTroubleshooting.banner.noGpu':
    'This viewer requires WebGPU, and your browser could not create a GPU adapter here.',

  // Insecure-context troubleshooting
  'webgpuTroubleshooting.insecureOrigin.heading': 'Insecure Origin',
  'webgpuTroubleshooting.insecureOrigin.textStart':
    'WebGPU is only available on a secure context: an',
  'webgpuTroubleshooting.insecureOrigin.httpsScheme': 'https://',
  'webgpuTroubleshooting.insecureOrigin.urlOr': 'URL, or',
  'webgpuTroubleshooting.insecureOrigin.httpLocalhost': 'http://localhost',
  'webgpuTroubleshooting.insecureOrigin.openOverHttps':
    '. Open this page over HTTPS, or via',
  'webgpuTroubleshooting.insecureOrigin.localhostWord': 'localhost',
  'webgpuTroubleshooting.insecureOrigin.runningYourself':
    'if you are running it yourself — plain HTTP on a non-loopback IP address or hostname disables WebGPU in every browser, regardless of your GPU.',

  // no-api troubleshooting
  'webgpuTroubleshooting.noApi.heading': 'Browser Not Exposing WebGPU',
  'webgpuTroubleshooting.noApi.textStart':
    "The page is secure, but this browser still doesn't offer",
  'webgpuTroubleshooting.noApi.navigatorGpu': 'navigator.gpu',
  'webgpuTroubleshooting.noApi.checkSetup':
    ". We can't tell which of these applies from here — check the ones that fit your setup:",
  'webgpuTroubleshooting.noApi.embeddedWebview':
    "An embedded webview (an in-app browser, an Electron/CEF shell) that doesn't ship WebGPU — try opening this page in a standalone Chrome, Edge, Firefox, or Safari window instead.",
  'webgpuTroubleshooting.noApi.enterprisePolicyStart':
    'An enterprise or MDM policy disabling WebGPU — check',
  'webgpuTroubleshooting.noApi.chromePolicyPath': 'chrome://policy',
  'webgpuTroubleshooting.noApi.forA': 'for a ',
  'webgpuTroubleshooting.noApi.defaultWebGpuAccess': 'DefaultWebGPUAccess',
  'webgpuTroubleshooting.noApi.hardwareAccelRestriction':
    'or hardware-acceleration restriction.',
  'webgpuTroubleshooting.noApi.olderBrowser':
    'A browser older than Chrome/Edge 113, Firefox 141, or Safari 26.',

  // no-gpu troubleshooting: blocklist override
  'webgpuTroubleshooting.noGpu.blocklistHeading': 'Blocklist Override',
  'webgpuTroubleshooting.noGpu.blocklistIntro':
    'WebGPU may be disabled due to GPU/driver blocklist. Try these flags:',
  'webgpuTroubleshooting.noGpu.flagUnsafeWebgpu':
    'chrome://flags/#enable-unsafe-webgpu',
  'webgpuTroubleshooting.noGpu.enableFlagArrow': '→ Enable',
  'webgpuTroubleshooting.noGpu.flagIgnoreBlocklist':
    'chrome://flags/#ignore-gpu-blocklist',

  // no-gpu troubleshooting: Firefox
  'webgpuTroubleshooting.firefox.heading': 'Firefox',
  'webgpuTroubleshooting.firefox.intro':
    'WebGPU enabled by default in Firefox 141+. For older versions:',
  'webgpuTroubleshooting.firefox.aboutConfig': 'about:config',
  'webgpuTroubleshooting.firefox.domWebgpuEnabled': 'dom.webgpu.enabled',
  'webgpuTroubleshooting.firefox.arrowTrue': '→ true',

  // no-gpu troubleshooting: Safari
  'webgpuTroubleshooting.safari.heading': 'Safari',
  'webgpuTroubleshooting.safari.instructions':
    'Safari → Settings → Feature Flags → Enable "WebGPU"',

  // no-gpu troubleshooting: verify status
  'webgpuTroubleshooting.verifyStatus.heading': 'Verify Status',
  'webgpuTroubleshooting.verifyStatus.intro': 'Check your GPU status page:',
  'webgpuTroubleshooting.verifyStatus.chromeEdgeLabel': 'Chrome/Edge:',
  'webgpuTroubleshooting.verifyStatus.chromeGpuPath': 'chrome://gpu',
  'webgpuTroubleshooting.verifyStatus.firefoxLabel': 'Firefox:',
  'webgpuTroubleshooting.verifyStatus.aboutSupportPath': 'about:support',

  'webgpuTroubleshooting.fullGuideLink': 'Full Troubleshooting Guide',

  // WebGpuFallbackNotice
  'webgpuTroubleshooting.restOfToolkit.heading': 'Rest Of The Toolkit',
  'webgpuTroubleshooting.restOfToolkit.introNoGpu':
    'If none of the above helped, this is likely a hardware or driver limit (blocklisted GPU, a VM/remote session with no GPU passthrough, or missing Vulkan/Metal/D3D12 drivers) — no browser flag fixes that.',
  'webgpuTroubleshooting.restOfToolkit.introOther':
    "Even once that's sorted, the 3D viewport is the only part of ifc-lite that needs WebGPU.",
  'webgpuTroubleshooting.restOfToolkit.cpuLine':
    'The rest of the toolkit runs on the CPU with no browser at all:',
  'webgpuTroubleshooting.restOfToolkit.cliCommand':
    'npx @ifc-lite/cli query model.ifc --type IfcWall',
  'webgpuTroubleshooting.restOfToolkit.cliDocsLink': 'CLI Toolkit Docs',
  'webgpuTroubleshooting.restOfToolkit.mcpDocsLink': 'MCP Server Docs',
} as const;
