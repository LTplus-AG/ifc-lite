/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Presentational-only helpers for the start screen (`ViewportEmptyState.tsx`),
 * split out (#5119) so the constant below keeps its full explanatory comment
 * without pushing the component past the module-size cap. Neither helper
 * depends on any empty-state prop or handler.
 */

/** Plain CSS text, not UI copy — kept as a module-level constant (rather than
 *  an inline `<style>{`…`}</style>` template literal) so the i18n literal
 *  gate, which only inspects JSX-child string LITERALS, never mistakes a
 *  keyframe declaration for translatable prose. */
export const FLOAT_SLOW_KEYFRAMES = `
  @keyframes float-slow {
    0%, 100% { transform: translateY(0px) rotate(0deg); }
    50% { transform: translateY(-6px) rotate(1deg); }
  }
  .animate-float-slow {
    animation: float-slow 5s ease-in-out infinite;
  }
`;

// Grid Pattern
export const GridPattern = () => (
  <>
    {/* Light mode grid - subtle gray */}
    <div
      className="absolute inset-0 z-0 pointer-events-none opacity-[0.06] dark:hidden"
      style={{
        backgroundImage: `linear-gradient(#3b4261 1px, transparent 1px), linear-gradient(90deg, #3b4261 1px, transparent 1px)`,
        backgroundSize: '32px 32px',
        backgroundPosition: '-1px -1px'
      }}
    />
    {/* Dark mode grid - subtle blue/cyan tint */}
    <div
      className="absolute inset-0 z-0 pointer-events-none opacity-[0.12] hidden dark:block"
      style={{
        backgroundImage: `linear-gradient(#3b4261 1px, transparent 1px), linear-gradient(90deg, #3b4261 1px, transparent 1px)`,
        backgroundSize: '32px 32px',
        backgroundPosition: '-1px -1px'
      }}
    />
  </>
);
