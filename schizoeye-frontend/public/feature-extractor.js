/**
 * Owns the existing 59-feature pipeline. The calculation block below is moved
 * without changing its thresholds, event detector, formulas, or feature order.
 */
export const FEATURE_ORDER = [
  "fv_fnum_mean",
  "fv_fdur_mean",
  "fv_snum_mean",
  "fv_sdur_mean",
  "fv_samp_mean",
  "fv_spv_mean",
  "fv_sav_mean",
  "fv_spl_mean",
  "fv_disp_mean",
  "HS4_Mean_H_logSNR",
  "HS4_Mean_H_RMSE",
  "HS4_Mean_H_gain",
  "HS4_FixNum",
  "HS4_FixDur",
  "HS4_SacNum",
  "HS4_SacDur",
  "HS4_SacAmp",
  "HS4_SacPV",
  "HS4_SacAV",
  "LS2_Mean_H_logSNR",
  "LS2_Mean_H_RMSE",
  "LS2_Mean_H_gain",
  "LS2_Mean_V_logSNR",
  "LS2_Mean_V_RMSE",
  "LS2_Mean_V_gain",
  "LS2_FixNum",
  "LS2_FixDur",
  "LS2_SacNum",
  "LS2_SacDur",
  "LS2_SacAmp",
  "LS2_SacPV",
  "LS2_SacAV",
  "LS4_Mean_H_logSNR",
  "LS4_Mean_H_RMSE",
  "LS4_Mean_H_gain",
  "LS4_Mean_V_logSNR",
  "LS4_Mean_V_RMSE",
  "LS4_Mean_V_gain",
  "LS4_FixNum",
  "LS4_FixDur",
  "LS4_SacNum",
  "LS4_SacDur",
  "LS4_SacAmp",
  "LS4_SacPV",
  "LS4_SacAV",
  "fix_fs_fn",
  "fix_fs_fd",
  "fix_fs_sn",
  "fix_fs_sa",
  "fix_fs_spl",
  "fix_fd_fn",
  "fix_fd_fd",
  "fix_fd_sn",
  "fix_fd_sa",
  "fix_fd_spl",
  "antisaccade_error_rate",
  "antisaccade_correction_error_rate",
  "antisaccade_latency",
  "antisaccade_accuracy"
];

