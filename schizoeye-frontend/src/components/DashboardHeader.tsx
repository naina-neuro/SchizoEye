import type { ReactNode } from 'react';

export function DashboardHeader(props: { title: string; user: string; role: string; children: ReactNode }) {
  return (
    <div className="dash-header">
      <div>
        <div className="dash-title">{props.title}</div>
        <div className="dash-sub">{`Signed in as: ${props.user} · ${props.role}`}</div>
      </div>
      <div className="dash-actions">{props.children}</div>
    </div>
  );
}
