import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Conversation } from './chatgpt-conversation';

const defaultProps = {
  screenWidth: 'full' as const,
  displayMode: 'inline' as const,
  platform: 'desktop' as const,
};

describe('Conversation', () => {
  it('renders user message and children in assistant area', () => {
    render(
      <Conversation {...defaultProps} userMessage="Hello, show me places">
        <div data-testid="app-ui">App UI Content</div>
      </Conversation>
    );

    expect(screen.getByText('Hello, show me places')).toBeInTheDocument();
    const userBubble = screen.getByText('Hello, show me places').parentElement as HTMLElement;
    expect(userBubble.style.backgroundColor).toBe(
      'var(--sim-bg-user-bubble, var(--color-background-tertiary))'
    );
    expect(userBubble.style.color).toBe('var(--sim-text-user-bubble, var(--color-text-primary))');
    expect(screen.getByTestId('app-ui')).toBeInTheDocument();
    expect(screen.getByText('App UI Content')).toBeInTheDocument();
  });

  it('renders app name and emoji icon', () => {
    render(
      <Conversation {...defaultProps} appName="TravelBot" appIcon="✈️">
        <div>Content</div>
      </Conversation>
    );

    expect(screen.getByText('TravelBot')).toBeInTheDocument();
    expect(screen.getByText('✈️')).toBeInTheDocument();
    expect(screen.getByText('TravelBot said:', { selector: '.sr-only' })).toBeInTheDocument();
  });

  it('renders fullscreen mode with chrome overlay and stable children', () => {
    const { container } = render(
      <Conversation {...defaultProps} displayMode="fullscreen" screenWidth="tablet">
        <div data-testid="fullscreen-content">Fullscreen App</div>
      </Conversation>
    );

    // Children stay mounted at stable tree position
    const fullscreenContent = screen.getByTestId('fullscreen-content');
    expect(fullscreenContent).toBeInTheDocument();
    expect((fullscreenContent.closest('.fixed') as HTMLElement).style.maxWidth).toBe('768px');
    // Fullscreen chrome overlay has a footer with input
    expect(container.querySelector('footer')).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('Message sunpeak.ai').length).toBeGreaterThan(0);
    // Fullscreen header has a close button
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
  });

  it('lets users type and submit chat messages', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <Conversation
        {...defaultProps}
        chatInput="hello"
        onChatInputChange={onChange}
        onChatSubmit={onSubmit}
        chatMessages={[{ id: '1', role: 'user', content: 'show albums' }]}
      >
        <div data-testid="app-ui">App UI Content</div>
      </Conversation>
    );

    await user.type(screen.getByRole('textbox'), '!');
    await user.click(screen.getByLabelText('Send message'));

    expect(onChange).toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalled();
    expect(screen.getByText('show albums')).toBeInTheDocument();
  });

  it('keeps the inline composer outside the scrollable conversation body', () => {
    const { container } = render(
      <Conversation
        {...defaultProps}
        chatInput=""
        onChatInputChange={vi.fn()}
        onChatSubmit={vi.fn()}
      >
        <div data-testid="app-ui">App UI Content</div>
      </Conversation>
    );

    expect(container.querySelector('main + footer input[name="userInput"]')).toBeInTheDocument();
    expect(container.querySelector('main input[name="userInput"]')).not.toBeInTheDocument();
  });

  it('positions chat status above the composer without shifting it', () => {
    render(
      <Conversation
        {...defaultProps}
        chatInput=""
        onChatInputChange={vi.fn()}
        onChatSubmit={vi.fn()}
        chatStatus="Thinking..."
      >
        <div data-testid="app-ui">App UI Content</div>
      </Conversation>
    );

    expect(screen.getByText('Thinking...')).toHaveClass('absolute', 'bottom-full');
  });

  it('renders a model tool call with the app below it', () => {
    render(
      <Conversation
        {...defaultProps}
        chatMessages={[
          {
            id: '1',
            role: 'assistant',
            content: 'Here are the albums.',
            toolCalls: [{ name: 'show_albums', arguments: { category: 'travel' } }],
            rendersApp: true,
          },
        ]}
      >
        <div data-testid="app-ui">App UI Content</div>
      </Conversation>
    );

    expect(screen.getByText('Here are the albums.')).toBeInTheDocument();
    expect(screen.getByText('Tool call: show_albums')).toBeInTheDocument();
    expect(screen.getByTestId('app-ui')).toBeInTheDocument();
    expect(
      screen
        .getByTestId('app-ui')
        .compareDocumentPosition(screen.getByText('Here are the albums.')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