/** Function 1: Bind the session's measured pixels-per-degree to the pure calculations. */
export function createFeatureExtractor(pxPerDeg) {
const BOUNDS = {
  // Free viewing — counts and durations (dimensionless / ms — no spatial conversion)
  "fv_fnum_mean": { lower: 10.0,  upper: 40.0   },
  "fv_fdur_mean": { lower: 150.0, upper: 900.0  },
  "fv_snum_mean": { lower: 10.0,  upper: 40.0   },
  "fv_sdur_mean": { lower: 10.0,  upper: 100.0  },
  // Free viewing — spatial features in DEGREES
  "fv_samp_mean": { lower: 0.5,   upper: 10.0   },  // saccade amplitude (°)
  "fv_spv_mean":  { lower: 30.0,  upper: 600.0  },  // peak velocity (°/s)
  "fv_sav_mean":  { lower: 15.0,  upper: 300.0  },  // avg velocity (°/s)
"fv_spl_mean":  { lower: 100.0, upper: 1500.0 },
  "fv_disp_mean": { lower: 0.3,   upper: 2.0    },  // dimensionless ratio
  // SPEM — dimensionless / ms
  "HS4_Mean_H_logSNR": { lower: 0.2,  upper: 3.5   },
  "HS4_Mean_H_gain":   { lower: 0.4,  upper: 1.3   },
  "HS4_FixNum":        { lower: 0.0,  upper: 120.0  },
  "HS4_FixDur":        { lower: 80.0, upper: 1000.0 },
  "HS4_SacNum":        { lower: 0.0,  upper: 120.0  },
  "HS4_SacDur":        { lower: 8.0,  upper: 100.0  },
 
"HS4_Mean_H_RMSE": { lower: 0.5,   upper: 12.0  },
  // SPEM — spatial in DEGREES
  "HS4_SacAmp":        { lower: 0.3,  upper: 15.0   },  // (°)
  "HS4_SacPV":         { lower: 20.0, upper: 500.0  },  // (°/s)
  "HS4_SacAV":         { lower: 10.0, upper: 250.0  },  // (°/s)
  // LS2 — dimensionless / ms
  "LS2_Mean_H_logSNR": { lower: 0.2,  upper: 3.5   },
  "LS2_Mean_H_gain":   { lower: 0.4,  upper: 1.3   },
  "LS2_Mean_V_logSNR": { lower: 0.2,  upper: 3.5   },
  "LS2_Mean_V_gain":   { lower: 0.4,  upper: 1.3   },
  "LS2_FixNum":        { lower: 0.0,  upper: 80.0   },
  "LS2_FixDur":        { lower: 80.0, upper: 1000.0 },
  "LS2_SacNum":        { lower: 0.0,  upper: 80.0   },
  "LS2_SacDur":        { lower: 8.0,  upper: 60.0   },
"LS2_Mean_H_RMSE":   { lower: 0.5,   upper: 10.0  },
 "LS2_Mean_V_RMSE":   { lower: 0.5,   upper: 10.0  },
  // LS2 — spatial in DEGREES
  "LS2_SacAmp":        { lower: 0.3,  upper: 8.0    },
  "LS2_SacPV":         { lower: 20.0, upper: 300.0  },
  "LS2_SacAV":         { lower: 10.0, upper: 150.0  },
  // LS4 — dimensionless / ms
  "LS4_Mean_H_logSNR": { lower: 0.2,  upper: 3.5   },
  "LS4_Mean_H_gain":   { lower: 0.2,  upper: 1.5   },
  "LS4_Mean_V_logSNR": { lower: 0.2,  upper: 3.5   },
  "LS4_Mean_V_gain":   { lower: 0.2,  upper: 1.5   },
  "LS4_FixNum":        { lower: 0.0,  upper: 100.0  },
  "LS4_FixDur":        { lower: 80.0, upper: 800.0  },
  "LS4_SacNum":        { lower: 0.0,  upper: 100.0  },
  "LS4_SacDur":        { lower: 8.0,  upper: 80.0   },
 "LS4_Mean_H_RMSE":   { lower: 0.5,   upper: 12.0  },
 "LS4_Mean_V_RMSE":   { lower: 0.5,   upper: 12.0  },
  // LS4 — spatial in DEGREES
  "LS4_SacAmp":        { lower: 0.3,  upper: 10.0   },
  "LS4_SacPV":         { lower: 20.0, upper: 400.0  },
  "LS4_SacAV":         { lower: 10.0, upper: 150.0  },
  // Fixation stability — counts and durations
  "fix_fs_fn":  { lower: 0.0,  upper: 25.0    },
"fix_fs_fd":  { lower: 100.0, upper: 5000.0 },
  "fix_fs_sn":  { lower: 0.0,  upper: 25.0    },
  "fix_fs_spl": { lower: 0.0,  upper: 600.0   },  // cumulative scanpath (°)
  "fix_fs_sa":  { lower: 0.0,  upper: 6.0     },  // saccade amplitude (°)
  // Fixation distractor — counts and durations
  "fix_fd_fn":  { lower: 0.0,  upper: 30.0    },
"fix_fd_fd":  { lower: 100.0, upper: 5000.0 },
  "fix_fd_sn":  { lower: 0.0,  upper: 30.0    },
  "fix_fd_spl": { lower: 0.0,  upper: 500.0   },  // cumulative scanpath (°)
  "fix_fd_sa":  { lower: 0.0,  upper: 6.0     },  // saccade amplitude (°)
  // Antisaccade — rates (0–1) and latency (ms)
  "antisaccade_error_rate":            { lower: 0.0,   upper: 1.0   },
  "antisaccade_correction_error_rate": { lower: 0.0,   upper: 1.0   },
  "antisaccade_latency":               { lower: 100.0, upper: 900.0 },
  "antisaccade_accuracy":              { lower: 0.0,   upper: 1.0   },
};

// Extraction thresholds, task parameters, and feature scaling values.
const CONFIG = {
  fv: {
    dispersionThresholdDeg: 2.0,
    minFixMs: 60,
    ampDegPerUnit:          1.0,
    peakVelocityScale:      1.0 ,
    avgVelocityScale:       1.0 ,
    scanpathScale:          1.0 ,
    dispersionScale:        1.25,
  },
  fixationSingle: {
    phase: 'FIX_NONE',
    dispersionThresholdDeg: 1.5,
    minFixMs: 60,
    ampDegPerUnit:  1.0,
    scanpathScale:  1.0 ,   
  },
  fixationDistractor: {
    phase: ['FIX_SINGLE', 'FIX_MULTI'],
    dispersionThresholdDeg: 2.0,
    minFixMs: 60,
    ampDegPerUnit:  1.0,
    scanpathScale:  1.0 ,
  },
  pursuit: {
    sampleRate: 30,
    rmseScale: 1.0,
    minFixMs: 60,
    phaseConfig: {
      'Horizontal_0.4Hz': {
  residualDispersionThresholdDeg: 1.0,
  ampDegPerUnit:       1.0,
  peakVelocityScale:   1.0 ,
  avgVelocityScale:    1.0 ,
},
'Lissajous_0.2Hz': {
  residualDispersionThresholdDeg: 0.8,
  ampDegPerUnit:       1.0,
  peakVelocityScale:   1.0 ,
  avgVelocityScale:    1.0 ,
},
'Lissajous_0.4Hz': {
  residualDispersionThresholdDeg: 2.0,
  ampDegPerUnit:       1.0,
  peakVelocityScale:   1.0 ,
  avgVelocityScale:    1.0 ,
},
    },
  },
  antisaccade: {
    trialGapMs:                 700,
    velocityThresholdDegPerSec: 30.0,
    // Reject brief or low-amplitude threshold crossings as likely noise.
    minSaccadeDurationMs:        20,
    minSaccadeAmplitudeDeg:      1.0,
    // Exclude anticipatory responses from the latency metric.
    anticipatoryLatencyMs:       80,
    landingToleranceDeg:         5,
  },
  // Shared parameters for the adaptive velocity-threshold event detector.
  eventDetection: {
    lambda: 3,
    minSaccadeDurationMs: 20,
    minSaccadeAmplitudeDeg: 0.3,
    minThresholdDegPerSec: 3,
    maxThresholdDegPerSec: 25,
  },
};
// Used only when re-analyzing historical data without a session-specific scale.
const LEGACY_REFERENCE_PPD = 37.0;
/** Convert pixels to degrees: degrees = pixels / pixelsPerDegree. */
function px2deg(px, ppd) { return px / (Number.isFinite(ppd) && ppd > 0 ? ppd : pxPerDeg); }


/** Normalize free-viewing rows and add time and visual-angle coordinates. */
  function normalizeFv(rows, referencePpd) {
    const ppd = Number.isFinite(referencePpd) && referencePpd > 0 ? referencePpd : pxPerDeg;
  return cloneRows(rows)
    .map((row) => {
      row.tMs = Number(row.timestamp_ms);
      row.tSec = row.tMs / 1000.0;
      row.x = Number(row.x);
      row.y = Number(row.y);
      row.velocity = Number(row.velocity);
      row.image_index = Number(row.image_index);
      row.is_blink = Number(row.is_blink);
      row.confidence = Number(row.confidence);
      row.xDeg = row.x / ppd;
      row.yDeg = row.y / ppd;
      row.velocityDeg = row.velocity / ppd;
      return row;
    })
    .sort((a, b) => a.image_index - b.image_index || a.tMs - b.tMs);
}

/** Normalize SPEM rows and add time and visual-angle coordinates. */
function normalizeSpem(rows, referencePpd) {
  const ppd = Number.isFinite(referencePpd) && referencePpd > 0 ? referencePpd : pxPerDeg;
  return cloneRows(rows)
    .map((row) => {
      row.tSec = Number(row.Timestamp);
      row.tMs = row.tSec * 1000.0;
      row.TargetX = Number(row.TargetX);
      row.TargetY = Number(row.TargetY);
      row.EyeX = Number(row.EyeX);
      row.EyeY = Number(row.EyeY);
      row.TargetXDeg = row.TargetX / ppd;
      row.TargetYDeg = row.TargetY / ppd;
      row.EyeXDeg    = row.EyeX / ppd;
      row.EyeYDeg    = row.EyeY / ppd;
      row.TaskPhase = String(row.TaskPhase);
      return row;
    })
    .sort((a, b) => a.tSec - b.tSec);
}

/** Normalize SchizoEye rows and add time and visual-angle coordinates. */
function normalizeSz(rows, referencePpd) {
  const ppd = Number.isFinite(referencePpd) && referencePpd > 0 ? referencePpd : pxPerDeg;
  return cloneRows(rows)
    .map((row) => {
      row.tMs = Number(row.Timestamp_ms);
      row.tSec = row.tMs / 1000.0;
      row.Gaze_X = Number(row.Gaze_X);
      row.Gaze_Y = Number(row.Gaze_Y);
      row.Target_X = Number(row.Target_X);
      row.Target_Y = Number(row.Target_Y);
      row.Gaze_XDeg  = row.Gaze_X / ppd;
      row.Gaze_YDeg  = row.Gaze_Y / ppd;
      row.Target_XDeg = row.Target_X / ppd;
      row.Target_YDeg = row.Target_Y / ppd;
      row.Phase = String(row.Phase);
      return row;
    })
    .sort((a, b) => a.tMs - b.tMs);
}

/** Group records by the value of a selected field. */
function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const val = row[key];
    if (!map.has(val)) map.set(val, []);
    map.get(val).push(row);
  }
  return map;
}

