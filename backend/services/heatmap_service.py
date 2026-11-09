"""Renders the free-viewing gaze heatmap (a smoothed 2D density plot) embedded in PDF reports."""
import io
import base64

import pandas as pd
import numpy as np
from scipy.ndimage import gaussian_filter
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt


def generate_heatmap_base64(fv_gaze_data):
    """Turn raw free-viewing gaze samples into a smoothed heatmap PNG, returned as a base64 data URI."""
    if not fv_gaze_data:
        return ""

    df = pd.DataFrame(fv_gaze_data)
    if 'is_blink' in df.columns:
        df_clean = df[df['is_blink'] == 0].copy()
    else:
        df_clean = df.copy()

    if df_clean.empty:
        return ""

    width = int(df_clean['x'].max()) + 100
    height = int(df_clean['y'].max()) + 100

    width = min(max(width, 800), 3000)
    height = min(max(height, 600), 3000)

    heatmap_data = np.zeros((height, width))

    for _, row in df_clean.iterrows():
        x, y = int(row['x']), int(row['y'])
        if 0 <= x < width and 0 <= y < height:
            heatmap_data[y, x] += 1

    heatmap_smoothed = gaussian_filter(heatmap_data, sigma=30)

    plt.style.use('dark_background')
    fig, ax = plt.subplots(figsize=(10, 5.625), dpi=150)

    ax.imshow(heatmap_smoothed, cmap='turbo', interpolation='bilinear',
              extent=[0, width, height, 0], aspect='auto',
              vmin=0.001 * np.max(heatmap_smoothed))

    ax.set_xticks(np.arange(0, width, 100))
    ax.set_yticks(np.arange(0, height, 100))
    ax.grid(which='major', color='#333333', linestyle='-', linewidth=0.6, alpha=0.4)

    ax.set_xticklabels([])
    ax.set_yticklabels([])
    ax.tick_params(axis='both', which='both', length=0)
    for spine in ax.spines.values():
        spine.set_visible(False)

    buf = io.BytesIO()
    plt.tight_layout(pad=0)
    plt.savefig(buf, format='png', facecolor='black', bbox_inches='tight', pad_inches=0)
    plt.close(fig)
    buf.seek(0)

    b64_str = base64.b64encode(buf.read()).decode('utf-8')
    return f"data:image/png;base64,{b64_str}"
