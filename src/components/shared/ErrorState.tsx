interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  /** Label for the action button (defaults to “Retry”). */
  actionLabel?: string;
}

export const ErrorState = ({ message, onRetry, actionLabel = "Retry" }: ErrorStateProps) => (
  <div className="rounded-2xl border border-rose-500/25 bg-rose-950/30 p-4 shadow-lg shadow-rose-950/20 backdrop-blur-md">
    <p className="text-sm font-medium text-rose-200">{message}</p>
    {onRetry ? (
      <button className="btn mt-3 border-rose-500/30 bg-rose-500/15 py-2 text-xs text-rose-100 hover:bg-rose-500/25" type="button" onClick={onRetry}>
        {actionLabel}
      </button>
    ) : null}
  </div>
);