/** Calculate the arithmetic mean of feature values. */
function _ft_mean(arr) {
  if (!arr || arr.length === 0) return NaN;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

/** Calculate the median of feature values. */
function _ft_median(arr) {
  if (!arr || arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/** Sum feature values. */
function _ft_sum(arr) {
  if (!arr || arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s;
}

/** Calculate population variance: mean squared deviation from the mean. */
function _ft_variance(arr) {
  if (!arr || arr.length === 0) return NaN;
  const m = _ft_mean(arr);
  let s = 0;
  for (const v of arr) {
    const d = v - m;
    s += d * d;
  }
  return s / arr.length;
}

/** Return unique values while preserving their first-seen order. */
function _ft_unique(arr) {
  return [...new Set(arr)];
}

/** Return the most frequent value in an array. */
function _ft_mode(arr) {
  if (!arr || arr.length === 0) return NaN;
  const counts = new Map();
  for (const v of arr) {
    const key = String(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestKey = null;
  let bestCount = -1;
  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  return Number(bestKey);
}

/** Find the minimum and maximum field values within an inclusive row range. */
function rangeOfRows(rows, startIdx, endIdx, key) {
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (let i = startIdx; i <= endIdx; i += 1) {
    const v = rows[i][key];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  return { min: minVal, max: maxVal };
}

/**
 * Detect fixations using the I-DT dispersion-threshold algorithm.
 * Formula: dispersion = (maxX - minX) + (maxY - minY).
 */
function idtFixations(rows, xKey, yKey, tMsKey, dispersionThresholdPx, minFixMs) {
  const sorted = [...rows].sort((a, b) => a[tMsKey] - b[tMsKey]);
  const fixations = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && (sorted[j][tMsKey] - sorted[i][tMsKey]) < minFixMs) {
      j += 1;
    }
    if (j >= sorted.length) break;

    /** Calculate I-DT dispersion as the sum of horizontal and vertical ranges. */
    /** Calculate dispersion as the sum of horizontal and vertical ranges. */
    const dispersion = (a, b) => {
      const xr = rangeOfRows(sorted, a, b, xKey);
      const yr = rangeOfRows(sorted, a, b, yKey);
      return (xr.max - xr.min) + (yr.max - yr.min);
    };

    if (dispersion(i, j) <= dispersionThresholdPx) {
      while (j + 1 < sorted.length && dispersion(i, j + 1) <= dispersionThresholdPx) {
        j += 1;
      }
      const segment = sorted.slice(i, j + 1);
      fixations.push({
        start: i,
        end: j,
        startMs: sorted[i][tMsKey],
        endMs: sorted[j][tMsKey],
        durMs: sorted[j][tMsKey] - sorted[i][tMsKey],
        cx: _ft_mean(segment.map((r) => r[xKey])),
        cy: _ft_mean(segment.map((r) => r[yKey])),
      });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return { fixations, rows: sorted };
}

/**
 * Detect pursuit fixations using I-DT on gaze-to-target residuals.
 * I-DT dispersion is the sum of the horizontal and vertical value ranges.
 */
function idtResidualFixations(rows, tMsKey, residualXKey, residualYKey, dispersionThresholdPx, minFixMs) {
  const sorted = [...rows].sort((a, b) => a[tMsKey] - b[tMsKey]);
  const fixations = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && (sorted[j][tMsKey] - sorted[i][tMsKey]) < minFixMs) {
      j += 1;
    }
    if (j >= sorted.length) break;

    /** Calculate residual dispersion as the sum of axis ranges. */
    /** Calculate residual dispersion as the sum of axis ranges. */
    const dispersion = (a, b) => {
      const xr = rangeOfRows(sorted, a, b, residualXKey);
      const yr = rangeOfRows(sorted, a, b, residualYKey);
      return (xr.max - xr.min) + (yr.max - yr.min);
    };

    if (dispersion(i, j) <= dispersionThresholdPx) {
      while (j + 1 < sorted.length && dispersion(i, j + 1) <= dispersionThresholdPx) {
        j += 1;
      }
      const segment = sorted.slice(i, j + 1);
      fixations.push({
        start: i,
        end: j,
        startMs: sorted[i][tMsKey],
        endMs: sorted[j][tMsKey],
        durMs: sorted[j][tMsKey] - sorted[i][tMsKey],
        cx: _ft_mean(segment.map((r) => r.EyeXDeg)),
        cy: _ft_mean(segment.map((r) => r.EyeYDeg)),
      });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return { fixations, rows: sorted };
}

// ── Gaze-event detection ────────────────────────────────────────────────────
/**
 * Estimate per-axis gaze velocity with a centered finite difference.
 * The velocity formula is Δposition / Δtime over a ±2-sample window.
 */
function ekAxisVelocity(rows, xKey, yKey, tSecKey) {
  const n = rows.length;
  const vx = new Array(n).fill(0);
  const vy = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const i0 = Math.max(0, i - 2);
    const i1 = Math.min(n - 1, i + 2);
    const dt = rows[i1][tSecKey] - rows[i0][tSecKey];
    if (dt > 1e-6) {
      vx[i] = (rows[i1][xKey] - rows[i0][xKey]) / dt;
      vy[i] = (rows[i1][yKey] - rows[i0][yKey]) / dt;
    }
  }
  return { vx, vy };
}

/**
 * Estimate velocity spread using the median of squared deviations.
 * Formula: sqrt(median((v - median(v))²)), a robust median-based SD estimate.
 */
function ekMedianBasedSD(v) {
  const med = _ft_median(v);
  const sqDev = v.map((x) => (x - med) * (x - med));
  return Math.sqrt(Math.max(_ft_median(sqDev), 0));
}

/**
 * Classify fixations and saccades with the Engbert-Kliegl adaptive velocity method.
 * Formula: (vx/ηx)² + (vy/ηy)² > 1, where η = λ × median-based SD, clamped to configured bounds.
 * Minimum duration and amplitude filters reject brief, low-amplitude noise events.
 */
function detectEventsEK(rows, detectXKey, detectYKey, measureXKey, measureYKey, tSecKey, tMsKey, opts) {
  const cfg = Object.assign(
    { lambda: 3, minDurationMs: 20, minAmplitude: 0.3,
      minThresholdDegPerSec: 3, maxThresholdDegPerSec: 25 },
    opts || {}
  );
  const sorted = [...rows].sort((a, b) => a[tSecKey] - b[tSecKey]);
  const n = sorted.length;
  if (n < 5) return { fixations: [], saccades: [], rows: sorted };

  const { vx, vy } = ekAxisVelocity(sorted, detectXKey, detectYKey, tSecKey);
  /** Clamp an adaptive velocity threshold to its configured limits. */
  const clampEta = (raw) => Math.min(Math.max(raw, cfg.minThresholdDegPerSec), cfg.maxThresholdDegPerSec);
  const etaX = clampEta(cfg.lambda * ekMedianBasedSD(vx));
  const etaY = clampEta(cfg.lambda * ekMedianBasedSD(vy));

  let fast = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const ex = vx[i] / etaX, ey = vy[i] / etaY;
    fast[i] = (ex * ex + ey * ey) > 1;
  }

  const dts = [];
  for (let i = 1; i < n; i += 1) dts.push((sorted[i][tSecKey] - sorted[i - 1][tSecKey]) * 1000);
  const medDt = _ft_median(dts) || 33;
  const minSamples = Math.max(2, Math.round(cfg.minDurationMs / medDt));

  // Reject candidate saccade runs that fail duration or amplitude criteria.
  /** Group consecutive equal event flags into indexed runs. */
  const runsOf = (flags) => {
    const out = [];
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && flags[j + 1] === flags[i]) j += 1;
      out.push({ flag: flags[i], start: i, end: j });
      i = j + 1;
    }
    return out;
  };

  let pass1 = runsOf(fast);
  const corrected = fast.slice();
  for (const run of pass1) {
    if (!run.flag) continue;
    const nSamples = run.end - run.start + 1;
    const amp = Math.hypot(
      sorted[run.end][measureXKey] - sorted[run.start][measureXKey],
      sorted[run.end][measureYKey] - sorted[run.start][measureYKey]
    );
    if (nSamples < minSamples || amp < cfg.minAmplitude) {
      for (let k = run.start; k <= run.end; k += 1) corrected[k] = false;
    }
  }

  // Rebuild event runs after rejected noise events are merged into fixations.
  const finalRuns = runsOf(corrected);
  const fixations = [];
  const saccades = [];
  for (const run of finalRuns) {
    const durMs = sorted[run.end][tMsKey] - sorted[run.start][tMsKey];
    if (run.flag) {
      // Average velocity is path length / duration; peak is the maximum segment speed.
      // Therefore peak velocity is at least the duration-weighted average speed.
      let peakV = 0, pathLen = 0;
      for (let k = run.start + 1; k <= run.end; k += 1) {
        const dt = Math.max(sorted[k][tSecKey] - sorted[k - 1][tSecKey], 1e-9);
        const segDist = Math.hypot(
          sorted[k][measureXKey] - sorted[k - 1][measureXKey],
          sorted[k][measureYKey] - sorted[k - 1][measureYKey]
        );
        pathLen += segDist;
        const segV = segDist / dt;
        if (segV > peakV) peakV = segV;
      }
      const durSec = Math.max(sorted[run.end][tSecKey] - sorted[run.start][tSecKey], 1e-9);
      saccades.push({
        start: run.start, end: run.end,
        startMs: sorted[run.start][tMsKey], endMs: sorted[run.end][tMsKey],
        durMs,
        ampPx: Math.hypot(
          sorted[run.end][measureXKey] - sorted[run.start][measureXKey],
          sorted[run.end][measureYKey] - sorted[run.start][measureYKey]
        ),
        pathPx: pathLen,
        peakVelocityPxPerSec: peakV,
        avgVelocityPxPerSec: pathLen / durSec,
      });
    } else {
      const seg = sorted.slice(run.start, run.end + 1);
      fixations.push({
        start: run.start, end: run.end,
        startMs: sorted[run.start][tMsKey], endMs: sorted[run.end][tMsKey],
        durMs,
        cx: _ft_mean(seg.map((r) => r[measureXKey])),
        cy: _ft_mean(seg.map((r) => r[measureYKey])),
      });
    }
  }
  return { fixations, saccades, rows: sorted };
}

/** Calculate point-to-point gaze speed as distance divided by elapsed time. */
function computePointSpeeds(rows, xKey, yKey, tSecKey) {
  const sorted = [...rows].sort((a, b) => a[tSecKey] - b[tSecKey]);
  const speed = new Array(sorted.length).fill(0);
  for (let i = 1; i < sorted.length; i += 1) {
    const dt = sorted[i][tSecKey] - sorted[i - 1][tSecKey];
    if (dt <= 0) {
      speed[i] = 0;
      continue;
    }
    const dx = sorted[i][xKey] - sorted[i - 1][xKey];
    const dy = sorted[i][yKey] - sorted[i - 1][yKey];
    speed[i] = Math.hypot(dx, dy) / dt;
  }
  return speed;
}

/** Measure the gaze movement between each consecutive pair of fixations. */
function buildTransitions(fixations, rows, xKey, yKey, tSecKey, tMsKey, speedPxPerSec) {
  const out = [];
  if (fixations.length < 2) return out;
  for (let i = 0; i < fixations.length - 1; i += 1) {
    const a = fixations[i];
    const b = fixations[i + 1];
    const start = a.end;
    const end = b.start;
    if (end <= start) continue;

    let pathPx = 0;
    for (let j = start + 1; j <= end; j += 1) {
      pathPx += Math.hypot(rows[j][xKey] - rows[j - 1][xKey], rows[j][yKey] - rows[j - 1][yKey]);
    }

    let peakVelocity = 0;
    for (let j = start; j <= end; j += 1) {
      if (speedPxPerSec[j] > peakVelocity) peakVelocity = speedPxPerSec[j];
    }

    const durMs = rows[end][tMsKey] - rows[start][tMsKey];
    const durSec = Math.max(rows[end][tSecKey] - rows[start][tSecKey], 1e-9);
    out.push({
      durMs,
      ampPx: Math.hypot(b.cx - a.cx, b.cy - a.cy),
      pathPx,
      peakVelocityPxPerSec: peakVelocity,
      avgVelocityPxPerSec: pathPx / durSec,
    });
  }
  return out;
}

/** Estimate screen width, height, and diagonal in degrees of visual angle. */
function estimateScreenGeometry(fvRows, spRows, szRows) {
  // Screen dimensions in degrees
  const wDeg = px2deg(window.innerWidth);
  const hDeg = px2deg(window.innerHeight);
  return { width: wDeg, height: hDeg, diag: Math.hypot(wDeg, hDeg) };
}

/**
 * Resample irregular measurements onto a uniform time grid by linear interpolation.
 * Formula: y = y0 + ((t - t0) / (t1 - t0)) × (y1 - y0).
 */
function resampleLinear(times, values, sampleRate) {
  if (!times.length || !values.length || times.length !== values.length) {
    return { times: [], values: [] };
  }
  const start = times[0];
  const end = times[times.length - 1];
  const dt = 1.0 / sampleRate;
  const outT = [];
  const outY = [];
  let j = 0;
  for (let t = start; t <= end + 1e-9; t += dt) {
    while (j < times.length - 2 && times[j + 1] < t) {
      j += 1;
    }
    const t0 = times[j];
    const t1 = times[Math.min(j + 1, times.length - 1)];
    const y0 = values[j];
    const y1 = values[Math.min(j + 1, values.length - 1)];
    let y = y0;
    if (t1 > t0) {
      const alpha = (t - t0) / (t1 - t0);
      y = y0 + alpha * (y1 - y0);
    }
    outT.push(t);
    outY.push(y);
  }
  return { times: outT, values: outY };
}

/** Apply the standard Hann window: w[n] = 0.5(1 - cos(2πn/(N - 1))). */
function hannWindow(values) {
  const n = values.length;
  if (n < 2) return values.slice();
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const w = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / (n - 1));
    out[i] = values[i] * w;
  }
  return out;
}

/**
 * Estimate sinusoidal amplitude with the discrete Fourier transform.
 * Formula: amplitude = 2 × sqrt(Re² + Im²) / (N × Hann coherent gain).
 */
function amplitudeAtFrequency(times, values, frequencyHz) {
  if (!times.length || !values.length) return NaN;
  const centered = hannWindow(values.map((v) => v - _ft_mean(values)));
  const n = centered.length;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i += 1) {
    const angle = -2.0 * Math.PI * frequencyHz * times[i];
    re += centered[i] * Math.cos(angle);
    im += centered[i] * Math.sin(angle);
  }
  // Correct the Hann window's coherent gain when scaling the amplitude.
  return (2.0 * Math.hypot(re, im)) / Math.max(n * 0.5, 1e-9);
}

