import type { FeatureName } from './featureOrder.ts';

/** One row of GET /sessions → { success, sessions: Session[] } (shape taken from app.py get_sessions). */
export interface Session {
  id: string;
  patient_id: string;
  subject_id: string;
  name: string;
  age: string | number;
  gender: string;
  /** Preformatted by Flask: "25 Oct 2026, 14:03" (server clock). */
  date: string;
  /** Number, the string "N/A" (key missing), or null (saved without a PANSS score). */
  panss: number | string | null;
  features: Partial<Record<FeatureName, number | string | null>>;
  notes: string;
  notes_author: string;
  has_report: boolean;
}

export type CsvType = 'fv' | 'spem' | 'sz';

/** GET /analytics success payload (shape taken from app.py get_analytics). */
export interface AnalyticsData {
  success: true;
  total_sessions: number;
  daily_counts: { date: string; count: number }[];
  panss_distribution: number[];
  gender_distribution: Record<string, number>;
  age_distribution: number[];
  feature_averages: Record<string, { mean: number; min: number; max: number; n: number }>;
}

export interface AuthUser {
  username: string;
  role: string;
}
