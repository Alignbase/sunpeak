import * as React from 'react';
import { useEffect, useRef, useCallback } from 'react';
import { SCREEN_WIDTHS, type ScreenWidth } from '../inspector/inspector-types';
import { isAllowedIconUrl } from '../lib/utils';
import type { McpUiDisplayMode, McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import type { HostChatMessage } from '../inspector/hosts';

type Platform = NonNullable<McpUiHostContext['platform']>;

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5.83071 5.83077C6.33839 5.32309 7.16151 5.32309 7.66919 5.83077L12 10.1615L16.3307 5.83077C16.8384 5.32309 17.6615 5.32309 18.1692 5.83077C18.6769 6.33845 18.6769 7.16157 18.1692 7.66925L13.8384 12L18.1692 16.3308C18.6769 16.8385 18.6769 17.6616 18.1692 18.1693C17.6615 18.6769 16.8384 18.6769 16.3307 18.1693L12 13.8385L7.66919 18.1693C7.16151 18.6769 6.33839 18.6769 5.83071 18.1693C5.32303 17.6616 5.32303 16.8385 5.83071 16.3308L10.1615 12L5.83071 7.66925C5.32303 7.16157 5.32303 6.33845 5.83071 5.83077Z"
      />
    </svg>
  );
}

interface ConversationProps {
  children?: React.ReactNode;
  screenWidth: ScreenWidth;
  displayMode: McpUiDisplayMode;
  platform: Platform;
  onRequestDisplayMode?: (mode: McpUiDisplayMode) => void;
  appName?: string;
  appIcon?: string;
  userMessage?: string;
  chatMessages?: HostChatMessage[];
  chatInput?: string;
  onChatInputChange?: (value: string) => void;
  onChatSubmit?: () => void;
  chatDisabled?: boolean;
  chatPlaceholder?: string;
  chatStatus?: string;
  hideChatComposer?: boolean;
  /** Optional action element rendered in the conversation header (e.g., Run button) */
  headerAction?: React.ReactNode;
  /** Called when the content container width changes */
  onContentWidthChange?: (width: number) => void;
}

function ChatComposer({
  value = '',
  onChange,
  onSubmit,
  disabled,
  placeholder,
  status,
  compact = false,
}: {
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
  disabled?: boolean;
  placeholder: string;
  status?: string;
  compact?: boolean;
}) {
  const canSend = !!onSubmit && value.trim().length > 0 && !disabled;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSubmit?.();
      }}
      className="relative"
    >
      <input
        type="text"
        name="userInput"
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        disabled={!onChange || disabled}
        placeholder={placeholder}
        className={`w-full rounded-3xl ${compact ? 'p-2.5 pr-11' : 'px-5 py-3 pr-12'} shadow-sm outline-none disabled:opacity-60`}
        style={{
          backgroundColor: 'var(--sim-bg-reply-input, var(--color-background-secondary))',
          color: 'var(--color-text-primary)',
          border: compact ? 'none' : '1px solid var(--color-border-tertiary)',
          // @ts-expect-error -- corner-shape is a newer CSS property (squircle)
          cornerShape: 'superellipse',
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && canSend) {
            event.preventDefault();
            onSubmit?.();
          }
        }}
      />
      {onSubmit && (
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full transition-opacity disabled:opacity-35"
          style={{
            backgroundColor: 'var(--color-text-primary)',
            color: 'var(--color-background-primary)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 1.5 14.5 8H10v6H6V8H1.5L8 1.5Z" />
          </svg>
        </button>
      )}
      {status && (
        <div
          className="pointer-events-none absolute bottom-full left-3 mb-1 text-[11px]"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          {status}
        </div>
      )}
    </form>
  );
}

/**
 * Conversation layout that renders children (iframe) at a stable tree position.
 *
 * All three display modes (inline, pip, fullscreen) share the same React tree
 * shape so that the iframe never unmounts when switching modes, avoiding a
 * white-flash reload.
 *
 * Visual differences are achieved purely with CSS:
 * - **inline**: content in normal document flow
 * - **pip**: content wrapper becomes `position: fixed` floating overlay
 * - **fullscreen**: content wrapper becomes `position: fixed` covering the viewport;
 *   fullscreen chrome (header/footer) rendered as a separate fixed overlay
 */