/**
 * Calculate the one-sided periodogram using the discrete Fourier transform.
 * Formula: power[k] = (Re² + Im²) / (N × Hann mean-square gain).
 */
function periodogram(values, sampleRate) {
  const centered = hannWindow(values.map((v) => v - _ft_mean(values)));
  const n = centered.length;
  const maxK = Math.floor(n / 2);
  const freqs = new Array(maxK + 1);
  const power = new Array(maxK + 1);
  // Correct for the Hann window's mean-square gain.
  const windowPowerGain = 0.375; // mean-square of a Hann window
  for (let k = 0; k <= maxK; k += 1) {
    let re = 0;
    let im = 0;
    const angleConst = (-2.0 * Math.PI * k) / n;
    for (let i = 0; i < n; i += 1) {
      const angle = angleConst * i;
      re += centered[i] * Math.cos(angle);
      im += centered[i] * Math.sin(angle);
    }
    freqs[k] = (k * sampleRate) / n;
    power[k] = (re * re + im * im) / Math.max(n * windowPowerGain, 1e-9);
  }
  return { freqs, power };
}

/** Return the index of the value closest to the target. */
function nearestIndex(values, target) {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const diff = Math.abs(values[i] - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

/**
 * Compute log signal-to-noise ratio around the stimulus frequency.
 * Formula: log10(signal-bin power / mean neighboring noise-bin power).
 */
function computeLogSNR(times, values, frequencyHz, sampleRate) {
  const uniform = resampleLinear(times, values, sampleRate);
  if (uniform.values.length < 8) return NaN;
  const { freqs, power } = periodogram(uniform.values, sampleRate);
  const idx = nearestIndex(freqs, frequencyHz);
  const signal = power[idx];
  const noiseBins = [];
  for (let i = 0; i < freqs.length; i += 1) {
    const delta = Math.abs(freqs[i] - frequencyHz);
    if (delta > 0.05 && delta <= 0.30) noiseBins.push(power[i]);
  }
  const noise = noiseBins.length ? _ft_mean(noiseBins) : _ft_mean(power.filter((_, i) => i !== idx));
  const snr = signal / Math.max(noise, 1e-9);
  return Math.log10(Math.max(snr, 1e-9));
}

/** Pursuit gain formula: eye-motion amplitude / target-motion amplitude. */
function computeGain(times, eyeValues, targetValues, frequencyHz, sampleRate) {
  const eye = resampleLinear(times, eyeValues, sampleRate);
  const target = resampleLinear(times, targetValues, sampleRate);
  if (!eye.values.length || !target.values.length) return NaN;
  const eyeAmp = amplitudeAtFrequency(eye.times, eye.values, frequencyHz);
  const targetAmp = amplitudeAtFrequency(target.times, target.values, frequencyHz);
  return eyeAmp / Math.max(targetAmp, 1e-9);
}

/**
 * Calculate root mean square error between paired measurements.
 * Formula: RMSE = sqrt(mean((a - b)²)).
 */
function computeRmse(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return NaN;
  let s = 0;
  for (let i = 0; i < n; i += 1) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s / n);
}

/** Extract fixation, saccade, and gaze-dispersion features from free viewing. */
function extractFreeViewing(fvRows, screen) {
  const groups = groupBy(fvRows, "image_index");
  const perImage = [];
  for (const rows of groups.values()) {
    const clean = rows
      .filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.tMs))
      .sort((a, b) => a.tMs - b.tMs);
    if (clean.length < 8) continue;
    const { fixations, saccades: transitions, rows: ordered } = detectEventsEK(
      clean,
      "xDeg", "yDeg", "xDeg", "yDeg",
      "tSec", "tMs",
      CONFIG.eventDetection
    );
    if (fixations.length < 2) continue;

    const centersX = fixations.map((f) => f.cx);
    const centersY = fixations.map((f) => f.cy);
    const disp =
      (((Math.max(...centersX) - Math.min(...centersX)) + (Math.max(...centersY) - Math.min(...centersY))) /
        Math.max(screen.diag, 1e-9)) *
      CONFIG.fv.dispersionScale;
    perImage.push({
      fv_fnum_mean: fixations.length,
      fv_fdur_mean: _ft_mean(fixations.map((f) => f.durMs)),
      fv_snum_mean: transitions.length,
      fv_sdur_mean: _ft_mean(transitions.map((s) => s.durMs)),
      fv_samp_mean: _ft_mean(transitions.map((s) => s.ampPx / CONFIG.fv.ampDegPerUnit)),
      fv_spv_mean:  _ft_mean(transitions.map((s) => s.peakVelocityPxPerSec / CONFIG.fv.peakVelocityScale)),
      fv_sav_mean:  _ft_mean(transitions.map((s) => s.avgVelocityPxPerSec / CONFIG.fv.avgVelocityScale)),
      fv_spl_mean: _ft_sum(transitions.map((s) => s.pathPx)),
      fv_disp_mean: disp,
    });
  }

  const out = {};
  for (const feature of FEATURE_ORDER.filter((name) => name.startsWith("fv_"))) {
    if(perImage.map((r) => r[feature]).filter(Number.isFinite).length===0){out[feature]=0; continue; }
    if (feature === 'fv_spl_mean') {
      // Scanpath length is cumulative across images; other metrics are averaged.
      out[feature] = _ft_sum(perImage.map((r) => r[feature]).filter(Number.isFinite));
    } else {
      out[feature] = _ft_mean(perImage.map((r) => r[feature]).filter(Number.isFinite));
    }
  }
  return out;
}

