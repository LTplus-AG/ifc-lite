/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ChatMessage — renders a single user or assistant message.
 * Assistant messages have executable code blocks inline.
 * Streaming messages show a blinking cursor at the end.
 */

import { memo, Suspense, useCallback, useMemo, type ReactNode } from 'react';
import { User, Bot, Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { ExecutableCodeBlock } from './ExecutableCodeBlock';
import type { ChatMessage as ChatMessageType } from '@/lib/llm/types';
import { renderTextContent } from './renderTextContent';
import { lazyChunk } from '@/lib/lazy-chunk';
import { hasA2uiBlock, isA2uiFence, stripA2uiBlocks } from '@/lib/llm/a2ui-blocks';

/** A2UI surfaces load with their own chunk, only for replies that carry an `<a2ui>` block. */
const A2uiChatContent = lazyChunk(() => import('./A2uiChatContent'));

interface ChatMessageProps {
  message: ChatMessageType;
  /** Whether this is a live-streaming message */
  isStreaming?: boolean;
  /** Callback for "Fix this" error feedback */
  onFixError?: (code: string, error: string) => void;
}

type ContentPart = { type: 'text'; text: string } | { type: 'code'; index: number };

/**
 * Split assistant content into text segments and code block placeholders.
 * This allows us to render text normally and code blocks as ExecutableCodeBlock.
 */
function splitContent(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
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
    const isExecutable = !isA2uiFence(match[0]) && (['js', 'javascript', 'ts', 'typescript', ''].includes(lang.toLowerCase())
      || match[0].includes('bim.'));
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
  const withA2ui = !isUser && (!!message.a2ui || hasA2uiBlock(message.content));
  const contentParts = useMemo(
    () => isUser ? null : splitContent(withA2ui ? stripA2uiBlocks(message.content) : message.content),
    [message.content, isUser, withA2ui],
  );

  /** Prose plus executable code blocks; `codeStart` numbers this segment's blocks within the message. */
  const renderParts = useCallback((parts: ContentPart[], codeStart: number, keyPrefix: string): ReactNode[] => parts.map((part, i) => {
    if (part.type === 'text') {
      return (
        <div
          key={`${keyPrefix}${i}`}
          className="prose prose-sm dark:prose-invert max-w-none [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs"
          dangerouslySetInnerHTML={{ __html: renderTextContent(part.text) }}
        />
      );
    }
    const index = codeStart + part.index;
    const block = message.codeBlocks?.find((b) => b.index === index);
    if (!block) return null;
    return (
      <ExecutableCodeBlock
        key={`${keyPrefix}code-${i}`}
        block={block}
        messageId={message.id}
        result={message.execResults?.get(index)}
        onFixError={onFixError}
      />
    );
  }), [message.codeBlocks, message.execResults, message.id, onFixError]);

  const renderText = useCallback((text: string, codeStart: number, key: string) => {
    const parts = splitContent(text);
    return { node: <div key={key}>{renderParts(parts, codeStart, key)}</div>, codeCount: parts.filter((p) => p.type === 'code').length };
  }, [renderParts]);

  const plain = contentParts ? renderParts(contentParts, 0, '') : null;

  return (
    <div className={cn('flex gap-2 px-3 py-2', isUser ? 'bg-muted/30' : '')}>
      {/* Avatar */}
      <div className={cn(
        'shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5',
        isUser ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
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

        {/* Assistant message — rich content with code blocks, and A2UI surfaces when it carries any */}
        {!isUser && (withA2ui ? (
          <Suspense fallback={plain}>
            <A2uiChatContent message={message} isStreaming={!!isStreaming} renderText={renderText} fallback={plain} />
          </Suspense>
        ) : plain)}

        {/* Streaming cursor */}
        {isStreaming && (
          <span className="inline-block w-1.5 h-4 bg-foreground animate-pulse ml-0.5 align-text-bottom rounded-sm" />
        )}
      </div>
    </div>
  );
});
