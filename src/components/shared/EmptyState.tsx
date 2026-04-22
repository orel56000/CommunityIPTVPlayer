import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export const EmptyState = ({ title, description, action }: EmptyStateProps) => (
  <div className="panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-8 text-center">
    <div className="h-px w-16 rounded-full bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent" aria-hidden />
    <h3 className="text-lg font-bold tracking-tight text-slate-100">{title}</h3>
    <p className="max-w-md text-sm leading-relaxed text-slate-500">{description}</p>
    {action}
  </div>
);
