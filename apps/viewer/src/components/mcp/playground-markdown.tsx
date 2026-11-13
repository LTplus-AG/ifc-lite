/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Components } from 'react-markdown';
import { cn } from '@/lib/utils';

// ── markdown rendering ────────────────────────────────────────────────────
//
// Tailwind utility set scoped to the chat. Headings stay quiet (the chat
// already structures the conversation). Tables get hairline borders.
// Inline code + code blocks pick up JetBrains Mono so they read like the
// tool-call cards.

export const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children, ...props }) => <h3 className="mt-3 mb-1 text-base font-semibold" {...props}>{children}</h3>,
  h2: ({ children, ...props }) => <h4 className="mt-3 mb-1 text-sm font-semibold" {...props}>{children}</h4>,
  h3: ({ children, ...props }) => <h5 className="mt-2 mb-1 text-sm font-semibold" {...props}>{children}</h5>,
  p: (props) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
  ul: (props) => <ul className="my-1.5 ml-4 list-disc space-y-0.5" {...props} />,
  ol: (props) => <ol className="my-1.5 ml-4 list-decimal space-y-0.5" {...props} />,
  li: (props) => <li className="leading-snug" {...props} />,
  strong: (props) => <strong className="font-semibold text-white" {...props} />,
  em: (props) => <em className="italic text-white/95" {...props} />,
  a: ({ children, ...props }) => (
    <a className="text-[#d6ff3f] underline-offset-2 hover:underline" target="_blank" rel="noreferrer" {...props}>{children}</a>
  ),
  // react-markdown v9 dropped the legacy `inline` prop, so we infer block
  // vs inline from className (fenced blocks get `language-…`) and content
  // (block code carries trailing newlines). When it's a block we render
  // a raw <code> here and let the `pre` override below own the wrapper —
  // doing the wrapping ourselves used to nest <pre> inside the <p>
  // react-markdown emits for surrounding text, tripping React's DOM
  // nesting validator.
  code: ({ className, children, ...props }) => {
    const cls = typeof className === 'string' ? className : '';
    const text = Array.isArray(children) ? children.join('') : String(children ?? '');
    const isBlock = cls.startsWith('language-') || /\n/.test(text);
    if (isBlock) {
      return (
        <code className={cn(cls, 'block')} style={{ fontFamily: '"JetBrains Mono", monospace' }} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className={cn(
          'rounded bg-white/10 px-1 py-0.5 text-xs text-[#d6ff3f]',
          cls,
        )}
        style={{ fontFamily: '"JetBrains Mono", monospace' }}
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: (props) => (
    <pre className="my-2 overflow-x-auto rounded bg-black/40 p-3 text-xs leading-snug" style={{ fontFamily: '"JetBrains Mono", monospace' }} {...props} />
  ),
  table: (props) => <div className="my-2 overflow-x-auto rounded border border-white/10">
    <table className="w-full border-collapse text-xs" {...props} />
  </div>,
  thead: (props) => <thead className="bg-white/[0.04]" {...props} />,
  th: (props) => <th className="border-b border-white/10 px-2.5 py-1.5 text-left text-2xs uppercase tracking-[0.18em] text-white/70"
    style={{ fontFamily: '"JetBrains Mono", monospace' }} {...props} />,
  td: (props) => <td className="border-b border-white/5 px-2.5 py-1.5 align-top" {...props} />,
  blockquote: (props) => <blockquote className="my-2 border-l-2 border-white/20 pl-3 italic text-white/70" {...props} />,
  hr: (props) => <hr className="my-3 border-white/10" {...props} />,
};