export function Conversation({
  children,
  screenWidth,
  displayMode,
  platform,
  onRequestDisplayMode,
  appName = 'Sunpeak',
  appIcon,
  userMessage = 'What have you got for me today?',
  chatMessages,
  chatInput,
  onChatInputChange,
  onChatSubmit,
  chatDisabled,
  chatPlaceholder,
  chatStatus,
  hideChatComposer = false,
  headerAction,
  onContentWidthChange,
}: ConversationProps) {
  const isDesktop = platform === 'desktop';
  const containerWidth = screenWidth === 'full' ? '100%' : `${SCREEN_WIDTHS[screenWidth]}px`;
  const isFullscreen = displayMode === 'fullscreen';
  const isPip = displayMode === 'pip';
  const hasLiveMessages = !!chatMessages?.length;
  const composerPlaceholder = chatPlaceholder ?? 'Message sunpeak.ai';

  // Measure the content container width and report it via onContentWidthChange.
  const contentRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const onContentWidthChangeRef = useRef(onContentWidthChange);
  useEffect(() => {
    onContentWidthChangeRef.current = onContentWidthChange;
  });

  const setContentRef = useCallback((node: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    contentRef.current = node;
    if (!node) return;

    const reportWidth = (width: number) => {
      const rounded = Math.round(width);
      if (rounded > 0) {
        onContentWidthChangeRef.current?.(rounded);
      }
    };

    reportWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        reportWidth(entry.contentBoxSize[0]?.inlineSize ?? entry.contentRect.width);
      }
    });
    observer.observe(node);
    resizeObserverRef.current = observer;
  }, []);

  useEffect(() => () => resizeObserverRef.current?.disconnect(), []);

  const handleClose = () => onRequestDisplayMode?.('inline');

  return (
    <div
      className="flex flex-col w-full h-full flex-1 items-center relative"
      style={{
        transform: 'translate(0)',
        backgroundColor: 'var(--sim-bg-conversation, var(--color-background-primary))',
        color: 'var(--color-text-primary)',
      }}
    >
      {/* ─── Fullscreen chrome overlay ─── */}
      {isFullscreen && (
        <div
          className="fixed start-0 end-0 top-0 bottom-0 z-[51] mx-auto flex flex-col pointer-events-none"
          style={{ maxWidth: containerWidth }}
        >
          <div
            className="z-20 flex h-[3.25rem] items-center justify-between p-2 pointer-events-auto"
            style={{
              backgroundColor: 'var(--sim-bg-conversation, var(--color-background-primary))',
            }}
          >
            <button
              onClick={handleClose}
              aria-label="Close"
              className="h-7 w-7 flex items-center justify-center rounded-lg transition-colors hover:opacity-70"
              type="button"
            >
              <CloseIcon />
            </button>
            {isDesktop && (
              <div className="flex items-center justify-center text-base">{appName}</div>
            )}
            {isDesktop && <div />}
          </div>
          {/* Spacer - pointer events pass through to content below */}
          <div className="flex-1" />
          {!hideChatComposer && (
            <footer className="relative">
              {/* Scroll fade mask — ChatGPT uses gradient mask, not backdrop blur */}
              <div
                className="absolute inset-x-0 bottom-0 h-full -z-10"
                style={{
                  maskImage: 'linear-gradient(to bottom, transparent 0%, black 50%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 50%)',
                  backgroundColor: 'var(--sim-bg-conversation, var(--color-background-primary))',
                }}
              />
              <div className="max-w-[40rem] min-[1280px]:max-w-[48rem] mx-auto px-4 pt-4 pb-4 pointer-events-auto">
                <ChatComposer
                  value={chatInput}
                  onChange={onChatInputChange}
                  onSubmit={onChatSubmit}
                  disabled={chatDisabled}
                  placeholder={composerPlaceholder}
                  status={chatStatus}
                  compact
                />
              </div>
            </footer>
          )}
        </div>
      )}

      {/* ─── Conversation header ─── */}
      {!isFullscreen && (
        <header
          className="h-12 flex items-center gap-3 px-4 text-lg sticky top-0 z-40 w-full"
          style={{
            maxWidth: containerWidth,
            backgroundColor: 'var(--sim-bg-conversation, var(--color-background-primary))',
          }}
        >
          <span>sunpeak.ai</span>
          {headerAction}
        </header>
      )}

      {/* ─── Conversation container ─── */}
      <div
        className="flex flex-col flex-1 w-full transition-all duration-200 overflow-hidden"
        style={{ maxWidth: containerWidth }}
      >
        <main className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col">
          {hasLiveMessages &&
            chatMessages!.map((message) => {
              const isUser = message.role === 'user';
              return (
                <article
                  key={message.id}
                  className="w-full focus:outline-none"
                  dir="auto"
                  data-turn={message.role}
                >
                  <div className="text-base my-auto mx-auto px-4 py-3">
                    <div className="max-w-[40rem] min-[1280px]:max-w-[48rem] mx-auto flex-1 relative flex w-full min-w-0 flex-col">
                      {isUser ? (
                        <div className="flex w-full justify-end">
                          <div
                            className="relative rounded-[22px] px-4 py-2.5 leading-6 max-w-[70%] break-words whitespace-pre-wrap"
                            style={{
                              backgroundColor:
                                'var(--sim-bg-user-bubble, var(--color-background-tertiary))',
                              color: 'var(--sim-text-user-bubble, var(--color-text-primary))',
                              // @ts-expect-error -- corner-shape is a newer CSS property (squircle)
                              cornerShape: 'superellipse',
                            }}
                          >
                            {message.content}
                          </div>
                        </div>
                      ) : (
                        <div className="flex max-w-full flex-col grow">
                          {!isFullscreen && (
                            <div className="flex items-center gap-2 my-3">
                              {appIcon ? (
                                isAllowedIconUrl(appIcon) ? (
                                  <img
                                    src={appIcon}
                                    alt=""
                                    className="size-6 rounded-full object-cover"
                                  />
                                ) : (
                                  <div className="size-6 flex items-center justify-center text-base">
                                    {appIcon}
                                  </div>
                                )
                              ) : (
                                <div
                                  className="size-6 rounded-full flex items-center justify-center font-medium text-xs text-white"
                                  style={{ backgroundColor: '#10a37f' }}
                                >
                                  AI
                                </div>
                              )}
                              <span className="font-semibold text-sm">{appName}</span>
                            </div>
                          )}
                          {message.content && !message.rendersApp && (
                            <div className="leading-6 whitespace-pre-wrap">{message.content}</div>
                          )}
                          {message.toolCalls?.map((call, index) => (
                            <div
                              key={`${call.name}-${index}`}
                              className="mt-3 rounded-xl px-3 py-2 text-xs"
                              style={{
                                backgroundColor:
                                  'var(--color-background-secondary, rgba(0,0,0,0.05))',
                                color: 'var(--color-text-secondary)',
                                border: '1px solid var(--color-border-tertiary)',
                              }}
                            >
                              <div
                                className="font-medium"
                                style={{ color: 'var(--color-text-primary)' }}
                              >
                                {call.isError ? 'Tool error' : 'Tool call'}: {call.name}
                              </div>
                              {call.arguments && Object.keys(call.arguments).length > 0 && (
                                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[11px]">
                                  {JSON.stringify(call.arguments, null, 2)}
                                </pre>
                              )}
                            </div>
                          ))}
                          {message.rendersApp && (
                            <div
                              ref={setContentRef}
                              className={
                                isPip
                                  ? 'no-scrollbar @w-xl/main:top-4 fixed start-4 end-4 top-12 z-50 mx-auto max-w-[40rem] lg:max-w-[48rem] sm:start-0 sm:end-0 sm:top-[3.25rem] sm:w-full overflow-visible'
                                  : isFullscreen
                                    ? 'no-scrollbar fixed inset-x-0 top-[3.25rem] bottom-0 z-50 mx-auto'
                                    : 'no-scrollbar relative mb-2 @w-sm/main:w-full mx-0 max-sm:-mx-[1rem] max-sm:w-[100cqw] max-sm:overflow-hidden overflow-visible'
                              }
                              style={{
                                ...(isFullscreen ? { maxWidth: containerWidth } : {}),
                                ...(isPip ? { maxHeight: 'calc(50dvh - 38px)' } : {}),
                              }}
                            >
                              {isPip && (
                                <button
                                  key="pip-close"
                                  onClick={handleClose}
                                  className="absolute -start-2 md:-start-6 -top-1.5 z-10 rounded-full bg-[#3a3a3a] p-1.25 text-white shadow-[0px_0px_0px_1px_var(--color-border-primary),0px_4px_12px_rgba(0,0,0,0.12)] hover:bg-[#6a6a6a]"
                                  aria-label="Close picture-in-picture"
                                  type="button"
                                >
                                  <CloseIcon className="h-4 w-4" />
                                </button>
                              )}
                              <div
                                key="content"
                                className={
                                  isPip
                                    ? 'relative overflow-hidden h-full rounded-2xl sm:rounded-3xl shadow-[0px_0px_0px_1px_var(--color-border-primary),0px_6px_20px_rgba(0,0,0,0.1)] md:-mx-4'
                                    : 'relative overflow-hidden h-full'
                                }
                              >
                                <div
                                  className="h-full w-full max-w-full"
                                  style={{
                                    ...(isPip
                                      ? {
                                          overflow: 'auto',
                                          backgroundColor: 'var(--color-background-primary)',
                                        }
                                      : isFullscreen
                                        ? {
                                            overflow: 'auto',
                                            backgroundColor: 'var(--color-background-primary)',
                                          }
                                        : { backgroundColor: 'transparent' }),
                                  }}
                                >
                                  {children}
                                </div>
                              </div>
                            </div>
                          )}
                          {message.content && message.rendersApp && (
                            <div className="mt-3 leading-6 whitespace-pre-wrap">
                              {message.content}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}

          {/* User turn - hidden in fullscreen */}
          {!hasLiveMessages && !isFullscreen && (
            <article className="w-full focus:outline-none" dir="auto" data-turn="user">
              <h5 className="sr-only">You said:</h5>
              <div className="text-base my-auto mx-auto md:pt-8 px-4">
                <div className="max-w-[40rem] min-[1280px]:max-w-[48rem] mx-auto flex-1 relative flex w-full min-w-0 flex-col">
                  <div className="flex max-w-full flex-col grow">
                    <div
                      data-message-author-role="user"
                      className="min-h-8 relative flex w-full flex-col items-end gap-2 text-start break-words whitespace-normal"
                    >
                      <div className="flex w-full flex-col gap-1 empty:hidden items-end">
                        <div
                          className="relative rounded-[22px] px-4 py-2.5 leading-6 max-w-[70%]"
                          style={{
                            backgroundColor:
                              'var(--sim-bg-user-bubble, var(--color-background-tertiary))',
                            color: 'var(--sim-text-user-bubble, var(--color-text-primary))',
                            // @ts-expect-error -- corner-shape is a newer CSS property (squircle)
                            cornerShape: 'superellipse',
                          }}
                        >
                          <div className="whitespace-pre-wrap">{userMessage}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          )}

          {/* Assistant turn — flex-1 so short content still pushes the input to the bottom */}
          {!hasLiveMessages && (
            <article className="w-full focus:outline-none flex-1" dir="auto" data-turn="assistant">
              <h6 className="sr-only">{appName} said:</h6>
              <div className="text-base my-auto mx-auto pb-10 px-4">
                <div className="max-w-[40rem] min-[1280px]:max-w-[48rem] mx-auto flex-1 relative flex w-full min-w-0 flex-col">
                  <div className="flex max-w-full flex-col grow">
                    {/* Assistant avatar and name - hidden in fullscreen */}
                    {!isFullscreen && (
                      <div className="flex items-center gap-2 my-3">
                        {appIcon ? (
                          isAllowedIconUrl(appIcon) ? (
                            <img
                              src={appIcon}
                              alt=""
                              className="size-6 rounded-full object-cover"
                            />
                          ) : (
                            <div className="size-6 flex items-center justify-center text-base">
                              {appIcon}
                            </div>
                          )
                        ) : (
                          <div
                            className="size-6 rounded-full flex items-center justify-center font-medium text-xs text-white"
                            style={{ backgroundColor: '#10a37f' }}
                          >
                            AI
                          </div>
                        )}
                        <span className="font-semibold text-sm">{appName}</span>
                      </div>
                    )}

                    {/* Assistant message content */}
                    <div
                      data-message-author-role="assistant"
                      className="min-h-8 relative flex w-full flex-col items-start gap-2 text-start break-words whitespace-normal"
                    >
                      <div className="flex w-full flex-col gap-1 empty:hidden">
                        {/*
                         * ─── CONTENT AREA ───
                         * Children (iframe) are always at this tree position.
                         * CSS handles visual positioning for each display mode:
                         *   inline:     normal flow (position: relative)
                         *   pip:        floating overlay (position: fixed)
                         *   fullscreen: viewport takeover (position: fixed)
                         */}
                        <div
                          ref={setContentRef}
                          className={
                            isPip
                              ? 'no-scrollbar @w-xl/main:top-4 fixed start-4 end-4 top-12 z-50 mx-auto max-w-[40rem] lg:max-w-[48rem] sm:start-0 sm:end-0 sm:top-[3.25rem] sm:w-full overflow-visible'
                              : isFullscreen
                                ? 'no-scrollbar fixed inset-x-0 top-[3.25rem] bottom-0 z-50 mx-auto'
                                : 'no-scrollbar relative mb-2 @w-sm/main:w-full mx-0 max-sm:-mx-[1rem] max-sm:w-[100cqw] max-sm:overflow-hidden overflow-visible'
                          }
                          style={{
                            ...(isFullscreen ? { maxWidth: containerWidth } : {}),
                            ...(isPip ? { maxHeight: 'calc(50dvh - 38px)' } : {}),
                          }}
                        >
                          {/* PiP close button - keyed so it doesn't shift content's position */}
                          {isPip && (
                            <button
                              key="pip-close"
                              onClick={handleClose}
                              className="absolute -start-2 md:-start-6 -top-1.5 z-10 rounded-full bg-[#3a3a3a] p-1.25 text-white shadow-[0px_0px_0px_1px_var(--color-border-primary),0px_4px_12px_rgba(0,0,0,0.12)] hover:bg-[#6a6a6a]"
                              aria-label="Close picture-in-picture"
                              type="button"
                            >
                              <CloseIcon className="h-4 w-4" />
                            </button>
                          )}
                          <div
                            key="content"
                            className={
                              isPip
                                ? 'relative overflow-hidden h-full rounded-2xl sm:rounded-3xl shadow-[0px_0px_0px_1px_var(--color-border-primary),0px_6px_20px_rgba(0,0,0,0.1)] md:-mx-4'
                                : 'relative overflow-hidden h-full'
                            }
                          >
                            <div
                              className="h-full w-full max-w-full"
                              style={{
                                ...(isPip
                                  ? {
                                      overflow: 'auto',
                                      backgroundColor: 'var(--color-background-primary)',
                                    }
                                  : isFullscreen
                                    ? {
                                        overflow: 'auto',
                                        backgroundColor: 'var(--color-background-primary)',
                                      }
                                    : { backgroundColor: 'transparent' }),
                              }}
                            >
                              {children}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          )}
        </main>

        {/* Input area - fixed to the bottom of the conversation shell.
            Hidden in fullscreen since fullscreen chrome has its own footer. */}
        {!isFullscreen && !hideChatComposer && (
          <footer
            className="relative z-10 shrink-0"
            style={{
              backgroundColor: 'var(--sim-bg-conversation, var(--color-background-primary))',
            }}
          >
            {/* Scroll fade mask — ChatGPT uses gradient mask, not backdrop blur */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-5 -translate-y-full"
              style={{
                maskImage: 'linear-gradient(to top, black 0%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to top, black 0%, transparent 100%)',
                backgroundColor: 'var(--sim-bg-conversation, var(--color-background-primary))',
              }}
            />
            <div className="max-w-[40rem] min-[1280px]:max-w-[48rem] mx-auto px-4 pt-3 pb-4">
              <ChatComposer
                value={chatInput}
                onChange={onChatInputChange}
                onSubmit={onChatSubmit}
                disabled={chatDisabled}
                placeholder={composerPlaceholder}
                status={chatStatus}
              />
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
