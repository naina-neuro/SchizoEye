import type { FeatureName } from '../types/featureOrder.ts';

// Labels, units and reference ranges copied verbatim from the original showReportModal().
// Keys are typed as FeatureName, so a typo in a feature key is a compile error.
export type ReportRow = [key: FeatureName, label: string, unit: string, ref: string];
export interface ReportGroup { label: string; color: string; lightColor: string; icon: string; keys: ReportRow[] }

export const REPORT_GROUPS: ReportGroup[] = [
  {
    label: 'Free Viewing', color: '#0d4f8a', lightColor: '#e8f0fb', icon: '👁',
    keys: [
      ['fv_fnum_mean', 'Fixation Count', '', '18–28'],
      ['fv_fdur_mean', 'Fixation Duration', 'ms', '200–350'],
      ['fv_snum_mean', 'Saccade Count', '', '17–27'],
      ['fv_samp_mean', 'Saccade Amplitude', '°', '2–6'],
      ['fv_spv_mean', 'Peak Velocity', '°/s', '80–200'],
      ['fv_spl_mean', 'Scanpath Length', '°', '600–1200'],
      ['fv_disp_mean', 'Fixation Dispersion', '', '0.8–1.5'],
    ],
  },
  {
    label: 'Smooth Pursuit — HS4', color: '#145a3c', lightColor: '#e6f5ee', icon: '📈',
    keys: [
      ['HS4_Mean_H_gain', 'H-Gain', '', '0.85–1.10'],
      ['HS4_Mean_H_logSNR', 'log SNR', '', '>2.0'],
      ['HS4_Mean_H_RMSE', 'RMSE', '°', '<5.0'],
      ['HS4_SacNum', 'Saccades', '', ''],
      ['HS4_SacAmp', 'Sac Amp', '°', '<2.0'],
    ],
  },
  {
    label: 'Smooth Pursuit — LS2 & LS4', color: '#5a3e14', lightColor: '#fdf3e6', icon: '〰️',
    keys: [
      ['LS2_Mean_H_gain', 'LS2 H-Gain', '', '0.85–1.10'],
      ['LS2_Mean_H_logSNR', 'LS2 log SNR', '', '>2.0'],
      ['LS4_Mean_H_gain', 'LS4 H-Gain', '', '0.80–1.20'],
      ['LS4_Mean_H_logSNR', 'LS4 log SNR', '', '>2.0'],
      ['LS4_Mean_H_RMSE', 'LS4 RMSE', '°', '<5.0'],
    ],
  },
  {
    label: 'Fixation Stability', color: '#4a1472', lightColor: '#f3e8fc', icon: '🎯',
    keys: [
      ['fix_fs_fd', 'Pure Fix Duration', 'ms', '>500'],
      ['fix_fs_sn', 'Pure Saccades', '', '<20'],
      ['fix_fs_sa', 'Pure Sac Amplitude', '°', '<1.5'],
      ['fix_fd_fd', 'Dist Fix Duration', 'ms', '>800'],
      ['fix_fd_sn', 'Dist Saccades', '', '<10'],
      ['fix_fd_sa', 'Dist Sac Amplitude', '°', '<2.0'],
    ],
  },
  {
    label: 'Antisaccade', color: '#7a1a1a', lightColor: '#fce8e8', icon: '⚡',
    keys: [
      ['antisaccade_error_rate', 'Error Rate', '%', '<25%'],
      ['antisaccade_correction_error_rate', 'Correction Rate', '%', '<10%'],
      ['antisaccade_latency', 'Mean Latency', 'ms', '250–400'],
      ['antisaccade_accuracy', 'Accuracy', '%', '>85%'],
    ],
  },
];

/** Same formatting as the original fmt(): 3 decimals, rates/accuracy shown as percentages, "—" when missing. */
export function formatReportValue(key: string, val: unknown, unit: string): string {
  if (val === undefined || val === null || val === '') return '—';
  let display: string = typeof val === 'number' ? val.toFixed(3) : String(val);
  if (key.includes('error_rate') || key.includes('accuracy') || key.includes('correction_error')) {
    display = (parseFloat(String(val)) * 100).toFixed(1);
  }
  return display + (unit ? ' ' + unit : '');
}

export function panssStyle(panssText: string): { color: string; label: string } {
  const n = parseFloat(panssText);
  if (isNaN(n)) return { color: '#6b7280', label: 'Not recorded' };
  if (n > 90) return { color: '#b91c1c', label: 'Severe' };
  if (n > 60) return { color: '#b45309', label: 'Moderate' };
  return { color: '#166534', label: 'Mild / HC' };
}
