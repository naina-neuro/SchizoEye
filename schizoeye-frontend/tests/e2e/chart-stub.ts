// Used by the e2e runner ONLY when the real chart.js package is not installed. Records what would be drawn.
type W = { __charts?: { id: string; type: string; labels: unknown; data: unknown }[]; __chartsDestroyed?: number };
export class Chart {
  constructor(ctx: { id: string }, cfg: { type: string; data: { labels: unknown; datasets: { data: unknown }[] } }) {
    const w = window as unknown as W;
    (w.__charts ||= []).push({ id: ctx.id, type: cfg.type, labels: cfg.data.labels, data: cfg.data.datasets[0].data });
  }
  destroy() { const w = window as unknown as W; w.__chartsDestroyed = (w.__chartsDestroyed || 0) + 1; }
  static register() {}
}
export const registerables: unknown[] = [];
