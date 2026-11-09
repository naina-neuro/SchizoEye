"""The 59-feature contract shared by the eye-tracking extractor (schizoeye-frontend/public/battery-controller.js)
and this backend's classifier. Name AND order must stay in lockstep with FEATURE_ORDER in battery-controller.js —
verified by schizoeye-frontend/scripts/check-feature-parity.mjs. Do not reorder, rename, add, or remove an entry
here without updating battery-controller.js and re-running that check.
"""

REQUIRED_FEATURES = [
    'fv_fnum_mean', 'fv_fdur_mean', 'fv_snum_mean', 'fv_sdur_mean', 'fv_samp_mean',
    'fv_spv_mean', 'fv_sav_mean', 'fv_spl_mean', 'fv_disp_mean', 'HS4_Mean_H_logSNR',
    'HS4_Mean_H_RMSE', 'HS4_Mean_H_gain', 'HS4_FixNum', 'HS4_FixDur', 'HS4_SacNum',
    'HS4_SacDur', 'HS4_SacAmp', 'HS4_SacPV', 'HS4_SacAV', 'LS2_Mean_H_logSNR',
    'LS2_Mean_H_RMSE', 'LS2_Mean_H_gain', 'LS2_Mean_V_logSNR', 'LS2_Mean_V_RMSE',
    'LS2_Mean_V_gain', 'LS2_FixNum', 'LS2_FixDur', 'LS2_SacNum', 'LS2_SacDur',
    'LS2_SacAmp', 'LS2_SacPV', 'LS2_SacAV', 'LS4_Mean_H_logSNR', 'LS4_Mean_H_RMSE',
    'LS4_Mean_H_gain', 'LS4_Mean_V_logSNR', 'LS4_Mean_V_RMSE', 'LS4_Mean_V_gain',
    'LS4_FixNum', 'LS4_FixDur', 'LS4_SacNum', 'LS4_SacDur', 'LS4_SacAmp',
    'LS4_SacPV', 'LS4_SacAV', 'fix_fs_fn', 'fix_fs_fd', 'fix_fs_sn', 'fix_fs_sa',
    'fix_fs_spl', 'fix_fd_fn', 'fix_fd_fd', 'fix_fd_sn', 'fix_fd_sa', 'fix_fd_spl',
    'antisaccade_error_rate', 'antisaccade_correction_error_rate',
    'antisaccade_latency', 'antisaccade_accuracy'
]