/** Parse the stimulus frequency in hertz from a phase name. */
function parseBaseFrequency(phaseName) {
  const match = String(phaseName).match(/([0-9.]+)Hz/i);
  return match ? Number(match[1]) : NaN;
}

/** Extract pursuit quality and eye-movement features for each SPEM sequence. */
function extractPursuit(spRows) {
  const out = {};
  const phaseGroups = groupBy(spRows, "TaskPhase");
  const sampleRate = CONFIG.pursuit.sampleRate;

  for (const [phaseName, cfg] of Object.entries(CONFIG.pursuit.phaseConfig)) {
    const rows = (phaseGroups.get(phaseName) || [])
      .filter((r) =>
        Number.isFinite(r.tSec) &&
        Number.isFinite(r.EyeX) &&
        Number.isFinite(r.EyeY) &&
        Number.isFinite(r.TargetX) &&
        Number.isFinite(r.TargetY)
      )
      .map((r) => ({
        ...r,
        residualX: r.EyeXDeg - r.TargetXDeg,
        residualY: r.EyeYDeg - r.TargetYDeg,
      }))
      .sort((a, b) => a.tSec - b.tSec);

    if (!rows.length) continue;

    // Detect catch-up saccades from gaze-minus-target residuals, but measure
    // their kinematics on the eye trajectory.
    const { fixations, saccades: transitions, rows: ordered } = detectEventsEK(
      rows,
      "residualX", "residualY", "EyeXDeg", "EyeYDeg",
      "tSec", "tMs",
      { lambda: CONFIG.eventDetection.lambda,
        minDurationMs: CONFIG.eventDetection.minSaccadeDurationMs,
        minAmplitude: CONFIG.eventDetection.minSaccadeAmplitudeDeg,
        minThresholdDegPerSec: CONFIG.eventDetection.minThresholdDegPerSec,
        maxThresholdDegPerSec: CONFIG.eventDetection.maxThresholdDegPerSec }
    );

    const baseHz = parseBaseFrequency(phaseName);
    const fixMeanDur = _ft_mean(fixations.map((f) => f.durMs));
    const meanSacDur = _ft_mean(transitions.map((s) => s.durMs));

    // Exclude detected saccade samples so catch-up movements do not dominate
    // pursuit gain, RMSE, or signal-to-noise estimates.
    const saccadeMask = new Array(ordered.length).fill(false);
    for (const s of transitions) {
      for (let k = s.start; k <= s.end; k += 1) saccadeMask[k] = true;
    }
    const pursuitIdx = [];
    for (let i = 0; i < ordered.length; i += 1) if (!saccadeMask[i]) pursuitIdx.push(i);

    const times   = pursuitIdx.map((i) => ordered[i].tSec);
    const eyeX    = pursuitIdx.map((i) => ordered[i].EyeXDeg);
    const eyeY    = pursuitIdx.map((i) => ordered[i].EyeYDeg);
    const targetX = pursuitIdx.map((i) => ordered[i].TargetXDeg);
    const targetY = pursuitIdx.map((i) => ordered[i].TargetYDeg);

    if (phaseName === "Horizontal_0.4Hz") {
      out.HS4_Mean_H_logSNR = computeLogSNR(times, eyeX, baseHz, sampleRate);
      out.HS4_Mean_H_RMSE   = computeRmse(eyeX, targetX) * CONFIG.pursuit.rmseScale;  // degrees, desaccaded
      out.HS4_Mean_H_gain   = computeGain(times, eyeX, targetX, baseHz, sampleRate);
      out.HS4_FixNum = fixations.length;
      out.HS4_FixDur = fixMeanDur;
      out.HS4_SacNum = transitions.length;
      out.HS4_SacDur = meanSacDur;
      out.HS4_SacAmp = _ft_mean(transitions.map((s) => s.ampPx / cfg.ampDegPerUnit));
      out.HS4_SacPV  = _ft_mean(transitions.map((s) => s.peakVelocityPxPerSec / cfg.peakVelocityScale));
      out.HS4_SacAV  = _ft_mean(transitions.map((s) => s.avgVelocityPxPerSec / cfg.avgVelocityScale));
    } else if (phaseName === "Lissajous_0.2Hz") {
      out.LS2_Mean_H_logSNR = computeLogSNR(times, eyeX, baseHz, sampleRate);
      out.LS2_Mean_H_RMSE   = computeRmse(eyeX, targetX) * CONFIG.pursuit.rmseScale;  // degrees, desaccaded
      out.LS2_Mean_H_gain   = computeGain(times, eyeX, targetX, baseHz, sampleRate);
      out.LS2_Mean_V_logSNR = computeLogSNR(times, eyeY, baseHz * 2.0, sampleRate);
      out.LS2_Mean_V_RMSE   = computeRmse(eyeY, targetY) * CONFIG.pursuit.rmseScale;  // degrees, desaccaded
      out.LS2_Mean_V_gain   = computeGain(times, eyeY, targetY, baseHz * 2.0, sampleRate);
      out.LS2_FixNum = fixations.length;
      out.LS2_FixDur = fixMeanDur;
      out.LS2_SacNum = transitions.length;
      out.LS2_SacDur = meanSacDur;
      out.LS2_SacAmp = _ft_mean(transitions.map((s) => s.ampPx / cfg.ampDegPerUnit));
      out.LS2_SacPV  = _ft_mean(transitions.map((s) => s.peakVelocityPxPerSec / cfg.peakVelocityScale));
      out.LS2_SacAV  = _ft_mean(transitions.map((s) => s.avgVelocityPxPerSec / cfg.avgVelocityScale));
    } else if (phaseName === "Lissajous_0.4Hz") {
      out.LS4_Mean_H_logSNR = computeLogSNR(times, eyeX, baseHz, sampleRate);
      out.LS4_Mean_H_RMSE   = computeRmse(eyeX, targetX) * CONFIG.pursuit.rmseScale;  // degrees, desaccaded
      out.LS4_Mean_H_gain   = computeGain(times, eyeX, targetX, baseHz, sampleRate);
      out.LS4_Mean_V_logSNR = computeLogSNR(times, eyeY, baseHz * 2.0, sampleRate);
      out.LS4_Mean_V_RMSE   = computeRmse(eyeY, targetY) * CONFIG.pursuit.rmseScale;  // degrees, desaccaded
      out.LS4_Mean_V_gain   = computeGain(times, eyeY, targetY, baseHz * 2.0, sampleRate);
      out.LS4_FixNum = fixations.length;
      out.LS4_FixDur = fixMeanDur;
      out.LS4_SacNum = transitions.length;
      out.LS4_SacDur = meanSacDur;
      out.LS4_SacAmp = _ft_mean(transitions.map((s) => s.ampPx / cfg.ampDegPerUnit));
      out.LS4_SacPV  = _ft_mean(transitions.map((s) => s.peakVelocityPxPerSec / cfg.peakVelocityScale));
      out.LS4_SacAV  = _ft_mean(transitions.map((s) => s.avgVelocityPxPerSec / cfg.avgVelocityScale));
    }
  }
  return out;
}
/** Summarize fixations and saccades for one or more fixation conditions.
 * The dispersion argument remains for call-site compatibility; detection uses CONFIG.eventDetection.
 */
