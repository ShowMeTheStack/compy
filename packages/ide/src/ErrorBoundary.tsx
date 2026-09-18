import { Component, ReactNode } from 'react';

/** Keeps a bug in one panel from blanking the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidUpdate(prev: { children: ReactNode }) {
    if (this.state.error && prev.children !== this.props.children) this.setState({ error: null });
  }
  override render() {
    if (this.state.error) {
      return (
        <div className="fault-banner" data-testid="panel-error">
          This {this.props.label ?? 'panel'} hit a bug: {this.state.error.message}. Change something to retry.
        </div>
      );
    }
    return this.props.children;
  }
}
