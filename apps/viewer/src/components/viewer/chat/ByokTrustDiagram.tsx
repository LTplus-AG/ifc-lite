/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Visual proof of where the API key (and chat content) goes when a BYOK model
 * is in use. Two stacked paths:
 *   row 1 (active)    browser ────► api.provider.com
 *   row 2 (blocked)   browser ─► our server ─► api.provider.com    (struck out)
 *
 * The shape of the diagram is the same for every provider — only the API host
 * label rotates. Renders crisply in light and dark mode via Tailwind utility
 * classes.
 */

interface ByokTrustDiagramProps {
  apiHost: string;
}

export function ByokTrustDiagram({ apiHost }: ByokTrustDiagramProps) {
  return (
    <svg
      viewBox="0 0 520 200"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={`Diagram: requests go directly from your browser to ${apiHost}, not via our server.`}
      className="w-full h-auto"
    >
      <defs>
        <marker
          id="byok-arrow-active"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerUnits="strokeWidth"
          markerWidth="8"
          markerHeight="8"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="fill-emerald-500" />
        </marker>
        <marker
          id="byok-arrow-blocked"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerUnits="strokeWidth"
          markerWidth="8"
          markerHeight="8"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
        </marker>
      </defs>

      {/* Row 1 — the path that's actually used */}
      <g transform="translate(0, 18)">
        <text x="0" y="-4" className="text-[10px] uppercase tracking-wider fill-emerald-600 dark:fill-emerald-400 font-semibold">
          ✓ How your requests actually flow
        </text>

        {/* Browser box */}
        <rect
          x="2"
          y="6"
          width="120"
          height="48"
          rx="8"
          className="fill-background stroke-emerald-500"
          strokeWidth="1.75"
        />
        <text x="62" y="35" textAnchor="middle" className="text-[12px] fill-foreground font-medium">
          Your browser
        </text>

        {/* Arrow */}
        <line
          x1="124"
          y1="30"
          x2="346"
          y2="30"
          className="stroke-emerald-500"
          strokeWidth="2"
          markerEnd="url(#byok-arrow-active)"
        />
        <text x="235" y="22" textAnchor="middle" className="text-[10px] fill-emerald-600 dark:fill-emerald-400 font-mono">
          HTTPS · direct
        </text>

        {/* Provider API box (highlighted) */}
        <rect
          x="350"
          y="6"
          width="168"
          height="48"
          rx="8"
          className="fill-emerald-500/10 stroke-emerald-500"
          strokeWidth="1.75"
        />
        <text x="434" y="35" textAnchor="middle" className="text-[12px] fill-foreground font-mono">
          {apiHost}
        </text>
      </g>

      {/* Row 2 — what we are NOT doing */}
      <g transform="translate(0, 116)" opacity="0.55">
        <text x="0" y="-4" className="text-[10px] uppercase tracking-wider fill-destructive font-semibold" opacity="1">
          ✗ What we never do
        </text>

        {/* Browser box (muted) */}
        <rect
          x="2"
          y="6"
          width="100"
          height="44"
          rx="6"
          className="fill-background stroke-muted-foreground"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <text x="52" y="33" textAnchor="middle" className="text-[11px] fill-muted-foreground">
          Your browser
        </text>

        {/* Arrow 1 (muted, dashed) */}
        <line
          x1="104"
          y1="28"
          x2="186"
          y2="28"
          className="stroke-muted-foreground"
          strokeWidth="1.25"
          strokeDasharray="3 3"
          markerEnd="url(#byok-arrow-blocked)"
        />

        {/* "Our server" box — struck through */}
        <rect
          x="190"
          y="6"
          width="120"
          height="44"
          rx="6"
          className="fill-background stroke-muted-foreground"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <text x="250" y="33" textAnchor="middle" className="text-[11px] fill-muted-foreground">
          our server
        </text>
        {/* Strike-through across the "our server" box */}
        <line
          x1="184"
          y1="44"
          x2="316"
          y2="12"
          className="stroke-destructive"
          strokeWidth="2.5"
          opacity="0.85"
        />

        {/* Arrow 2 (muted, dashed) */}
        <line
          x1="312"
          y1="28"
          x2="394"
          y2="28"
          className="stroke-muted-foreground"
          strokeWidth="1.25"
          strokeDasharray="3 3"
          markerEnd="url(#byok-arrow-blocked)"
        />

        {/* Provider API box (muted) */}
        <rect
          x="398"
          y="6"
          width="120"
          height="44"
          rx="6"
          className="fill-background stroke-muted-foreground"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <text x="458" y="33" textAnchor="middle" className="text-[11px] fill-muted-foreground font-mono">
          {apiHost}
        </text>
      </g>
    </svg>
  );
}
