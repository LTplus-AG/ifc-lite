/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `BundlePreview` — read-only viewer for the files inside a bundle.
 *
 * Surfaces every file in the install bundle so the user can audit the
 * code before approving. Plays nicely with `CapabilityReview` — the
 * review modal exposes a "Show source" tab that mounts this.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §6.
 */

import { useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
import type { Bundle, BundleFile } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const DECODER = new TextDecoder();

interface BundlePreviewProps {
  bundle: Bundle;
}

export function BundlePreview({ bundle }: BundlePreviewProps) {
  const paths = useMemo(() => Array.from(bundle.files.keys()).sort(), [bundle]);
  const [selected, setSelected] = useState<string>(paths[0] ?? 'manifest.json');

  const file = bundle.files.get(selected);
  const text = useMemo(() => fileToText(file), [file]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${selected} to clipboard`);
    } catch (err) {
      toast.error(`Copy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="flex h-[420px] gap-3">
      {/* File list */}
      <ul className="w-48 shrink-0 overflow-y-auto rounded border bg-muted/30 text-[11px]">
        {paths.map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => setSelected(path)}
              className={cn(
                'w-full text-left px-2 py-1 font-mono break-all transition-colors',
                selected === path ? 'bg-primary/15 text-primary' : 'hover:bg-muted',
              )}
            >
              {path}
            </button>
          </li>
        ))}
      </ul>

      {/* Source */}
      <div className="flex-1 min-w-0 flex flex-col rounded border">
        <div className="flex items-center justify-between border-b px-2 py-1 bg-muted/30 text-[11px]">
          <code className="font-mono">{selected}</code>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void handleCopy()}
            aria-label="Copy file contents"
          >
            <Copy className="mr-1 h-3 w-3" />
            Copy
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <pre className="px-3 py-2 text-[11px] font-mono whitespace-pre-wrap break-all">
            {text}
          </pre>
        </ScrollArea>
      </div>
    </div>
  );
}

function fileToText(file: BundleFile | undefined): string {
  if (!file) return '(file missing)';
  if (file.text) return file.text;
  try {
    return DECODER.decode(file.bytes);
  } catch {
    return `(${file.bytes.byteLength} bytes — binary)`;
  }
}
