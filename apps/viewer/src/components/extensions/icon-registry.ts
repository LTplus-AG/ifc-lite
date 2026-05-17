/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared icon registry for extension commands.
 *
 * The picker (`PromoteToolDialog`) and the renderers
 * (`ExtensionToolbarSlot`, command palette, context menu) all read
 * from this single source so the icon a user picks actually shows up
 * everywhere their command appears.
 *
 * Manifests record only the string key — never a component reference —
 * so the bundle stays serialisable and portable.
 */

import {
  AlertTriangle, Beaker, Box, Brain, Calculator, Camera, CheckCircle2,
  ClipboardList, Download, Eye, FileBarChart, FileText, Filter, Flame,
  Gauge, Hammer, Layers, Lightbulb, Maximize2, Palette, Ruler, ScanSearch,
  Scissors, Settings, Shield, Sparkles, Tag, Target, Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface IconChoice {
  key: string;
  Icon: LucideIcon;
  label: string;
}

/**
 * Curated lucide subset (~29). Keys are lowercase-hyphenated so they
 * survive JSON round-trips in `manifest.contributes.commands[].icon`.
 */
export const ICON_CHOICES: readonly IconChoice[] = [
  { key: 'sparkles', Icon: Sparkles, label: 'AI / magic' },
  { key: 'wrench', Icon: Wrench, label: 'Tool' },
  { key: 'hammer', Icon: Hammer, label: 'Build' },
  { key: 'palette', Icon: Palette, label: 'Color' },
  { key: 'eye', Icon: Eye, label: 'View' },
  { key: 'filter', Icon: Filter, label: 'Filter' },
  { key: 'shield', Icon: Shield, label: 'Compliance' },
  { key: 'flame', Icon: Flame, label: 'Fire rating' },
  { key: 'ruler', Icon: Ruler, label: 'Measure' },
  { key: 'calculator', Icon: Calculator, label: 'Quantity' },
  { key: 'box', Icon: Box, label: 'Element' },
  { key: 'layers', Icon: Layers, label: 'Storey' },
  { key: 'tag', Icon: Tag, label: 'Classification' },
  { key: 'target', Icon: Target, label: 'Isolate' },
  { key: 'scan-search', Icon: ScanSearch, label: 'Audit' },
  { key: 'clipboard-list', Icon: ClipboardList, label: 'Schedule' },
  { key: 'file-text', Icon: FileText, label: 'Report' },
  { key: 'file-bar-chart', Icon: FileBarChart, label: 'Chart' },
  { key: 'download', Icon: Download, label: 'Export' },
  { key: 'camera', Icon: Camera, label: 'Snapshot' },
  { key: 'scissors', Icon: Scissors, label: 'Section' },
  { key: 'maximize-2', Icon: Maximize2, label: 'Fly to' },
  { key: 'gauge', Icon: Gauge, label: 'Performance' },
  { key: 'lightbulb', Icon: Lightbulb, label: 'Idea' },
  { key: 'alert-triangle', Icon: AlertTriangle, label: 'Warning' },
  { key: 'beaker', Icon: Beaker, label: 'Test' },
  { key: 'brain', Icon: Brain, label: 'Memory' },
  { key: 'check-circle-2', Icon: CheckCircle2, label: 'Validate' },
  { key: 'settings', Icon: Settings, label: 'Setting' },
];

const ICON_LOOKUP = new Map<string, LucideIcon>(
  ICON_CHOICES.map((c) => [c.key, c.Icon]),
);

/**
 * Resolve a manifest icon string to a lucide component. Falls back to
 * `Sparkles` when the key is unknown or absent so the toolbar still
 * renders something rather than a missing-icon hole. Also accepts a
 * loose match on common variants (case, leading "icon-", underscores)
 * so AI-authored manifests with slight key drift still resolve.
 */
export function resolveExtensionIcon(key: string | undefined | null): LucideIcon {
  if (!key) return Sparkles;
  const direct = ICON_LOOKUP.get(key);
  if (direct) return direct;
  // Tolerate AI-authored variants the picker doesn't emit but the model
  // might guess: `Wrench`, `alertTriangle`, `Alert_Triangle`,
  // `icon-wrench`, etc. → all collapse to the kebab-case canonical key.
  const normalised = key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/^icon[-_]/, '')
    .replace(/_/g, '-')
    .trim();
  return ICON_LOOKUP.get(normalised) ?? Sparkles;
}

/** Comma-separated catalogue for prompts / docs. */
export const ICON_KEYS_CATALOGUE = ICON_CHOICES.map((c) => c.key).join(', ');
