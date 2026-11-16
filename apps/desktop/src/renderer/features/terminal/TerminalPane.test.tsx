// @vitest-environment jsdom
import { fixtures } from '@styx/core';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoginTerminal, disposeLoginTerminal } from '../modals/login-terminal';
import { getTerminal, detachTerminal, type TerminalEntry } from './terminal-registry';
import { TerminalPane } from './TerminalPane';

vi.mock('../modals/login-terminal', () => ({
  createLoginTerminal: vi.fn(),
  disposeLoginTerminal: vi.fn(),
}));
vi.mock('./terminal-registry', () => ({
  getTerminal: vi.fn(),
  detachTerminal: vi.fn(),
  fitTerminal: vi.fn(),
  setTerminalScreenReader: vi.fn(),
  attachTerminal: (entry: TerminalEntry, parent: HTMLElement) => parent.append(entry.host),
}));

const entry = (): TerminalEntry => ({ host: document.createElement('div') }) as TerminalEntry;
const props = {
  sessionId: fixtures.ids.session.claude,
  worktreeId: fixtures.ids.worktree.fixCheckout,
  branch: 'agent/amp-1',
  screenReader: false,
  columnHeight: () => 800,
};

describe('TerminalPane process selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createLoginTerminal).mockImplementation(entry);
    vi.mocked(getTerminal).mockImplementation(entry);
  });
  afterEach(cleanup);

  it('attaches an existing terminal agent, reattaches after a new pid, and disposes its listeners', () => {
    const { rerender, unmount } = render(
      <TerminalPane {...props} agentTerminal={{ id: props.sessionId, pid: 10 }} />,
    );
    expect(createLoginTerminal).toHaveBeenCalledWith(props.sessionId, { screenReader: false });
    expect(getTerminal).not.toHaveBeenCalled();
    rerender(<TerminalPane {...props} agentTerminal={{ id: props.sessionId, pid: 20 }} />);
    expect(disposeLoginTerminal).toHaveBeenCalledTimes(1);
    expect(createLoginTerminal).toHaveBeenCalledTimes(2);
    unmount();
    expect(disposeLoginTerminal).toHaveBeenCalledTimes(2);
    expect(detachTerminal).not.toHaveBeenCalled();
  });

  it('keeps ordinary worktree terminals on the existing cached shell path', () => {
    const { unmount } = render(<TerminalPane {...props} />);
    expect(getTerminal).toHaveBeenCalledWith(props.sessionId, props.worktreeId, { screenReader: false });
    expect(createLoginTerminal).not.toHaveBeenCalled();
    unmount();
    expect(detachTerminal).toHaveBeenCalledTimes(1);
    expect(disposeLoginTerminal).not.toHaveBeenCalled();
  });

  it('attaches a dedicated editor terminal using createLoginTerminal, focuses it, and disposes on unmount', () => {
    const focus = vi.fn();
    vi.mocked(createLoginTerminal).mockReturnValue({
      host: document.createElement('div'),
      term: { focus } as unknown as TerminalEntry['term'],
    } as TerminalEntry);

    const onExit = vi.fn();
    const { unmount } = render(
      <TerminalPane
        {...props}
        editorTerminal={{ id: 'term:neovim-1' }}
        onEditorExit={onExit}
      />,
    );
    expect(createLoginTerminal).toHaveBeenCalledWith('term:neovim-1', { screenReader: false });
    expect(focus).toHaveBeenCalled();
    expect(getTerminal).not.toHaveBeenCalled();

    unmount();
    expect(disposeLoginTerminal).toHaveBeenCalledTimes(1);
    expect(detachTerminal).not.toHaveBeenCalled();
  });

  it('invokes onEditorExit when pty onExit fires for the editorTerminal', () => {
    let exitListener: ((id: string) => void) | null = null;
    Object.assign(window, {
      styx: {
        pty: {
          onExit: vi.fn((cb: (id: string) => void) => {
            exitListener = cb;
            return () => {
              exitListener = null;
            };
          }),
        },
      },
    });

    const onExit = vi.fn();
    const { rerender } = render(
      <TerminalPane
        {...props}
        editorTerminal={{ id: 'term:neovim-1' }}
        onEditorExit={onExit}
      />,
    );

    const fireExit = (id: string) => (exitListener as ((targetId: string) => void) | null)?.(id);

    // Another terminal exiting should not trigger onEditorExit
    fireExit('term:different');
    expect(onExit).not.toHaveBeenCalled();

    // Editor terminal exiting triggers onEditorExit
    fireExit('term:neovim-1');
    expect(onExit).toHaveBeenCalledTimes(1);

    // Once editorTerminal is cleared, regular terminal is reattached
    rerender(<TerminalPane {...props} editorTerminal={null} onEditorExit={onExit} />);
    expect(getTerminal).toHaveBeenCalledWith(props.sessionId, props.worktreeId, { screenReader: false });

    Object.assign(window, { styx: undefined });
  });
});
