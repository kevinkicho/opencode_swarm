'use client';

//
// React error boundary. Wraps the modal layer + inspector so a runtime
// error in any one of those subtrees can't take down the surrounding
// page chrome (footer buttons, status rail, timeline). Without this,
// a thrown error in e.g. the DiagnosticsModal during render bubbles
// up and React unmounts the whole app — leaving the user with what
// looks like an unresponsive page.
//
// Recovery is just a re-render: the error UI offers a "retry" link
// that resets `hasError` and remounts children. Errors are also
// console.error'd so they show up in dev for follow-up.

import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (err: Error, retry: () => void) => ReactNode;
  // Where this boundary sits in the tree — appears in the dev console
  // log so we can tell which boundary caught.
  scope: string;
}

interface ErrorBoundaryState {
  err: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { err: null };

  static getDerivedStateFromError(err: Error): ErrorBoundaryState {
    return { err };
  }

  componentDidCatch(err: Error): void {
    console.error(`[error-boundary:${this.props.scope}]`, err);
  }

  retry = (): void => {
    this.setState({ err: null });
  };

  render(): ReactNode {
    if (this.state.err) {
      const { fallback } = this.props;
      if (fallback) return fallback(this.state.err, this.retry);
      // Inert default: stay out of the way so footer buttons / page
      // chrome remain interactive. Tiny corner pill exposes the error
      // for retry without stealing focus.
      return (
        <div className="fixed bottom-2 right-2 z-[70] px-2 py-1 rounded hairline bg-rust/10 border-rust/40 font-mono text-[10px] uppercase tracking-widest2 text-rust">
          panel error · {' '}
          <button
            onClick={this.retry}
            className="underline decoration-dotted hover:text-rust/80"
          >
            retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
