/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The 3D-viewport-chrome + sun/lighting catalogue (#4918 viewport/lighting
 * slice, `viewportLighting.*`) covers eight files: `ViewportContainer.tsx`
 * (the empty/welcome state, its WebGPU-unavailable banner, and the
 * "Add Model" drop overlay), `ViewportOverlays.tsx` (the mobile touch-nav
 * cluster and the per-model basepoint toggle), `EditModeHudChip.tsx` (the
 * edit-mode status chip), `Viewport.tsx`'s own
 * render-failure fallback, `FlySpeedIndicator.tsx`'s fly-mode HUD,
 * `ShadowControls.tsx` and `SunTimeControls.tsx` (the Environment panel's
 * shadow and manual time-of-day sub-panels), and `EnvironmentPanel.tsx` itself
 * (environment/base-map pickers, the sun study's date/time/sweep controls
 * and its readout grid). `CONTEXT_SOURCES`/`SWEEP_MODES` moved their
 * `label`/`hint` strings to `labelKey`/`hintKey` fields, the same
 * data-table-plus-`labelKey` pattern `sectionConstants.ts`'s `AXIS_INFO`
 * and this sweep's other select-option tables use, so a locale switch
 * retranslates the Environment panel's dropdowns too, even though the gate
 * below does not itself see through an object literal's own fields.
 * `ShadowControls.tsx`'s `resolutionLabel` takes the same non-hook
 * `t: typeof resolve = resolve` default parameter `bulk-property-value.ts`
 * already uses, since it is a plain formatting function, not a component.
 * Model/entity content — a selected storey's own NAME, a model's own
 * displayed name — remains runtime data and stays out of the catalogue;
 * only the surrounding chrome, hints, and counted/toggled messages are
 * translated here.
 */
