import pandas as pd, numpy as np, xgboost as xgb, joblib, json
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import LabelEncoder
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import roc_auc_score, accuracy_score, f1_score, log_loss, confusion_matrix, classification_report

df = pd.read_csv("synthetic_eye_tracking_3class_59features_RESCALED.csv")
target_mapping = {"HC": "Healthy", "FES": "Schizophrenia", "CSZ": "Schizophrenia"}
df['binary_class'] = df['label'].map(target_mapping)
le = LabelEncoder()
y = le.fit_transform(df['binary_class'])
X = df.drop(columns=['subject_id', 'label', 'binary_class'], errors='ignore')
feat_cols = X.columns.tolist()

best_params = {'colsample_bytree': 0.8, 'learning_rate': 0.05, 'max_depth': 4,
                'n_estimators': 300, 'scale_pos_weight': 0.5, 'subsample': 0.8}

skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
oof_probs = np.zeros(len(y))
for tr_idx, va_idx in skf.split(X, y):
    m = xgb.XGBClassifier(**best_params, eval_metric='logloss', random_state=42)
    m.fit(X.iloc[tr_idx], y[tr_idx])
    oof_probs[va_idx] = m.predict_proba(X.iloc[va_idx])[:, 1]
oof_preds = (oof_probs >= 0.5).astype(int)

print("=== RESCALED-DATA OOF PERFORMANCE ===")
print("ROC-AUC:", round(roc_auc_score(y, oof_probs), 4))
print("Accuracy:", round(accuracy_score(y, oof_preds), 4))
print("F1:", round(f1_score(y, oof_preds), 4))
print("LogLoss:", round(log_loss(y, oof_probs), 4))
print(confusion_matrix(y, oof_preds))
print(classification_report(y, oof_preds, target_names=le.classes_))

# Final model + probability calibration (isotonic, 5-fold) so confidence values are trustworthy
base = xgb.XGBClassifier(**best_params, eval_metric='logloss', random_state=42)
calibrated = CalibratedClassifierCV(base, method='isotonic', cv=skf)
calibrated.fit(X, y)

plain = xgb.XGBClassifier(**best_params, eval_metric='logloss', random_state=42)
plain.fit(X, y)

joblib.dump(calibrated, "model_calibrated.pkl")
joblib.dump(plain, "model.pkl")
joblib.dump(le, "label_encoder.pkl")
joblib.dump(feat_cols, "feature_names.pkl")

input_json = {
"fv_fnum_mean":12.52,"fv_fdur_mean":418.45,"fv_snum_mean":12.28,"fv_sdur_mean":100,
"fv_samp_mean":8.87,"fv_spv_mean":74.34,"fv_sav_mean":39.42,"fv_spl_mean":1500,"fv_disp_mean":0.75,
"HS4_Mean_H_logSNR":1.713,"HS4_Mean_H_RMSE":6.45,"HS4_Mean_H_gain":1.145,"HS4_FixNum":51,
"HS4_FixDur":273.59,"HS4_SacNum":51,"HS4_SacDur":85.75,"HS4_SacAmp":3.78,"HS4_SacPV":77.23,"HS4_SacAV":49.79,
"LS2_Mean_H_logSNR":1.511,"LS2_Mean_H_RMSE":2.56,"LS2_Mean_H_gain":1.067,"LS2_Mean_V_logSNR":1.332,
"LS2_Mean_V_RMSE":7.64,"LS2_Mean_V_gain":0.42,"LS2_FixNum":23,"LS2_FixDur":752.48,"LS2_SacNum":23,
"LS2_SacDur":60,"LS2_SacAmp":1.92,"LS2_SacPV":43.97,"LS2_SacAV":28.72,
"LS4_Mean_H_logSNR":1.877,"LS4_Mean_H_RMSE":5.96,"LS4_Mean_H_gain":1.07,"LS4_Mean_V_logSNR":1.587,
"LS4_Mean_V_RMSE":12,"LS4_Mean_V_gain":0.2,"LS4_FixNum":43,"LS4_FixDur":111.81,"LS4_SacNum":44,
"LS4_SacDur":80,"LS4_SacAmp":10,"LS4_SacPV":89.5,"LS4_SacAV":38.77,
"fix_fs_fn":14,"fix_fs_fd":582.84,"fix_fs_sn":13,"fix_fs_sa":1.23,"fix_fs_spl":19,
"fix_fd_fn":28,"fix_fd_fd":631.49,"fix_fd_sn":27,"fix_fd_sa":0.53,"fix_fd_spl":16.18,
"antisaccade_error_rate":0,"antisaccade_correction_error_rate":0,"antisaccade_latency":378.81,"antisaccade_accuracy":1
}
# NOTE: this input already came from the real (degree-based) extractor, so it is
# already on the "rescaled" (degrees) unit system -- no /37 correction applied to it.
xin = pd.DataFrame([input_json]).reindex(columns=feat_cols)

print("\n=== Prediction on the reported input, plain model (rescaled training data) ===")
p = plain.predict_proba(xin)[0]
print(dict(zip(le.classes_, p)))

print("\n=== Prediction on the reported input, isotonic-CALIBRATED model ===")
p2 = calibrated.predict_proba(xin)[0]
print(dict(zip(le.classes_, p2)))
