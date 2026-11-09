import type { AnalyticsData } from '../types/session.ts';

// Binning and labels are copied from the original renderAnalytics()/drawCharts() so the charts show the same buckets.
export const PANSS_BIN_LABELS = ['30-44', '45-59', '60-74', '75-89', '90-104', '105-119', '120-134', '135+'];
export const AGE_BIN_LABELS = ['<18', '18-27', '28-37', '38-47', '48-57', '58-67', '68+'];

export function panssBins(scores: number[]): number[] {
  const bins = new Array<number>(8).fill(0);
  for (const v of scores) {
    const b = Math.min(7, Math.floor((v - 30) / 15));
    if (b >= 0) bins[b]++;
  }
  return bins;
}

export function ageBins(ages: number[]): number[] {
  const bins = new Array<number>(7).fill(0);
  for (const a of ages) {
    if (a < 18) bins[0]++;
    else if (a < 28) bins[1]++;
    else if (a < 38) bins[2]++;
    else if (a < 48) bins[3]++;
    else if (a < 58) bins[4]++;
    else if (a < 68) bins[5]++;
    else bins[6]++;
  }
  return bins;
}

export interface SummaryStats {
  totalSessions: number;
  avgPanss: string;
  avgAge: string | number;
  withPanss: number;
}

export function summaryStats(d: Pick<AnalyticsData, 'total_sessions' | 'panss_distribution' | 'age_distribution'>): SummaryStats {
  const p = d.panss_distribution ?? [];
  const a = d.age_distribution ?? [];
  return {
    totalSessions: d.total_sessions || 0,
    avgPanss: p.length ? (p.reduce((x, y) => x + y, 0) / p.length).toFixed(1) : '—',
    avgAge: a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : '—',
    withPanss: p.length,
  };
}

export const FEAT_LABELS: Record<string, string> = {
  fv_fnum_mean: 'FV Fixation Count',
  fv_fdur_mean: 'FV Fixation Duration (ms)',
  fv_samp_mean: 'FV Saccade Amplitude (°)',
  HS4_Mean_H_gain: 'SPEM HS4 H-Gain',
  HS4_SacNum: 'SPEM HS4 Saccade Count',
  antisaccade_error_rate: 'Antisaccade Error Rate',
  antisaccade_accuracy: 'Antisaccade Accuracy',
  fix_fs_fn: 'Fixation (Single) Count',
  fix_fd_fn: 'Fixation (Distractor) Count',
};