export const viewportLightingEn = {
  // ── ViewportContainer.tsx — empty/welcome state ──────────────────────
  'viewportLighting.container.emptyState.dropOverlay.title': 'Drop File to Load',
  'viewportLighting.container.emptyState.webgpuBanner.heading': 'WebGPU Not Available',
  'viewportLighting.container.emptyState.webgpuBanner.checkBrowserSupport': 'Check Browser Support',
  'viewportLighting.container.emptyState.webgpuBanner.supportedBrowsers':
    'Chrome 113+ / Edge 113+ / Firefox 141+ / Safari 18+',
  'viewportLighting.container.emptyState.webgpuBanner.hideTroubleshooting': 'Hide Troubleshooting',
  'viewportLighting.container.emptyState.webgpuBanner.showTroubleshooting': 'Show Troubleshooting',
  'viewportLighting.container.emptyState.logoAlt': 'IFClite Logo',
  'viewportLighting.container.emptyState.title': 'IFClite',
  'viewportLighting.container.emptyState.tagline': 'IFC toolkit for the open web',
  'viewportLighting.container.emptyState.openButton.checking': 'Checking WebGPU...',
  'viewportLighting.container.emptyState.openButton.open': 'Open model file',
  'viewportLighting.container.emptyState.openButton.required': 'WebGPU Required',
  'viewportLighting.container.emptyState.dragDropHint': 'or drop files here',
  'viewportLighting.container.emptyState.orDivider': 'or',
  'viewportLighting.container.emptyState.startBlank': 'Start blank',
  'viewportLighting.container.emptyState.openFromCloud': 'Open from cloud',
  'viewportLighting.container.emptyState.driveWithLlm': 'Drive with any LLM',
  'viewportLighting.container.emptyState.footerCaption': 'new untitled project · or LLM via MCP',
  'viewportLighting.container.emptyState.recentFiles.heading': 'Recent Files',
  // Privacy footnote (#5119): the visible line itself is the shared
  // `keyboardShortcuts.privacy.banner` key; this is only the tooltip on the
  // click-through to the About tab where the WASM/F12 detail lives.
  'viewportLighting.container.emptyState.privacyDetailsHint': 'How your data stays on your device',
  // First-run primary action (#5840): the demo-kit sample, loaded through
  // the same `loadFile` as any user file.
  'viewportLighting.container.emptyState.loadDemo.button': 'Load demo project',
  'viewportLighting.container.emptyState.loadDemo.caption': 'A small sample building. No account, nothing uploaded.',
  'viewportLighting.container.emptyState.loadDemo.failed': 'The demo project could not be loaded. Check your connection and try again.',
  'viewportLighting.container.emptyState.layersDemo': 'Try the Layers demo',
  'viewportLighting.container.emptyState.footer.discoverPrompt': 'New here?',
  'viewportLighting.container.emptyState.footer.discoverLink': 'ifclite.dev →',
  'viewportLighting.container.emptyState.footer.shortcutsLabel': 'SHORTCUTS',
  // ── ViewportContainer.tsx — loaded-model "Add Model" drop overlay ────
  // ── ViewportLoadingCard.tsx — in-viewport load progress + Cancel (#5849) ─
  'viewportLighting.container.loadingCard.title': 'Loading {name}',
  'viewportLighting.container.loadingCard.titleFallback': 'Loading model…',
  'viewportLighting.container.loadingCard.cancel': 'Cancel',
  // ── ViewportLoadErrorCard.tsx — one load-error card for every load
  // path: the picker, drop, ?model= autoload and federated adds (#5851) ──
  'viewportLighting.container.loadErrorCard.title': 'Could not load the model',
  'viewportLighting.container.loadErrorCard.retry': 'Retry',
  'viewportLighting.container.loadErrorCard.dismiss': 'Dismiss',
  'viewportLighting.container.loadErrorCard.webgpuChecking': 'WebGPU support is still being checked. Try opening the model again in a moment.',
  'viewportLighting.container.loadErrorCard.webgpuUnsupported':
    "This browser can't run the WebGPU renderer this viewer needs. Try a recent Chrome, Edge, Firefox or Safari — see the browser-support link at the top of the viewer.",
  'viewportLighting.container.modelUrlAutoload.malformedUrl': 'The linked model address is not a valid URL.',
  'viewportLighting.container.modelUrlAutoload.crossOrigin':
    "The linked model is hosted on a different site, so it was not loaded for your safety.",
  'viewportLighting.container.modelUrlAutoload.fetchFailed': 'The linked model could not be downloaded: {reason}',
  'viewportLighting.container.dropOverlay.addModelTitle': 'Add Model to Scene',
  'viewportLighting.container.dropOverlay.addModelSubtitle': {
    one: 'Drop to federate with {count} existing model',
    other: 'Drop to federate with {count} existing models',
  },

  // ── ViewportOverlays.tsx — mobile touch-nav cluster ──────────────────
  'viewportLighting.overlays.mobileNav.homeAria': 'Home view',
  'viewportLighting.overlays.mobileNav.homeTooltip': 'Home (H)',
  'viewportLighting.overlays.mobileNav.zoomInAria': 'Zoom in',
  'viewportLighting.overlays.mobileNav.zoomOutAria': 'Zoom out',
  // ── ViewportOverlays.tsx — selected-storey count (the storeys' own
  // NAMEs are model content and are never routed through this key) ────
  'viewportLighting.overlays.storeyCount': { one: '{count} storey', other: '{count} storeys' },
  // ── ViewportOverlays.tsx — per-model basepoint toggle ────────────────
  'viewportLighting.overlays.basepointToggle.hide': 'Hide model basepoints',
  'viewportLighting.overlays.basepointToggle.showAria': 'Show model basepoints',
  'viewportLighting.overlays.basepointToggle.showTooltip': 'Show model basepoints (IFC 0,0,0)',

  // ── EditModeHudChip.tsx — the top-left "Editing" status chip (#5489);
  // `{model}` is the model's own displayed name, runtime data ──────────
  'viewportLighting.overlays.editingChip': 'Editing',
  'viewportLighting.overlays.editingChipWithModel': 'Editing · {model}',

  // ── Viewport.tsx — renderer init failure fallback ────────────────────
  'viewportLighting.viewport.renderFailed.title': '3D Rendering Failed',
  'viewportLighting.viewport.renderFailed.browserHint':
    'Try using Chrome 113+, Edge 113+, or Safari 18+ with WebGPU support.',

  // ── FlySpeedIndicator.tsx — fly-mode speed HUD ───────────────────────
  'viewportLighting.flySpeed.label': 'Fly speed {level}/{total}',

  // ── ShadowControls.tsx — Environment panel's shadow sub-panel ──────────
  'viewportLighting.shadowControls.title': 'Cast shadows',
  'viewportLighting.shadowControls.toggleAria': 'Toggle sun cast shadows',
  'viewportLighting.shadowControls.softnessLabel': 'Softness',
  'viewportLighting.shadowControls.softnessResetTitle':
    "Reset shadow softness — the sun's angular size (degrees). Larger = softer, blurrier shadow edges (crisp ~0.53° clear sky). It does NOT move the sun; use Time of day for that.",
  'viewportLighting.shadowControls.qualityLabel': 'Shadow quality',
  'viewportLighting.shadowControls.qualityAria': 'Shadow map resolution',
  'viewportLighting.shadowControls.qualityTitle':
    "Shadow-map resolution — Auto picks from the device's texture limit; higher is sharper but costs more GPU",
  'viewportLighting.shadowControls.resolution.auto': 'Auto (device)',
  'viewportLighting.shadowControls.resolution.low': 'Low ({resolution}px)',
  'viewportLighting.shadowControls.resolution.medium': 'Medium ({resolution}px)',
  'viewportLighting.shadowControls.resolution.high': 'High ({resolution}px)',

  // ── SunTimeControls.tsx — Environment panel's manual time-of-day sub-panel
  'viewportLighting.sunTimeControls.title': 'Time of day',
  'viewportLighting.sunTimeControls.toggleAria': 'Toggle manual time-of-day sun',
  'viewportLighting.sunTimeControls.sunTimeLabel': 'Sun time',
  'viewportLighting.sunTimeControls.resetTitle': 'Reset to early afternoon',
  'viewportLighting.sunTimeControls.overriddenHint': 'Overridden by the georeferenced sun study.',

  // ── EnvironmentPanel.tsx — header (#5506: docked side panel, was the
  // floating SunSkyPanel.tsx) ──────────────────────────────────────────
  'viewportLighting.sunSkyPanel.header.title': 'Environment',
  'viewportLighting.sunSkyPanel.header.closeTitle': 'Close Environment panel',
  // ── EnvironmentPanel.tsx — world-context (Cesium) environment ─────────
  'viewportLighting.sunSkyPanel.cesium.skyToggleLabel': 'Sky',
  'viewportLighting.sunSkyPanel.cesium.skyToggleTitle':
    'Sky, sun disc and haze in the world context — also drives lighting',
  'viewportLighting.sunSkyPanel.cesium.lightingHint': 'Lighting follows the sun & atmosphere',
  'viewportLighting.sunSkyPanel.cesium.baseMapLabel': 'Base map',
  'viewportLighting.sunSkyPanel.cesium.baseMapAria': 'World context base map',
  'viewportLighting.sunSkyPanel.cesium.contextSources.osmMap.label': 'OSM Map',
  'viewportLighting.sunSkyPanel.cesium.contextSources.osmMap.hint':
    'Plain OpenStreetMap tiles — a simple flat base map',
  'viewportLighting.sunSkyPanel.cesium.contextSources.osmBuildings.label': 'OSM Buildings',
  'viewportLighting.sunSkyPanel.cesium.contextSources.osmBuildings.hint':
    'Extruded footprints over the satellite base map',
  'viewportLighting.sunSkyPanel.cesium.contextSources.photorealistic.label': 'Photorealistic',
  'viewportLighting.sunSkyPanel.cesium.contextSources.photorealistic.hint':
    'Google 3D Tiles — textured real-world context',
  'viewportLighting.sunSkyPanel.cesium.contextSources.custom.label': 'Custom (XYZ)',
  'viewportLighting.sunSkyPanel.cesium.contextSources.custom.hint': 'Your own XYZ/TMS tile URL template',
  'viewportLighting.sunSkyPanel.cesium.contextSources.custom3dTiles.label': 'Custom (3D Tiles)',
  'viewportLighting.sunSkyPanel.cesium.contextSources.custom3dTiles.hint':
    'Your own 3D Tiles tileset URL (1.0 or 1.1)',
  // ── EnvironmentPanel.tsx — standalone (WebGPU) environment ────────────────
  'viewportLighting.sunSkyPanel.standalone.environmentLabel': 'Environment',
  'viewportLighting.sunSkyPanel.standalone.environmentAria': 'Environment preset',
  'viewportLighting.sunSkyPanel.standalone.noSkySuffix': ' (no sky)',
  // ── EnvironmentPanel.tsx — sun study ───────────────────────────────────────
  'viewportLighting.sunSkyPanel.sunStudy.title': 'Sun study',
  'viewportLighting.sunSkyPanel.sunStudy.on': 'On',
  'viewportLighting.sunSkyPanel.sunStudy.off': 'Off',
  'viewportLighting.sunSkyPanel.sunStudy.dateLabel': 'Date',
  'viewportLighting.sunSkyPanel.sunStudy.dateAria': 'Sun study date',
  'viewportLighting.sunSkyPanel.sunStudy.pauseAria': 'Pause sweep',
  'viewportLighting.sunSkyPanel.sunStudy.playAria': 'Play sweep',
  'viewportLighting.sunSkyPanel.sunStudy.timeLabel': 'Time',
  'viewportLighting.sunSkyPanel.sunStudy.enableWorldContextHint':
    'The sun lights the model directly; for the sun-path dome and real cast shadows, click to enable the 3D world context.',
  'viewportLighting.sunSkyPanel.sunStudy.noSiteWarning':
    "Site location unavailable — the model's projected CRS could not be resolved, so the real sun position can't be computed.",
  // Sweep-mode select
  'viewportLighting.sunSkyPanel.sunStudy.sweepModes.day.label': 'Day',
  'viewportLighting.sunSkyPanel.sunStudy.sweepModes.day.hint': 'Sweep the time of day',
  'viewportLighting.sunSkyPanel.sunStudy.sweepModes.year.label': 'Year',
  'viewportLighting.sunSkyPanel.sunStudy.sweepModes.year.hint': 'Sweep the date across the year',
  // Timezone toggle — `{offset}` is a formatted `UTC±H.h` string built by the
  // component, not translated text (same as an interpolated `Error.message`
  // elsewhere in this sweep).
  'viewportLighting.sunSkyPanel.sunStudy.timezone.utc': 'UTC',
  'viewportLighting.sunSkyPanel.sunStudy.timezone.site': 'Site',
  'viewportLighting.sunSkyPanel.sunStudy.timezone.siteWithOffset': 'Site ({offset})',
  'viewportLighting.sunSkyPanel.sunStudy.timezoneToggleTitle':
    'Toggle UTC / local solar time (from site longitude)',
  // World-context extras
  'viewportLighting.sunSkyPanel.sunStudy.domeToggle': 'Dome',
  'viewportLighting.sunSkyPanel.sunStudy.shadowsToggle': 'Shadows',
  // Readout grid labels — the values themselves stay numeric/formatted, not
  // translated (azimuth/altitude degrees, lat/long, times).
  'viewportLighting.sunSkyPanel.sunStudy.readout.azimuth': 'Azimuth',
  'viewportLighting.sunSkyPanel.sunStudy.readout.altitude': 'Altitude',
  'viewportLighting.sunSkyPanel.sunStudy.readout.sunrise': 'Sunrise',
  'viewportLighting.sunSkyPanel.sunStudy.readout.sunset': 'Sunset',
  'viewportLighting.sunSkyPanel.sunStudy.readout.noon': 'Noon',
  'viewportLighting.sunSkyPanel.sunStudy.readout.site': 'Site',
} as const satisfies Record<string, TranslationValue>;