function extractFixationCondition(szRows, phaseName, dispersionThresholdDeg, ampDegPerUnit, scanpathScale) {
  const phases = Array.isArray(phaseName) ? phaseName : [phaseName];
  const rows = szRows
    .filter((r) => phases.includes(r.Phase))
    .filter((r) => Number.isFinite(r.tMs) && Number.isFinite(r.Gaze_X) && Number.isFinite(r.Gaze_Y))
    .sort((a, b) => a.tMs - b.tMs);

  const { fixations, saccades: transitions } = detectEventsEK(
    rows, 'Gaze_XDeg', 'Gaze_YDeg', 'Gaze_XDeg', 'Gaze_YDeg', 'tSec', 'tMs',
    CONFIG.eventDetection
  );

  return {
    fixNum: fixations.length,
    fixDur: _ft_mean(fixations.map((f) => f.durMs)),
    sacNum: transitions.length,
    sacAmp: _ft_mean(transitions.map((s) => s.ampPx / ampDegPerUnit)),
    scanpath: _ft_sum(transitions.map((s) => s.pathPx / scanpathScale)),
  };
}

/** Split antisaccade samples into trials when the time gap exceeds a limit. */
function splitAntisaccadeTrials(szRows, gapMs) {
  const ant = szRows
    .filter((r) => r.Phase === "ANTISACCADE")
    .filter((r) => Number.isFinite(r.tMs) && Number.isFinite(r.Gaze_XDeg) && Number.isFinite(r.Target_XDeg))
    .sort((a, b) => a.tMs - b.tMs);

  if (!ant.length) return [];
  const trials = [];
  let start = 0;
  for (let i = 1; i < ant.length; i += 1) {
    if ((ant[i].tMs - ant[i - 1].tMs) > gapMs) {
      trials.push(ant.slice(start, i));
      start = i;
    }
  }
  trials.push(ant.slice(start));
  return trials;
}

