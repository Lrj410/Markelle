import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../lib/i18n";

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

/** Keeps chrome alive when the reader/editor tree throws after a successful open. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[Markelle] render error", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const label = this.props.fallbackLabel ?? t("error.renderFailed");
    return (
      <div className="error-boundary" role="alert">
        <p className="error-boundary-title">{label}</p>
        <p className="error-boundary-msg">{this.state.error.message || String(this.state.error)}</p>
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            this.setState({ error: null });
            this.props.onReset?.();
          }}
        >
          {t("error.retry")}
        </button>
      </div>
    );
  }
}
