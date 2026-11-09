import { FEATURE_ORDER } from '../types/featureOrder.ts';
import type { Session } from '../types/session.ts';

/** The saved 59-feature vector, in model order (original: showFeatures()). */
export function FeatureModal(props: { session: Session; onClose: () => void }) {
  const features = props.session.features || {};
  const has = Object.keys(features).length > 0;
  return (
    <div className="modal-backdrop feature" id="feature-modal" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal-card feature">
        <div className="modal-head">
          <h2>59 Oculomotor Features</h2>
          <button className="modal-x" onClick={props.onClose} aria-label="Close">✕</button>
        </div>
        {!has ? (
          <p style={{ color: 'var(--dim)', padding: '20px 0' }}>No features recorded for this session.</p>
        ) : (
          <div className="feat-grid">
            {FEATURE_ORDER.map((k) => {
              const val = features[k];
              return (
                <div className="feat-row" key={k}>
                  <span className="feat-name">{k}</span>
                  <span className="feat-val">{typeof val === 'number' ? val.toFixed(4) : String(val ?? '')}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