/** Estimate screen center from fixation targets, with a geometry fallback. */
function estimateCenterX(szRows, screen) {
  const stableTargets = szRows
    .filter((r) => r.Phase !== "ANTISACCADE")
    .map((r) => r.Target_XDeg)
    .filter(Number.isFinite);
  if (stableTargets.length) return _ft_median(stableTargets);
  return screen.width / 2.0;
}

/** Find the first sustained, threshold-crossing saccade meeting amplitude criteria. */
function findQualifyingSaccadeOnset(trial, vx, velocityThreshold, minSamples, minAmplitudeDeg) {
  let i = 1;
  while (i < vx.length) {
    if (Math.abs(vx[i]) >= velocityThreshold) {
      const dir = Math.sign(vx[i]);
      let j = i;
      while (j + 1 < vx.length && Math.abs(vx[j + 1]) >= velocityThreshold && Math.sign(vx[j + 1]) === dir) {
        j += 1;
      }
      const nSamples = j - i + 1;
      const amp = Math.abs(trial[j].Gaze_XDeg - trial[i - 1].Gaze_XDeg);
      if (nSamples >= minSamples && amp >= minAmplitudeDeg) {
        return { onsetIdx: i, dir };
      }
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return null;
}

/**
 * Calculate antisaccade error, correction, latency, and accuracy features.
 * Expected target reflection: x_correct = 2 × centerX − targetX.
 * Error rate = error trials / trials; accuracy = correct trials / trials.
 */
function extractAntisaccade(szRows, screen) {
  const centerX = estimateCenterX(szRows, screen);
  const trials = splitAntisaccadeTrials(szRows, CONFIG.antisaccade.trialGapMs);
  const velocityThreshold = CONFIG.antisaccade.velocityThresholdDegPerSec;
  const landingToleranceDeg = CONFIG.antisaccade.landingToleranceDeg;
  const minAmplitudeDeg = CONFIG.antisaccade.minSaccadeAmplitudeDeg;
  const anticipatoryMs = CONFIG.antisaccade.anticipatoryLatencyMs;

  const initialErrors = [];
  const correctionErrors = [];
  const latencies = [];
  const accuracies = [];

  for (const trial of trials) {
    if (trial.length < 3) continue;
    const targetX = trial[0].Target_XDeg;
    const correctX = 2.0 * centerX - targetX;
    const correctDir = Math.sign(correctX - centerX) || 1;

    // Smoothed velocity: short central-difference window (same style as
    // ekAxisVelocity) instead of a raw single-sample backward difference.
    const vx = new Array(trial.length).fill(0);
    for (let i = 0; i < trial.length; i += 1) {
      const i0 = Math.max(0, i - 2);
      const i1 = Math.min(trial.length - 1, i + 2);
      const dt = trial[i1].tSec - trial[i0].tSec;
      if (dt > 1e-6) vx[i] = (trial[i1].Gaze_XDeg - trial[i0].Gaze_XDeg) / dt;
    }

    // Convert the minimum duration to samples using this trial's median interval.
    const dts = [];
    for (let i = 1; i < trial.length; i += 1) dts.push((trial[i].tSec - trial[i - 1].tSec) * 1000);
    const medDt = _ft_median(dts) || 33;
    const minSamples = Math.max(2, Math.round(CONFIG.antisaccade.minSaccadeDurationMs / medDt));

    const onset = findQualifyingSaccadeOnset(trial, vx, velocityThreshold, minSamples, minAmplitudeDeg);

    const initialError = onset ? onset.dir !== correctDir : false;
    initialErrors.push(initialError);

    let corrected = false;
    for (const row of trial) {
      if (Math.abs(row.Gaze_XDeg - correctX) <= landingToleranceDeg) {
        corrected = true;
        break;
      }
    }

    if (initialError) {
      correctionErrors.push(!corrected);
    }

    if (!initialError && onset) {
      const latencyMs = trial[onset.onsetIdx].tMs - trial[0].tMs;
      if (latencyMs >= anticipatoryMs) {
        latencies.push(latencyMs);
      }
      // else: anticipatory — excluded from the latency estimate, but the
      // trial's error/accuracy classification above already stands.
    }

    const finalCorrect = Math.abs(trial[trial.length - 1].Gaze_XDeg - correctX) <= landingToleranceDeg;
    accuracies.push(corrected || finalCorrect);
  }

  return {
    antisaccade_error_rate: _ft_mean(initialErrors.map((v) => (v ? 1 : 0))),
    antisaccade_correction_error_rate: correctionErrors.length
      ? _ft_mean(correctionErrors.map((v) => (v ? 1 : 0)))
      : 0,
    antisaccade_latency: _ft_mean(latencies),
    antisaccade_accuracy: _ft_mean(accuracies.map((v) => (v ? 1 : 0))),
  };
}

/** Round feature values according to the precision required by their type. */
function roundFeature(name, value) {
  const threeDecimal =
    name.includes("logSNR") ||
    name.includes("gain") ||
    name.includes("disp") ||
    name.includes("error_rate") ||
    name.includes("accuracy");
  const digits = threeDecimal ? 3 : 2;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// Features in this set use the midpoint of their bounds when no valid estimate exists.
const NA_FALLBACK_MIDPOINT = new Set([
  "antisaccade_latency",
  "HS4_SacDur", "HS4_SacAmp", "HS4_SacPV", "HS4_SacAV",
  "LS2_SacDur", "LS2_SacAmp", "LS2_SacPV", "LS2_SacAV",
  "LS4_SacDur", "LS4_SacAmp", "LS4_SacPV", "LS4_SacAV",
  "HS4_Mean_H_logSNR", "HS4_Mean_H_RMSE", "HS4_Mean_H_gain",
  "LS2_Mean_H_logSNR", "LS2_Mean_H_RMSE", "LS2_Mean_H_gain",
  "LS2_Mean_V_logSNR", "LS2_Mean_V_RMSE", "LS2_Mean_V_gain",
  "LS4_Mean_H_logSNR", "LS4_Mean_H_RMSE", "LS4_Mean_H_gain",
  "LS4_Mean_V_logSNR", "LS4_Mean_V_RMSE", "LS4_Mean_V_gain",
  "fix_fs_sa", "fix_fd_sa",
  "fv_samp_mean", "fv_spv_mean", "fv_sav_mean", "fv_sdur_mean", "fv_fdur_mean",
  "HS4_FixDur", "LS2_FixDur", "LS4_FixDur",
]);

/** Replace missing feature values, clamp to bounds, and apply final rounding. */
function finalizeFeature(name, rawValue) {
  let value = rawValue;
  let lowConfidence = false;
  const bound = BOUNDS[name] || {};
  if (!Number.isFinite(value)) {
    lowConfidence = true;
    if (NA_FALLBACK_MIDPOINT.has(name) && Number.isFinite(bound.lower) && Number.isFinite(bound.upper)) {
      value = (bound.lower + bound.upper) / 2;
    } else {
      value = Number.isFinite(bound.lower) ? bound.lower : 0;
    }
  }
  if (Number.isFinite(bound.lower)) value = Math.max(bound.lower, value);
  if (Number.isFinite(bound.upper)) value = Math.min(bound.upper, value);
  return { value: roundFeature(name, value), lowConfidence };
}

/** Create a shallow copy of each data row before normalization. */
function cloneRows(rows) {
  return rows.map((row) => ({ ...row }));
}

  /** Function 2: Normalize the three task streams and produce the ordered feature vector. */
  function extractSessionFeatures(fvRaw, spRaw, szRaw) {
    const fvRows2 = normalizeFv(fvRaw, pxPerDeg);
    const spRows2 = normalizeSpem(spRaw, pxPerDeg);
    const szRows2 = normalizeSz(szRaw, pxPerDeg);
    const screen = estimateScreenGeometry(fvRows2, spRows2, szRows2);

    const featureMeasurements = {};
    Object.assign(featureMeasurements, extractFreeViewing(fvRows2, screen));
    Object.assign(featureMeasurements, extractPursuit(spRows2));

    const fixationSingle = extractFixationCondition(
      szRows2,
      CONFIG.fixationSingle.phase,
      CONFIG.fixationSingle.dispersionThresholdDeg,
      CONFIG.fixationSingle.ampDegPerUnit,
      CONFIG.fixationSingle.scanpathScale,
    );
    featureMeasurements.fix_fs_fn = fixationSingle.fixNum;
    featureMeasurements.fix_fs_fd = fixationSingle.fixDur;
    featureMeasurements.fix_fs_sn = fixationSingle.sacNum;
    featureMeasurements.fix_fs_sa = fixationSingle.sacAmp;
    featureMeasurements.fix_fs_spl = fixationSingle.scanpath;

    const fixationDistractor = extractFixationCondition(
      szRows2,
      CONFIG.fixationDistractor.phase,
      CONFIG.fixationDistractor.dispersionThresholdDeg,
      CONFIG.fixationDistractor.ampDegPerUnit,
      CONFIG.fixationDistractor.scanpathScale,
    );
    featureMeasurements.fix_fd_fn = fixationDistractor.fixNum;
    featureMeasurements.fix_fd_fd = fixationDistractor.fixDur;
    featureMeasurements.fix_fd_sn = fixationDistractor.sacNum;
    featureMeasurements.fix_fd_sa = fixationDistractor.sacAmp;
    featureMeasurements.fix_fd_spl = fixationDistractor.scanpath;

    Object.assign(featureMeasurements, extractAntisaccade(szRows2, screen));

    const finalFeatures = {};
    const dataQuality = {};
    for (const name of FEATURE_ORDER) {
      const result = finalizeFeature(name, featureMeasurements[name]);
      finalFeatures[name] = result.value;
      if (result.lowConfidence) dataQuality[name] = 'insufficient_valid_data';
    }
    return { finalFeatures, dataQuality };
  }

  return { extractSessionFeatures };
}
