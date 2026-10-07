import type { ReactNode } from "react";

interface Props {
  title: string;
  summary: string;
  children: ReactNode;
}

export function ResultCard({ title, summary, children }: Props) {
  return (
    <details className="result-card">
      <summary>
        <strong>{title}</strong>
        <span className="result-summary">{summary}</span>
        <span className="result-toggle" aria-hidden="true" />
      </summary>
      <div className="result-content">{children}</div>
    </details>
  );
}
