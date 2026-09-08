/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface SectionHeaderProps {
  icon: React.ElementType;
  title: string;
  count?: number;
}

export function SectionHeader({ icon: IconComponent, title, count }: SectionHeaderProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-zinc-100 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
      <IconComponent className="h-3.5 w-3.5 text-zinc-500" />
      <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
        {title}
      </span>
      {count !== undefined && (
        <span className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500 ml-auto">
          {count}
        </span>
      )}
    </div>
  );
}
