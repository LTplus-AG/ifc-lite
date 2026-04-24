/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane visual indicator/gizmo
 */

import { AXIS_INFO } from './sectionConstants';

interface SectionPlaneVisualizationProps {
  axis: 'down' | 'front' | 'side';
  enabled: boolean;
  /** True when the plane has been set via face-pick (arbitrary normal).
   * Changes the badge colour + label so the user isn't misled by the
   * nearest-cardinal `axis` value that's still populated for downstream
   * compatibility (drawings/BCF). */
  isCustom?: boolean;
}

// Section plane visual indicator component
export function SectionPlaneVisualization({ axis, enabled, isCustom = false }: SectionPlaneVisualizationProps) {
  // Get the axis color
  const axisColors = {
    down: '#03A9F4',  // Light blue for horizontal cuts
    front: '#4CAF50', // Green for front cuts
    side: '#FF9800',  // Orange for side cuts
  };

  const color = isCustom ? '#9C6BDE' : axisColors[axis];
  const label = isCustom ? 'CUSTOM' : AXIS_INFO[axis].label.toUpperCase();

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-20"
      style={{ overflow: 'visible', pointerEvents: 'none' }}
    >
      <defs>
        <filter id="section-glow">
          <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
        {/* Animated dash pattern */}
        <pattern id="section-pattern" patternUnits="userSpaceOnUse" width="10" height="10">
          <line x1="0" y1="0" x2="10" y2="10" stroke={color} strokeWidth="1" strokeOpacity="0.5"/>
        </pattern>
      </defs>

      {/* Axis indicator in corner */}
      <g transform="translate(24, 24)">
        <circle cx="20" cy="20" r="18" fill={color} fillOpacity={enabled ? 0.2 : 0.1} stroke={color} strokeWidth={enabled ? 3 : 2} filter="url(#section-glow)"/>
        <text
          x="20"
          y="20"
          textAnchor="middle"
          dominantBaseline="central"
          fill={color}
          fontFamily="monospace"
          fontSize={isCustom ? 8 : 11}
          fontWeight="bold"
        >
          {label}
        </text>
        {/* Active indicator */}
        {enabled && (
          <text
            x="20"
            y="32"
            textAnchor="middle"
            fill={color}
            fontFamily="monospace"
            fontSize="7"
            fontWeight="bold"
          >
            CUT
          </text>
        )}
      </g>
    </svg>
  );
}
