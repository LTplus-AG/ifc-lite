/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ChatMessage — renders a single user or assistant message.
 * Assistant messages have executable code blocks inline.
 * Streaming messages show a blinking cursor at the end.
 */

import { memo, useMemo } from 'react';
import { User, Bot, Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { ExecutableCodeBlock } from './ExecutableCodeBlock';
import type { ChatMessage as ChatMessageType } from '@/lib/llm/types';
import { renderTextContent } from './renderTextContent';

interface ChatMessageProps {
  message: ChatMessageType;
  /** Whether this is a live-streaming message */
  isStreaming?: boolean;
  /** Callback for "Fix this" error feedback */
  onFixError?: (code: string, error: string) => void;
}

/**
 * Split assistant content into text segments and code block placeholders.
 * This allows us to render text normally and code blocks as ExecutableCodeBlock.
 */
function splitContent(content: string): Array<{ type: 'text'; text: string } | { type: 'code'; index: number }> {
  const parts: Array<{ type: 'text'; text: string } | { type: 'code'; index: number }> = [];
  const regex = /```\w*\n[\s\S]*?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let codeIndex = 0;

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) parts.push({ type: 'text', text });
    }
    const lang = match[0].match(/```(\w*)/)?.[1] ?? '';
    const isExecutable = ['js', 'javascript', 'ts', 'typescript', ''].includes(lang.toLowerCase())
      || match[0].includes('bim.');
    if (isExecutable) {
      parts.push({ type: 'code', index: codeIndex });
      codeIndex++;
    } else {
      parts.push({ type: 'text', text: match[0] });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) parts.push({ type: 'text', text });
  }

  return parts;
}

export const ChatMessageComponent = memo(function ChatMessageComponent({
  message,
  isStreaming,
  onFixError,
}: ChatMessageProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const contentParts = useMemo(
    () => isUser ? null : splitContent(message.content),
    [message.content, isUser],
  );

  return (
    <div className={cn('flex gap-2 px-3 py-2', isUser ? 'bg-muted/30' : '')}>
      {/* Avatar */}
      <div className={cn(
        'shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5',
        isUser ? 'bg-primary/10 text-primary' : 'bg-blue-500/10 text-blue-500',
      )}>
        {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 text-sm">
        {/* User message — plain text */}
        {isUser && (
          <>
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
            {message.attachments && message.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {message.attachments.map((a) => (
                  a.isImage && a.imageBase64 ? (
                    <img
                      key={a.id}
                      src={a.imageBase64}
                      alt={a.name}
                      className="max-w-[200px] max-h-[150px] rounded border object-contain"
                    />
                  ) : (
                    <span key={a.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted text-xs text-muted-foreground">
                      <Paperclip className="h-3 w-3" />
                      {a.name}
                      {a.csvData && (
                        <span className="opacity-60">
                          {t('chat.message.attachmentRows', { count: a.csvData.length })}
                        </span>
                      )}
                    </span>
                  )
                ))}
              </div>
            )}
          </>
        )}

        {/* Assistant message — rich content with code blocks */}
        {!isUser && contentParts && contentParts.map((part, i) => {
          if (part.type === 'text') {
            return (
              <div
                key={i}
                className="prose prose-sm dark:prose-invert max-w-none [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs"
                dangerouslySetInnerHTML={{ __html: renderTextContent(part.text) }}
              />
            );
          }
          const block = message.codeBlocks?.find((b) => b.index === part.index);
          if (!block) return null;
          const execResult = message.execResults?.get(part.index);
          return (
            <ExecutableCodeBlock
              key={`code-${i}`}
              block={block}
              messageId={message.id}
              result={execResult}
              onFixError={onFixError}
            />
          );
        })}

        {/* Streaming cursor */}
        {isStreaming && (
          <span className="inline-block w-1.5 h-4 bg-blue-500 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
        )}
      </div>
    </div>
  );
});
