'use strict';

/**
 * Manages camera input, face-landmark detection, gaze calibration, and gaze events.
 * Exposes tracking controls and performance data through the EyeTracker API.
 */


const EyeTracker = (() => {

  // ── Shared helpers ──────────────────────────────────────────
  /** Find a page element by its ID. */
  const $ = (id) => document.getElementById(id);
  /** Return the current viewport width. */
  const W = () => window.innerWidth;
  /** Return the current viewport height. */
  const H = () => window.innerHeight;
  /** Wait for the specified number of milliseconds. */
  const nap = (ms) => new Promise(r => setTimeout(r, ms));

  // ── Configuration ────────────────────────────────────────────
  const CFG = {
    SOLUTION_PATH   : 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/',

    GRID_COLS       : 5,
    GRID_ROWS       : 4,
    DOT_TRAVEL_MS   : 420,
    SETTLE_MS       : 320,
    CAPTURE_MS      : 750,
    CAPTURE_TARGET  : 10,
    SAMPLE_POLL_MS  : 30,
    MIN_PER_POINT   : 4,
    MIN_TOTAL       : 60,
    QUALITY_MIN     : 0.18,
    RIDGE_LAMBDA    : 1e-3,

    VALIDATION_PTS  : 5,
    GOOD_RMS_PX     : 90,
    POOR_RMS_PX     : 190,

    SACCADE_THRESH_PX_S : 180,
    FIXATION_RADIUS_PX  : 38,
    FIXATION_MIN_MS     : 100,
    FPS_WINDOW          : 30,
    VELOCITY_SCALE_FACTOR : 0.8,

    HUD_UPDATE_MS   : 200,
    CURSOR_UPDATE_MS: 16,
    STALL_MS        : 2000,
    FACE_WAIT_MS    : 20000,
  };

  // Try common camera modes in descending preference, then use browser defaults.
  const CAMERA_CONSTRAINT_SETS = [
    { name: '640x480@60',  video: { width:{ideal:640},  height:{ideal:480}, frameRate:{ideal:60} } },
    { name: '1280x720@30', video: { width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30} } },
    { name: '640x480@30',  video: { width:{ideal:640},  height:{ideal:480}, frameRate:{ideal:30} } },
    { name: 'default',     video: {} },
  ];

  // Avoid matching "ir" inside unrelated camera labels such as "Wireless".
  const IR_LABEL_RE = /(^|[^a-z])(ir|infra[- ]?red|depth|tof|3d)([^a-z]|$)/i;
  const CAMERA_PREF_KEY = 'neurocular.cameraId';

  /** Log tracker diagnostics through the test hook when available. */
  function tdiag(msg, extra) {
    if (typeof window.TestDiag === 'function') { window.TestDiag(msg, extra); return; }
    if (extra !== undefined) console.log('[EyeTracker] ' + msg, extra);
    else console.log('[EyeTracker] ' + msg);
  }

  // ── Landmark indices ─────────────────────────────────────────
  const IRIS_IDX     = { L_CENTER:468, L_RING:[469,470,471,472], R_CENTER:473, R_RING:[474,475,476,477] };
  const EYE_CORNERS  = { L_inner:133, L_outer:33, R_inner:362, R_outer:263 };
  const FACE_EDGE    = { LEFT:234, RIGHT:454, TOP:10, CHIN:152, NOSE:1 };

  // ── Module state ─────────────────────────────────────────────
  let detector = null, videoEl = null, videoStream = null, videoTrack = null;
  let _started = false, _startPromise = null;

  let _mode = 'idle';               // idle | preview | calibrating | tracking
  let _running = false;
  let _rafHandle = null;
  let _watchdog = null;
  let _detectorBusy = false;

  // Tracks newly presented video frames independently of display refresh.
  let _rvfcFrameCount = 0, _lastProcessedFrameCount = -1, _rvfcActive = false;

  let _lastKp = null, _lastKpTs = 0, _lastQuality = 0, _lastGeom = null;
  let _lastFrameTs = 0, _lastEmitTs = 0;

  let _calibrated = false, isCalibrating = false, _calAborted = false;
  let modelX = null, modelY = null, _calError = 0, _validationError = null;

  let _paused = false;
  let _listeners = [];
  let _gazeSeq = 0;
  let _previewCb = null;

  let _cameraFps = 0, _actualFps = 0, _cameraResolution = '', _requestedFps = 60;
  let _totalFrames = 0, _processedFrames = 0, _droppedFrames = 0, _emittedSamples = 0;
  let _detectorMs = 0, _processMs = 0, _listenerMs = 0;
  const LATENCY_ALPHA = 0.1;

  const _latestGaze = { x:0, y:0, velocity:0, isBlink:false, confidence:1, fps:0, ts:0, seq:0 };

  let prevGaze = null, prevTime = null, saccadeVel = 0;
  let fixCluster = null, fixStart = 0, fixating = false;

  const fpsBuf = [];
  let _fps = 0;
  let _hudLastUpdate = 0, _cursorLastUpdate = 0;
  let _renderX = 0, _renderY = 0;
  const _featureBuf = new Float64Array(12);

  // ── Kalman filter ───────────────────────────────────────────
  const KF = {
    px:0, vx:0, py:0, vy:0,
    pPP:500, pPV:0, pVP:0, pVV:500,
    qPP:500, qPV:0, qVP:0, qVV:500,
    Q_p:1.0, Q_v:3.0, R:110, inited:false,
  };
  let lastKfTime = null;

  /** Predict the next gaze position and update the filter covariance. */
  function kfPredict(dt) {
    KF.px += KF.vx * dt;
    const p00=KF.pPP+dt*(KF.pPV+KF.pVP)+dt*dt*KF.pVV+KF.Q_p;
    const p01=KF.pPV+dt*KF.pVV, p10=KF.pVP+dt*KF.pVV, p11=KF.pVV+KF.Q_v;
    KF.pPP=p00; KF.pPV=p01; KF.pVP=p10; KF.pVV=p11;
    KF.py += KF.vy * dt;
    const q00=KF.qPP+dt*(KF.qPV+KF.qVP)+dt*dt*KF.qVV+KF.Q_p;
    const q01=KF.qPV+dt*KF.qVV, q10=KF.qVP+dt*KF.qVV, q11=KF.qVV+KF.Q_v;
    KF.qPP=q00; KF.qPV=q01; KF.qVP=q10; KF.qVV=q11;
  }
  /** Correct the predicted gaze position using the latest measurement. */
  function kfUpdate(mx, my) {
    const pPP0=KF.pPP, pPV0=KF.pPV;
    const Sx=pPP0+KF.R, KgP=pPP0/Sx, KgV=KF.pVP/Sx, ex=mx-KF.px;
    KF.px+=KgP*ex; KF.vx+=KgV*ex;
    KF.pPP=pPP0*(1-KgP); KF.pPV=pPV0*(1-KgP);
    KF.pVP-=KgV*pPP0;    KF.pVV-=KgV*pPV0;
    const qPP0=KF.qPP, qPV0=KF.qPV;
    const Sy=qPP0+KF.R, LgP=qPP0/Sy, LgV=KF.qVP/Sy, ey=my-KF.py;
    KF.py+=LgP*ey; KF.vy+=LgV*ey;
    KF.qPP=qPP0*(1-LgP); KF.qPV=qPV0*(1-LgP);
    KF.qVP-=LgV*qPP0;    KF.qVV-=LgV*qPV0;
  }
  /** Smooth a raw gaze estimate with the Kalman filter. */
  function applyKalman(rawX, rawY, tsMs) {
    if (!KF.inited) { KF.px=rawX; KF.py=rawY; KF.vx=0; KF.vy=0; KF.inited=true; lastKfTime=tsMs; return; }
    const dt = Math.max(0.001, Math.min((tsMs - lastKfTime)/1000, 0.1));
    lastKfTime = tsMs;
    kfPredict(dt);
    kfUpdate(rawX, rawY);
  }

  // ── Feature extraction ───────────────────────────────────────
  /** Estimate normalized iris radius from its centre and boundary landmarks. */
  function _irisRadius(kp, center, ringIdx, vScale) {
    let s = 0;
    for (let i=0;i<ringIdx.length;i++) {
      const p = kp[ringIdx[i]];
      const dx = p.x-center.x, dy = p.y-center.y;
      s += Math.sqrt(dx*dx+dy*dy);
    }
    return (s/ringIdx.length)/vScale;
  }

  /** Fill the output buffer with normalized iris and eye-position features. */
  function extractFeatures(kp, outBuf) {
    const vW = (videoEl && videoEl.videoWidth)  || 640;
    const vH = (videoEl && videoEl.videoHeight) || 480;
    const vScale = Math.sqrt(vW * vH);

    const lc = kp[IRIS_IDX.L_CENTER], rc = kp[IRIS_IDX.R_CENTER];
    const lAx=(kp[EYE_CORNERS.L_inner].x+kp[EYE_CORNERS.L_outer].x)*0.5;
    const lAy=(kp[EYE_CORNERS.L_inner].y+kp[EYE_CORNERS.L_outer].y)*0.5;
    const rAx=(kp[EYE_CORNERS.R_inner].x+kp[EYE_CORNERS.R_outer].x)*0.5;
    const rAy=(kp[EYE_CORNERS.R_inner].y+kp[EYE_CORNERS.R_outer].y)*0.5;
    const lEW=Math.abs(kp[EYE_CORNERS.L_outer].x-kp[EYE_CORNERS.L_inner].x)||vW*0.08;
    const rEW=Math.abs(kp[EYE_CORNERS.R_outer].x-kp[EYE_CORNERS.R_inner].x)||vW*0.08;

    outBuf[0]  = lc.x/vW;
    outBuf[1]  = lc.y/vH;
    outBuf[2]  = (lc.z||0)/vW;
    outBuf[3]  = _irisRadius(kp, lc, IRIS_IDX.L_RING, vScale);
    outBuf[4]  = (lc.x-lAx)/lEW;
    outBuf[5]  = (lc.y-lAy)/lEW;
    outBuf[6]  = rc.x/vW;
    outBuf[7]  = rc.y/vH;
    outBuf[8]  = (rc.z||0)/vW;
    outBuf[9]  = _irisRadius(kp, rc, IRIS_IDX.R_RING, vScale);
    outBuf[10] = (rc.x-rAx)/rEW;
    outBuf[11] = (rc.y-rAy)/rEW;
    return outBuf;
  }

  /** Measure face position, size, pose, and overall frame quality. */
  function faceGeometry(kp) {
    const vW = (videoEl && videoEl.videoWidth)  || 640;
    const vH = (videoEl && videoEl.videoHeight) || 480;
    const L = kp[FACE_EDGE.LEFT], R = kp[FACE_EDGE.RIGHT];
    const T = kp[FACE_EDGE.TOP],  B = kp[FACE_EDGE.CHIN], N = kp[FACE_EDGE.NOSE];
    if (!L || !R || !T || !B || !N) return null;

    const faceW = Math.abs(R.x - L.x) || 1;
    const faceH = Math.abs(B.y - T.y) || 1;
    const cx = (L.x + R.x) / 2;
    const cy = (T.y + B.y) / 2;
    const yaw   = (N.x - cx) / faceW;          // 0 = frontal
    const pitch = (N.y - (L.y + R.y) / 2) / faceH;

    const sizeRatio = faceW / vW;              // ideal ~0.35-0.45
    const sizeScore = sizeRatio < 0.12 ? 0 : Math.max(0, 1 - Math.abs(sizeRatio - 0.40) / 0.40);
    const poseScore = Math.max(0, 1 - (Math.abs(yaw) * 2.2 + Math.abs(pitch) * 1.6));

    return {
      // normalised to the video frame, origin top-left, NOT mirrored
      cx: cx / vW, cy: cy / vH,
      w: faceW / vW, h: faceH / vH,
      sizeRatio, yaw, pitch, sizeScore, poseScore,
      quality: Math.max(0, Math.min(1, 0.45 * sizeScore + 0.55 * poseScore)),
    };
  }

  // ── Weighted ridge regression ────────────────────────────────
  /** Fit weighted ridge-regression coefficients for one screen coordinate. */
  function fitRidge(samples, targetKey, lambda) {
    const n=samples.length, d=samples[0].features.length+1;
    const XtWX=Array.from({length:d},()=>new Float64Array(d));
    const XtWy=new Float64Array(d);
    for (const s of samples) {
      const row=[...s.features,1.0], wi=s.weight, yi=s[targetKey];
      for (let a=0;a<d;a++) { XtWy[a]+=wi*row[a]*yi; for (let b=0;b<d;b++) XtWX[a][b]+=wi*row[a]*row[b]; }
    }
    for (let a=0;a<d-1;a++) XtWX[a][a]+=lambda;
    return gaussElim(XtWX, XtWy, d);
  }

  /** Solve a linear system using Gaussian elimination with pivoting. */
  function gaussElim(A, b, n) {
    const M=A.map((row,i)=>[...Array.from(row),b[i]]);
    for (let col=0;col<n;col++) {
      let maxRow=col;
      for (let r=col+1;r<n;r++) if (Math.abs(M[r][col])>Math.abs(M[maxRow][col])) maxRow=r;
      [M[col],M[maxRow]]=[M[maxRow],M[col]];
      const piv=M[col][col]; if (Math.abs(piv)<1e-14) continue;
      for (let r=0;r<n;r++) { if (r===col) continue; const f=M[r][col]/piv; for (let c=col;c<=n;c++) M[r][c]-=f*M[col][c]; }
    }
    return M.map((row,i)=>row[n]/(row[i]||1e-14));
  }

  /** Predict a screen coordinate from fitted coefficients and gaze features. */
  function ridgePredict(coef, features) {
    let v=0;
    for (let i=0;i<12;i++) v+=coef[i]*features[i];
    return v+coef[12];
  }

  /** Calculate the weighted root-mean-square calibration error. */
  function fitRms(samples) {
    let sse=0, wSum=0;
    for (const s of samples) {
      const px=ridgePredict(modelX,s.features), py=ridgePredict(modelY,s.features);
      sse+=s.weight*((px-s.sx)**2+(py-s.sy)**2); wSum+=s.weight;
    }
    return wSum > 0 ? Math.sqrt(sse/wSum) : NaN;
  }

  // ── Motion metrics ───────────────────────────────────────────
  /** Update gaze velocity and determine whether the gaze is fixating. */
  function updateMotion(gx, gy, ts) {
    if (prevGaze && prevTime) {
      const dt=(ts-prevTime)/1000;
      if (dt>0) saccadeVel=Math.hypot(gx-prevGaze.x, gy-prevGaze.y)/dt;
    }
    prevGaze={x:gx,y:gy}; prevTime=ts;
    if (!fixCluster) { fixCluster={x:gx,y:gy}; fixStart=ts; }
    else {
      const dist=Math.hypot(gx-fixCluster.x, gy-fixCluster.y);
      if (dist<CFG.FIXATION_RADIUS_PX) {
        fixCluster.x=(fixCluster.x+gx)/2; fixCluster.y=(fixCluster.y+gy)/2;
        fixating=(ts-fixStart)>=CFG.FIXATION_MIN_MS;
      } else { fixCluster={x:gx,y:gy}; fixStart=ts; fixating=false; }
    }
  }

  // ── Gaze processing ──────────────────────────────────────────
  /** Convert detected landmarks into a filtered gaze sample and notify listeners. */
  function processGazeSample(kp, detectorDoneTs) {
    extractFeatures(kp, _featureBuf);
    const rawX = Math.max(0, Math.min(W(), ridgePredict(modelX, _featureBuf)));
    const rawY = Math.max(0, Math.min(H(), ridgePredict(modelY, _featureBuf)));
    const ts   = performance.now();
    applyKalman(rawX, rawY, ts);
    const gx = KF.px, gy = KF.py;

    updateMotion(gx, gy, ts);

    const fpsRatio = Math.min(1.0, (_fps || 30) / 120.0);
    const adaptiveAlpha = CFG.VELOCITY_SCALE_FACTOR * fpsRatio;
    _renderX += (gx - _renderX) * adaptiveAlpha;
    _renderY += (gy - _renderY) * adaptiveAlpha;

    const cursor = $('gaze-cursor'), ring = $('gaze-ring');
    if (cursor && cursor.style.display !== 'none' && ts - _cursorLastUpdate >= CFG.CURSOR_UPDATE_MS) {
      _cursorLastUpdate = ts;
      cursor.style.left = Math.max(0, Math.min(W()-1, _renderX)) + 'px';
      cursor.style.top  = Math.max(0, Math.min(H()-1, _renderY)) + 'px';
      if (ring) {
        const rs = 28 + Math.min(saccadeVel*0.1, 36);
        ring.style.width  = rs + 'px';
        ring.style.height = rs + 'px';
      }
    }

    _gazeSeq++;
    _latestGaze.x          = gx;
    _latestGaze.y          = gy;
    _latestGaze.velocity   = saccadeVel;
    _latestGaze.isBlink    = false;
    _latestGaze.confidence = _lastQuality || 1;
    _latestGaze.fps        = _fps;
    _latestGaze.ts         = ts;
    _latestGaze.seq        = _gazeSeq;

    _processedFrames++;
    _emittedSamples++;
    _lastEmitTs = ts;

    const processEnd = performance.now();
    _processMs = _processMs * (1 - LATENCY_ALPHA) + (processEnd - detectorDoneTs) * LATENCY_ALPHA;

    fpsBuf.push(ts);
    if (fpsBuf.length > CFG.FPS_WINDOW) fpsBuf.shift();
    if (fpsBuf.length >= 2) {
      _fps = Math.round((fpsBuf.length - 1) / ((fpsBuf[fpsBuf.length-1] - fpsBuf[0]) / 1000));
    }

    if (ts - _hudLastUpdate >= CFG.HUD_UPDATE_MS) {
      _hudLastUpdate = ts;
      /** Update a HUD element when it is present. */
      const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
      set('hx', _renderX.toFixed(0));
      set('hy', _renderY.toFixed(0));
      set('hv', saccadeVel.toFixed(1));
      set('hfps', _fps);
      set('htrkfps', Math.round(_actualFps || _fps));
      set('hconf', Math.round((_lastQuality || 1) * 100) + '%');
      set('hstab', fixating ? 'LOCKED' : 'SEARCH');
      set('hb', 'OK');
    }

    // Listeners must handle their own errors; one throwing listener must not
    // take the whole sampling pipeline down for the other two tasks.
    const listenerStart = performance.now();
    const L = _listeners;
    for (let i = 0; i < L.length; i++) {
      try { L[i](_latestGaze); }
      catch (e) { console.warn('[EyeTracker] gaze listener threw', e); }
    }
    _listenerMs = _listenerMs * (1 - LATENCY_ALPHA) + (performance.now() - listenerStart) * LATENCY_ALPHA;
  }

  // ── Frame freshness ──────────────────────────────────────────
  /** Track newly presented video frames to gate redundant detector calls. */
  function startFrameFreshnessTracking() {
    if (_rvfcActive || !videoEl || typeof videoEl.requestVideoFrameCallback !== 'function') {
      if (!videoEl || typeof videoEl.requestVideoFrameCallback !== 'function') {
        tdiag('requestVideoFrameCallback unavailable — frame-freshness gate disabled, falling back to ungated rAF detection');
      }
      return;
    }
    _rvfcActive = true;
    /** Count each newly presented frame and queue the next callback. */
    const onFrame = () => {
      _rvfcFrameCount++;
      if (_rvfcActive && videoEl) videoEl.requestVideoFrameCallback(onFrame);
    };
    videoEl.requestVideoFrameCallback(onFrame);
  }

  /** Stop counting presented video frames. */
  function stopFrameFreshnessTracking() {
    _rvfcActive = false;
  }

  // ── Detection loop ───────────────────────────────────────────
  /** Process a new camera frame and schedule the next animation-frame tick. */
  function frameTick() {
    if (!_running) return;
    _rafHandle = requestAnimationFrame(frameTick);

    if (!detector || !videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return;
    if (_detectorBusy) { _droppedFrames++; return; }

    // Skip this tick until the camera presents a frame not yet processed.
    if (_rvfcActive && _rvfcFrameCount === _lastProcessedFrameCount) return;
    _lastProcessedFrameCount = _rvfcFrameCount;

    _detectorBusy = true;
    const t0 = performance.now();

    detector.estimateFaces(videoEl, { flipHorizontal:false })
      .then(faces => {
        _detectorBusy = false;
        const doneTs = performance.now();
        _lastFrameTs = doneTs;
        _totalFrames++;
        _detectorMs = _detectorMs * (1 - LATENCY_ALPHA) + (doneTs - t0) * LATENCY_ALPHA;

        if (faces && faces.length > 0 && faces[0].keypoints && faces[0].keypoints.length >= 478) {
          _lastKp      = faces[0].keypoints;
          _lastKpTs    = doneTs;
          _lastGeom    = faceGeometry(_lastKp);
          _lastQuality = _lastGeom ? _lastGeom.quality : 0;
          if (_mode === 'tracking' && _calibrated && !_paused) processGazeSample(_lastKp, doneTs);
        } else {
          _lastKp = null; _lastGeom = null; _lastQuality = 0;
        }

        if (_previewCb) { try { _previewCb(previewStats()); } catch (_) {} }
      })
      .catch(err => {
        _detectorBusy = false;
        _lastFrameTs = performance.now();
        if (_totalFrames <= 3 || _totalFrames % 150 === 0) {
          tdiag('estimateFaces rejected', { name: err && err.name, message: err && err.message });
        }
      });
  }

  /** Start detection, frame freshness tracking, and the stall watchdog. */
  function startLoop() {
    if (_running) return;
    _running = true;
    _lastFrameTs = performance.now();
    startFrameFreshnessTracking();
    _rafHandle = requestAnimationFrame(frameTick);
    if (!_watchdog) _watchdog = setInterval(watchdogTick, 1000);
    tdiag('frame loop started', { mode: _mode });
  }

  /** Stop detection, frame tracking, and the stall watchdog. */
  function stopLoop() {
    _running = false;
    stopFrameFreshnessTracking();
    if (_rafHandle != null) { try { cancelAnimationFrame(_rafHandle); } catch (_) {} _rafHandle = null; }
    if (_watchdog) { clearInterval(_watchdog); _watchdog = null; }
    _detectorBusy = false;
  }

  /** Recover the detection loop when frame processing stalls. */
  function watchdogTick() {
    if (!_running || document.hidden) return;
    const since = performance.now() - _lastFrameTs;
    if (since < CFG.STALL_MS) return;
    tdiag('frame loop stalled — recovering', { sinceMs: Math.round(since), mode: _mode });
    _detectorBusy = false;
    if (videoEl && videoEl.paused) { videoEl.play().catch(() => {}); }
    if (_rafHandle != null) { try { cancelAnimationFrame(_rafHandle); } catch (_) {} }
    _lastFrameTs = performance.now();
    _rafHandle = requestAnimationFrame(frameTick);
  }

  // ── Camera ───────────────────────────────────────────────────
  /** Return available video input devices with labels and infrared hints. */
  async function enumerateCameras() {
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (_) { return []; }
    return devices
      .filter(d => d.kind === 'videoinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || ('Camera ' + (i + 1)),
        isIR: IR_LABEL_RE.test(d.label || ''),
      }));
  }

  /** Prefer the saved camera, then a non-infrared camera, if available. */
  async function pickDefaultCamera() {
    const saved = (() => { try { return localStorage.getItem(CAMERA_PREF_KEY); } catch (_) { return null; } })();
    const cams = await enumerateCameras();
    if (saved && cams.some(c => c.deviceId === saved)) return saved;
    const rgb = cams.find(c => !c.isIR);
    return rgb ? rgb.deviceId : (cams[0] ? cams[0].deviceId : null);
  }

  /** Open a camera stream using progressively broader video constraints. */
  async function openStream(deviceId) {
    let lastErr = null;
    for (const cs of CAMERA_CONSTRAINT_SETS) {
      const video = Object.assign({ facingMode: 'user' }, cs.video);
      if (deviceId) { video.deviceId = { exact: deviceId }; delete video.facingMode; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        _requestedFps = (cs.video.frameRate && cs.video.frameRate.ideal) || 30;
        tdiag('camera opened', { constraintSet: cs.name, deviceId: deviceId || '(default)' });
        return stream;
      } catch (err) {
        lastErr = err;
        tdiag('camera constraint failed', { set: cs.name, name: err.name });
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
      }
    }
    throw lastErr || new Error('No camera could be opened.');
  }

  /** Store the active stream and update camera metadata. */
  function adoptStream(stream) {
    videoStream = stream;
    const tracks = stream.getVideoTracks();
    if (tracks.length) {
      videoTrack = tracks[0];
      const s = videoTrack.getSettings ? videoTrack.getSettings() : {};
      _actualFps = s.frameRate || 0;
      _cameraFps = _actualFps;
      _cameraResolution = (s.width || '?') + '\u00d7' + (s.height || '?');
      try { localStorage.setItem(CAMERA_PREF_KEY, s.deviceId || ''); } catch (_) {}
      tdiag('camera settings', { fps: _actualFps, resolution: _cameraResolution, label: videoTrack.label });
    }
  }

  /** Replace the active camera stream with the selected device. */
  async function switchCamera(deviceId) {
    if (!videoEl) return false;
    const old = videoStream;
    const stream = await openStream(deviceId);
    videoEl.srcObject = stream;
    await videoEl.play().catch(() => {});
    if (old) old.getTracks().forEach(t => t.stop());
    adoptStream(stream);
    KF.inited = false;
    return true;
  }

  /** Keep the video element available for decoding without showing a preview. */
  function parkVideo() {
    if (!videoEl) return;
    videoEl.style.cssText =
      'position:fixed;left:2px;bottom:2px;width:3px;height:3px;opacity:0.02;' +
      'pointer-events:none;z-index:0;object-fit:cover;';
    document.body.appendChild(videoEl);
    videoEl.play().catch(() => {});
  }

  // ── Startup ──────────────────────────────────────────────────
  /** Initialize the camera, TensorFlow backend, and face-landmark detector. */
  async function ensureStarted() {
    if (_startPromise) return _startPromise;
    _startPromise = (async () => {
      tdiag('EyeTracker startup begin');

      const handoff = window._handoffMediaStream;
      let stream = null;
      if (handoff && handoff.getVideoTracks && handoff.getVideoTracks().some(t => t.readyState === 'live')) {
        tdiag('reusing handed-off preview stream');
        stream = handoff;
        window._handoffMediaStream = null;
      } else {
        const deviceId = await pickDefaultCamera();
        stream = await openStream(deviceId);
      }
      adoptStream(stream);

      videoEl = document.createElement('video');
      videoEl.setAttribute('autoplay', '');
      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute('muted', '');
      videoEl.muted = true;
      videoEl.srcObject = stream;
      parkVideo();

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Camera did not produce a frame within 12 seconds.')), 12000);
        const ok = () => { clearTimeout(timer); resolve(); };
        if (videoEl.readyState >= 2) return ok();
        videoEl.addEventListener('loadeddata', ok, { once:true });
        videoEl.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Video element failed to load the camera stream.')); }, { once:true });
      });
      await videoEl.play().catch(() => {});
      tdiag('video ready', { width: videoEl.videoWidth, height: videoEl.videoHeight });

      await tf.setBackend('webgl');
      await tf.ready();
      tdiag('TensorFlow WebGL backend ready');

      detector = await faceLandmarksDetection.createDetector(
        faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
        { runtime:'mediapipe', refineLandmarks:true, solutionPath:CFG.SOLUTION_PATH, maxFaces:1 }
      );
      await detector.estimateFaces(videoEl, { flipHorizontal:false });   // warm-up
      tdiag('FaceMesh detector ready');

      _renderX = W()/2; _renderY = H()/2;
      _started = true;
      startLoop();
    })();

    try {
      await _startPromise;
    } catch (err) {
      tdiag('EyeTracker startup failed', { name: err.name, message: err.message });
      teardown();
      _startPromise = null;
      throw err;
    }
    return _startPromise;
  }

  /** Release detector, video, camera tracks, and loop resources. */
  function teardown() {
    stopLoop();
    if (detector && typeof detector.dispose === 'function') { try { detector.dispose(); } catch (_) {} }
    detector = null;
    if (videoEl) { try { videoEl.pause(); } catch (_) {} videoEl.srcObject = null; videoEl.remove(); videoEl = null; }
    if (videoStream) { try { videoStream.getTracks().forEach(t => t.stop()); } catch (_) {} }
    videoStream = null; videoTrack = null;
    _started = false;
    _mode = 'idle';
  }

  // ── Camera preview ───────────────────────────────────────────
  /** Return current face-detection and camera preview statistics. */
  function previewStats() {
    const fresh = _lastKp && (performance.now() - _lastKpTs) < 400;
    return {
      faceFound : !!fresh,
      quality   : fresh ? _lastQuality : 0,
      geometry  : fresh ? _lastGeom : null,
      detectorMs: _detectorMs,
      cameraLabel: videoTrack ? videoTrack.label : '',
      resolution : _cameraResolution,
      fps        : _actualFps,
    };
  }

  /** Show the active camera inside a container and optionally report stats. */
  async function startPreview(container, onStats) {
    await ensureStarted();
    _previewCb = typeof onStats === 'function' ? onStats : null;
    if (container && videoEl) {
      videoEl.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
        'transform:scaleX(-1);z-index:1;';
      container.appendChild(videoEl);
      await videoEl.play().catch(() => {});
    }
    _mode = 'preview';
    startLoop();
    return previewStats();
  }

  /** Hide the camera preview while keeping its stream active. */
  function stopPreview() {
    _previewCb = null;
    if (_mode === 'preview') _mode = 'idle';
    parkVideo();
  }

  // ── Calibration ──────────────────────────────────────────────
  const CAL_BG = '#0b0d12';
  const CAL_Z  = 2147483000;   // above #cal-screen (2600), #cal-dot (1002), Plotly, modals

  // Calibration elements are created here to keep their layout independent of page styles.
  let calRoot = null, calTarget = null, calRing = null;

  /** Create or display the calibration interface and its target elements. */
  function calUI() {
    const legacyScreen = $('cal-screen');
    if (legacyScreen) legacyScreen.style.display = 'none';
    const legacyDot = $('cal-dot');
    if (legacyDot) { legacyDot.style.display = 'none'; legacyDot.classList.add('hidden'); }

    if (calRoot && document.body.contains(calRoot)) { calRoot.style.display = 'block'; return calRoot; }

    calRoot = document.createElement('div');
    calRoot.id = 'nt-cal-root';
    calRoot.style.cssText =
      'position:fixed;inset:0;z-index:' + CAL_Z + ';background:' + CAL_BG + ';' +
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;cursor:none;' +
      'user-select:none;-webkit-user-select:none;';
    calRoot.innerHTML =
      // fixation target: white disc, dark core, attention ring
      '<div id="nt-cal-target" style="position:absolute;left:0;top:0;width:28px;height:28px;' +
        'margin:-14px 0 0 -14px;border-radius:50%;background:#ffffff;opacity:0;' +
        'box-shadow:0 0 0 3px rgba(255,255,255,.10),0 0 26px rgba(255,255,255,.30);' +
        'transition:transform ' + CFG.DOT_TRAVEL_MS + 'ms cubic-bezier(.22,.61,.36,1),opacity .2s;">' +
        '<span style="position:absolute;left:50%;top:50%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;' +
          'border-radius:50%;background:' + CAL_BG + ';"></span>' +
        '<span id="nt-cal-ring" style="position:absolute;left:50%;top:50%;width:28px;height:28px;' +
          'margin:-14px 0 0 -14px;border-radius:50%;border:2px solid rgba(255,255,255,.55);' +
          'opacity:0;transition:transform .6s linear,opacity .6s linear;"></span>' +
      '</div>' +
      // centred message used for the pre-flight and the countdown
      '<div id="nt-cal-center" style="position:absolute;inset:0;display:flex;align-items:center;' +
        'justify-content:center;text-align:center;color:#e8edf5;font-size:20px;line-height:1.6;' +
        'padding:0 8vw;"></div>' +
      // bottom panel: hint, progress, counter
      '<div style="position:absolute;left:50%;bottom:48px;transform:translateX(-50%);' +
        'width:min(560px,84vw);text-align:center;">' +
        '<div id="nt-cal-hint" style="font-size:15px;color:#c9d2e0;margin-bottom:14px;min-height:22px;"></div>' +
        '<div style="height:3px;background:#1d2430;border-radius:2px;overflow:hidden;">' +
          '<div id="nt-cal-bar" style="height:100%;width:0%;background:#4fd8c4;transition:width .25s ease;"></div>' +
        '</div>' +
        '<div id="nt-cal-count" style="font-size:12px;color:#6e7a8c;margin-top:8px;"></div>' +
      '</div>' +
      '<div style="position:absolute;right:18px;top:16px;font-size:11px;color:#3f4857;">Esc to cancel</div>';

    document.body.appendChild(calRoot);
    calTarget = calRoot.querySelector('#nt-cal-target');
    calRing   = calRoot.querySelector('#nt-cal-ring');
    return calRoot;
  }

  /** Update the calibration hint shown below the target. */
  function calHint(text)   { const el = calRoot && calRoot.querySelector('#nt-cal-hint');  if (el) el.textContent = text; }
  /** Update the calibration point counter. */
  function calCount(text)  { const el = calRoot && calRoot.querySelector('#nt-cal-count'); if (el) el.textContent = text; }
  /** Set calibration progress as a fraction from zero to one. */
  function calBar(frac)    { const el = calRoot && calRoot.querySelector('#nt-cal-bar');   if (el) el.style.width = Math.round(frac*100) + '%'; }
  /** Set the centered calibration message. */
  function calCenter(html) { const el = calRoot && calRoot.querySelector('#nt-cal-center'); if (el) el.innerHTML = html || ''; }
  /** Hide the calibration interface. */
  function hideCalUI()     { if (calRoot) calRoot.style.display = 'none'; }

  /** Move the calibration target to a screen coordinate. */
  function moveDot(x, y) {
    if (!calTarget) return;
    calTarget.style.opacity = '1';
    calTarget.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }
  /** Hide the calibration target. */
  function hideDot() { if (calTarget) calTarget.style.opacity = '0'; }

  /** Animate the target ring while samples are being captured. */
  function calPulse(on) {
    if (!calRing) return;
    if (on) {
      calRing.style.transition = 'none';
      calRing.style.transform = 'scale(3.2)';
      calRing.style.opacity = '0.9';
      void calRing.offsetWidth;
      calRing.style.transition = 'transform ' + CFG.CAPTURE_MS + 'ms linear, opacity ' + CFG.CAPTURE_MS + 'ms linear';
      calRing.style.transform = 'scale(1)';
      calRing.style.opacity = '0.15';
    } else {
      calRing.style.opacity = '0';
    }
  }

  /** Show the brief countdown before calibration begins. */
  async function calCountdown() {
    for (const n of ['3', '2', '1']) {
      calCenter('<div style="font-size:64px;font-weight:300;color:#e8edf5;">' + n + '</div>');
      await nap(700);
      if (_calAborted) return;
    }
    calCenter('');
  }

  /** Generate calibration targets arranged in a serpentine grid. */
  function buildGrid(cols, rows) {
    const padX = Math.max(64, W() * 0.06);
    const padY = Math.max(64, H() * 0.09);
    const grid = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        row.push({
          sx: padX + (W() - 2*padX) * (cols === 1 ? 0.5 : c/(cols-1)),
          sy: padY + (H() - 2*padY) * (rows === 1 ? 0.5 : r/(rows-1)),
        });
      }
      grid.push(...(r % 2 ? row.reverse() : row));   // serpentine: shorter travel
    }
    return grid;
  }

  /** Return screen positions reserved for calibration validation. */
  function validationPoints() {
    const mx = W()*0.25, Mx = W()*0.75, my = H()*0.25, My = H()*0.75;
    return [
      { sx: W()/2, sy: H()/2 },
      { sx: mx, sy: my }, { sx: Mx, sy: my },
      { sx: Mx, sy: My }, { sx: mx, sy: My },
    ].slice(0, CFG.VALIDATION_PTS);
  }

  /** Wait for a recent face detection that meets the quality threshold. */
  async function waitForFace(timeoutMs) {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      if (_calAborted) return false;
      if (_lastKp && performance.now() - _lastKpTs < 500 && _lastQuality >= CFG.QUALITY_MIN) return true;
      if (!_lastKp) calHint('Looking for your face — sit centred and well lit.');
      else if (_lastGeom && _lastGeom.sizeRatio < 0.20) calHint('Move a little closer to the screen.');
      else if (_lastGeom && Math.abs(_lastGeom.yaw) > 0.18) calHint('Face the screen straight on.');
      else calHint('Hold still for a moment.');
      await nap(120);
    }
    return false;
  }

  /** Return the median of a numeric array, or NaN when it is empty. */
  function medianOf(values) {
    const s = [...values].sort((a, b) => a - b);
    if (!s.length) return NaN;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m-1] + s[m]);
  }

  /** Remove feature-space outliers from a calibration capture. */
  function rejectOutliers(raw) {
    if (raw.length < 5) return raw;
    const med = [];
    for (let d = 0; d < 12; d++) med.push(medianOf(raw.map(s => s.features[d])));
    const dist = raw.map(s => {
      let acc = 0;
      for (let d = 0; d < 12; d++) { const e = s.features[d] - med[d]; acc += e * e; }
      return Math.sqrt(acc);
    });
    const medDist = medianOf(dist);
    const mad = medianOf(dist.map(v => Math.abs(v - medDist))) || 1e-9;
    const cutoff = medDist + 3 * mad;
    const kept = raw.filter((s, i) => dist[i] <= cutoff);
    return kept.length >= Math.max(3, Math.floor(raw.length * 0.5)) ? kept : raw;
  }

  /** Capture quality-gated gaze samples while a calibration target is held. */
  async function captureAtPoint(pt, out, weightScale) {
    calPulse(true);
    const startGeom = _lastGeom;
    const end = performance.now() + CFG.CAPTURE_MS;
    const raw = [];
    let lastTs = 0, headMoved = false;

    while (performance.now() < end && raw.length < CFG.CAPTURE_TARGET) {
      if (_calAborted) break;
      const fresh = _lastKp && _lastKpTs !== lastTs && (performance.now() - _lastKpTs) < 250;
      if (fresh && _lastQuality >= CFG.QUALITY_MIN) {
        lastTs = _lastKpTs;
        // Exclude samples if the face position or scale changed during capture.
        if (startGeom && _lastGeom) {
          const dx = Math.abs(_lastGeom.cx - startGeom.cx);
          const dy = Math.abs(_lastGeom.cy - startGeom.cy);
          const ds = Math.abs(_lastGeom.sizeRatio - startGeom.sizeRatio) / Math.max(startGeom.sizeRatio, 1e-6);
          if (dx > 0.035 || dy > 0.035 || ds > 0.12) { headMoved = true; await nap(CFG.SAMPLE_POLL_MS); continue; }
        }
        const f = new Float64Array(12);
        extractFeatures(_lastKp, f);
        raw.push({ features: Array.from(f), sx: pt.sx, sy: pt.sy, weight: Math.max(0.3, _lastQuality) * (weightScale || 1) });
      }
      await nap(CFG.SAMPLE_POLL_MS);
    }

    calPulse(false);
    const kept = rejectOutliers(raw);
    for (const s of kept) out.push(s);
    if (headMoved && kept.length < CFG.MIN_PER_POINT) calHint('Keep your head still — only your eyes should move.');
    return kept.length;
  }

  /** Measure how consistently the fitted gaze follows calibration targets. */
  function fitAgreement(data) {
    const byPoint = new Map();
    for (const s of data) {
      const key = Math.round(s.sx) + ':' + Math.round(s.sy);
      if (!byPoint.has(key)) byPoint.set(key, { sx: s.sx, sy: s.sy, px: [], py: [] });
      const b = byPoint.get(key);
      b.px.push(ridgePredict(modelX, s.features));
      b.py.push(ridgePredict(modelY, s.features));
    }
    const pts = [...byPoint.values()].map(b => ({
      sx: b.sx, sy: b.sy,
      px: b.px.reduce((a, v) => a + v, 0) / b.px.length,
      py: b.py.reduce((a, v) => a + v, 0) / b.py.length,
    }));
    if (pts.length < 4) return 1;
    /** Compare predicted coordinates with their calibration targets. */
    const r2 = (actual, pred) => {
      const mean = actual.reduce((a, v) => a + v, 0) / actual.length;
      let ssRes = 0, ssTot = 0;
      for (let i = 0; i < actual.length; i++) {
        ssRes += (actual[i] - pred[i]) ** 2;
        ssTot += (actual[i] - mean) ** 2;
      }
      return ssTot > 1e-6 ? 1 - ssRes / ssTot : 0;
    };
    return Math.min(
      r2(pts.map(p => p.sx), pts.map(p => p.px)),
      r2(pts.map(p => p.sy), pts.map(p => p.py))
    );
  }

  /** Display calibration accuracy and let the participant retry or continue. */
  function showSummary(meanErrPx, samples, points) {
    let box = $('_nt_cal_summary');
    if (!box) {
      box = document.createElement('div');
      box.id = '_nt_cal_summary';
      document.body.appendChild(box);
    }
    const quality = meanErrPx <= CFG.GOOD_RMS_PX ? 'good'
                  : meanErrPx <= CFG.POOR_RMS_PX ? 'usable' : 'poor';
    const tone = quality === 'good' ? '#4fd8c4' : quality === 'usable' ? '#f2a94a' : '#ef6f6f';
    const advice = quality === 'good'
      ? 'Tracking accuracy is within the range the feature extractor expects.'
      : quality === 'usable'
        ? 'Accuracy is workable but not tight. Recalibrating usually helps if the room is dim or you moved.'
        : 'Accuracy is too loose for reliable features. Recalibrate with better lighting and a steady head.';

    box.style.cssText =
      'position:fixed;inset:0;z-index:' + (CAL_Z + 1) + ';display:flex;align-items:center;justify-content:center;' +
      'background:' + CAL_BG + ';font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8edf5;';
    box.innerHTML =
      '<div style="width:min(460px,88vw);text-align:center;">' +
        '<div style="font-size:19px;font-weight:600;margin-bottom:10px;">Calibration finished</div>' +
        '<div style="font-size:46px;font-weight:600;color:' + tone + ';line-height:1;">' + meanErrPx.toFixed(0) + ' px</div>' +
        '<div style="font-size:13px;color:#8b94a6;margin:8px 0 18px;">mean gaze error across ' + CFG.VALIDATION_PTS +
          ' check points &nbsp;·&nbsp; ' + samples + ' samples from ' + points + ' points</div>' +
        '<div style="font-size:14px;line-height:1.6;color:#b7c0d0;margin-bottom:26px;">' + advice + '</div>' +
        '<div style="display:flex;gap:12px;justify-content:center;">' +
          '<button id="_nt_cal_redo" style="padding:12px 22px;border-radius:6px;border:1px solid #2a3444;' +
            'background:transparent;color:#c9d2e0;font-size:14px;cursor:pointer;">Recalibrate</button>' +
          '<button id="_nt_cal_go" style="padding:12px 26px;border-radius:6px;border:none;' +
            'background:' + tone + ';color:#06201c;font-size:14px;font-weight:600;cursor:pointer;">Start the tasks</button>' +
        '</div>' +
      '</div>';

    $('_nt_cal_redo').onclick = () => { box.style.display = 'none'; calibrate(); };
    $('_nt_cal_go').onclick = () => {
      if (quality === 'poor' && !confirm(
            'At ' + meanErrPx.toFixed(0) + ' px the gaze estimate is off by a large fraction of the screen. ' +
            'The 59 features extracted from this session will not be meaningful.\n\nRun the tasks anyway?')) {
        return;
      }
      box.style.display = 'none';
      hideCalUI();
      setCursorVisible(false);
      if (typeof BatteryController !== 'undefined' && BatteryController.onCalibrationComplete) {
        BatteryController.onCalibrationComplete();
      }
    };
  }

  /** Capture calibration data, fit gaze models, and validate their accuracy. */
  async function calibrate() {
    if (isCalibrating) return;
    try {
      await ensureStarted();
    } catch (err) {
      alert('Camera could not be started: ' + err.message);
      return;
    }

    isCalibrating = true;
    _calAborted   = false;
    _calibrated   = false;
    _mode         = 'calibrating';
    KF.inited     = false;
    prevGaze = null; prevTime = null; saccadeVel = 0; fixCluster = null; fixating = false;
    _renderX = W()/2; _renderY = H()/2;

    stopPreview();
    setCursorVisible(false);
    const hud = $('hud');      if (hud) hud.style.display = 'none';
    const rec = $('btn-recal'); if (rec) rec.style.display = 'none';

    calUI();
    hideDot();
    calBar(0);
    calCount('');
    calCenter('');

    const escHandler = (e) => { if (e.key === 'Escape') _calAborted = true; };
    window.addEventListener('keydown', escHandler);

    try {
      calHint('Checking the camera…');
      const ok = await waitForFace(CFG.FACE_WAIT_MS);
      if (!ok) throw new Error(
        'No face was detected in 20 seconds.\n\n' +
        'Check that the correct camera is selected (an infrared / Windows Hello camera can never work), ' +
        'that the light is in front of you rather than behind, and that your whole face is in view.');

      calCenter(
        '<div style="max-width:620px;">' +
          '<div style="font-size:23px;font-weight:600;margin-bottom:18px;">Calibration</div>' +
          '<div style="font-size:16px;color:#b7c0d0;line-height:1.8;">' +
            'A white target will move around the screen and pause at each position.<br>' +
            'Look straight at the centre of it every time it stops.<br>' +
            'Move only your eyes — keep your head still and stay at the same distance.' +
          '</div>' +
        '</div>');
      await nap(3400);
      if (_calAborted) throw new Error('Calibration cancelled.');
      await calCountdown();
      if (_calAborted) throw new Error('Calibration cancelled.');

      const points = buildGrid(CFG.GRID_COLS, CFG.GRID_ROWS);
      const data = [];
      calHint('Look at the centre of the target each time it stops.');

      for (let i = 0; i < points.length; i++) {
        if (_calAborted) throw new Error('Calibration cancelled.');
        const pt = points[i];
        calCount('Point ' + (i+1) + ' of ' + points.length);
        calBar(i / points.length);
        moveDot(pt.sx, pt.sy);
        await nap(CFG.DOT_TRAVEL_MS + CFG.SETTLE_MS);

        let got = await captureAtPoint(pt, data, 1.0);
        if (got < CFG.MIN_PER_POINT) {
          calHint('Hold still — capturing this point again.');
          await nap(250);
          got += await captureAtPoint(pt, data, 0.8);
          calHint('Follow the dot with your eyes. Keep your head still.');
        }
      }
      calBar(1);

      if (data.length < CFG.MIN_TOTAL) {
        throw new Error('Only ' + data.length + ' usable samples were captured (at least ' + CFG.MIN_TOTAL +
                        ' are needed). Improve the lighting and keep your face centred, then try again.');
      }

      modelX = fitRidge(data, 'sx', CFG.RIDGE_LAMBDA);
      modelY = fitRidge(data, 'sy', CFG.RIDGE_LAMBDA);
      _calError = fitRms(data);
      _calibrated = true;

      const agreement = fitAgreement(data);
      if (agreement < 0.35) {
        throw new Error(
          'The eye features barely changed as the target moved (R\u00b2 = ' + agreement.toFixed(2) + ').\n\n' +
          'That means the gaze did not follow the target: either the target was not visible, the participant ' +
          'was not looking at it, or the camera image is not usable for iris tracking.\n\n' +
          'Nothing was learned from this run, so it has been discarded rather than saved as a bad model.');
      }

      // Measure accuracy against target positions excluded from model fitting.
      calHint('Accuracy check — keep following the target.');
      const vPts = validationPoints();
      const errs = [];
      for (let i = 0; i < vPts.length; i++) {
        const pt = vPts[i];
        calCount('Check ' + (i+1) + ' of ' + vPts.length);
        moveDot(pt.sx, pt.sy);
        await nap(CFG.DOT_TRAVEL_MS + CFG.SETTLE_MS);
        const probe = [];
        await captureAtPoint(pt, probe, 1.0);
        for (const s of probe) {
          const px = ridgePredict(modelX, s.features), py = ridgePredict(modelY, s.features);
          errs.push(Math.hypot(px - pt.sx, py - pt.sy));
        }
      }
      hideDot();

      _validationError = errs.length ? errs.reduce((a,b)=>a+b,0) / errs.length : _calError;
      _calError = Number.isFinite(_validationError) ? _validationError : _calError;

      const he = $('he'); if (he) he.textContent = _calError.toFixed(1) + ' px';
      console.log('[EyeTracker v13.1] calibration: ' + data.length + ' samples / ' + points.length +
                  ' points, validation error ' + _calError.toFixed(1) + ' px');

      isCalibrating = false;
      _mode = 'tracking';
      startLoop();
      showSummary(_calError, data.length, points.length);

    } catch (err) {
      isCalibrating = false;
      _calibrated = false;
      _mode = 'idle';
      modelX = null; modelY = null;
      hideDot();
      hideCalUI();
      console.error('[EyeTracker v13.1] calibration error:', err);
      if (typeof window.reportClientError === 'function') window.reportClientError('calibration', err);
      const retry = confirm(err.message + '\n\nTry calibrating again?');
      if (retry) { setTimeout(calibrate, 200); }
      else if (typeof window.TestDiag === 'function') window.TestDiag('calibration abandoned by operator');
    } finally {
      window.removeEventListener('keydown', escHandler);
    }
  }

  /** Show or hide the gaze cursor. */
  function setCursorVisible(visible) {
    const cursor = $('gaze-cursor');
    if (cursor) cursor.style.display = visible ? 'block' : 'none';
  }

  // ── Public API ───────────────────────────────────────────────
  const api = {
    /** Register a callback for newly processed gaze samples. */
    onGaze(fn)  { if (typeof fn === 'function') _listeners.push(fn); },
    /** Remove a previously registered gaze callback. */
    offGaze(fn) { _listeners = _listeners.filter(l => l !== fn); },
    /** Return a copy of the most recent gaze sample. */
    getGaze()   { return { ..._latestGaze }; },

    /** Report whether a calibration model is available. */
    isCalibrated()        { return _calibrated; },
    /** Return the latest calibration error in pixels. */
    getCalibrationError() { return _calError || 0; },
    /** Return the held-out validation error in pixels. */
    getValidationError()  { return _validationError; },
    /** Return the measured gaze-processing frame rate. */
    getFPS()              { return _fps; },
    /** Return the measured gaze-processing frame rate. */
    getProcessingFPS()    { return _fps; },
    /** Return the camera's configured frame rate. */
    getCameraFPS()        { return _cameraFps; },
    /** Return the frame rate requested when opening the camera. */
    getRequestedFPS()     { return _requestedFps; },
    /** Return the camera's reported frame rate. */
    getActualFPS()        { return _actualFps; },
    /** Return the active camera resolution. */
    getCameraResolution() { return _cameraResolution; },
    /** Return the number of frames skipped while detection was busy. */
    getDroppedFrames()    { return _droppedFrames; },
    /** Return the total number of completed detector frames. */
    getTotalFrames()      { return _totalFrames; },
    /** Return the number of frames used to produce gaze samples. */
    getProcessedFrames()  { return _processedFrames; },
    /** Return the total number of emitted gaze samples. */
    getEmittedSamples()   { return _emittedSamples; },
    /** Return the smoothed detector inference time in milliseconds. */
    getDetectorMs()       { return _detectorMs; },
    /** Return the smoothed gaze-processing time in milliseconds. */
    getProcessMs()        { return _processMs; },
    /** Return the smoothed listener-callback time in milliseconds. */
    getListenerMs()       { return _listenerMs; },
    /** Return the blink count; blink detection is not currently implemented. */
    getBlinkCount()       { return 0; },
    /** Return the count of newly presented camera frames. */
    getTrueFrameCount()    { return _rvfcFrameCount; },
    /** Report whether camera-frame freshness gating is active. */
    isFrameGateActive()    { return _rvfcActive; },

    /** Report whether gaze samples have been emitted recently. */
    isEmitting() {
      return _mode === 'tracking' && _calibrated && !_paused &&
             (performance.now() - _lastEmitTs) < 1500;
    },
    /** Report whether a face was detected recently. */
    isFaceVisible() { return !!_lastKp && (performance.now() - _lastKpTs) < 600; },

    /** Return current camera, processing, calibration, and emission metrics. */
    getPerformanceStats() {
      return {
        mode: _mode,
        cameraFps: _cameraFps,
        requestedFps: _requestedFps,
        actualFps: _actualFps,
        cameraLabel: videoTrack ? videoTrack.label : '',
        cameraResolution: _cameraResolution,
        processingFps: _fps,
        totalFrames: _totalFrames,
        processedFrames: _processedFrames,
        droppedFrames: _droppedFrames,
        emittedSamples: _emittedSamples,
        dropRate: _totalFrames > 0 ? (_droppedFrames / _totalFrames) : 0,
        detectorMs: _detectorMs,
        processMs: _processMs,
        listenerMs: _listenerMs,
        cycleMs: _detectorMs + _processMs + _listenerMs,
        calibrationErrorPx: _calError,
        validationErrorPx: _validationError,
        emitting: api.isEmitting(),
        lastEmitAgoMs: _lastEmitTs ? Math.round(performance.now() - _lastEmitTs) : null,
        // Include camera-frame freshness data alongside emitted sample counts.
        trueFrameCount: _rvfcFrameCount,
        frameGateActive: _rvfcActive,
      };
    },

    // Preview and camera management.
    /** Initialize the tracker and return its active video element. */
    start: ensureStarted,
    /** Show the camera preview and report optional live statistics. */
    startPreview,
    /** Hide the preview while retaining the active camera stream. */
    stopPreview,
    /** List available cameras and flag likely infrared devices. */
    listCameras: enumerateCameras,
    /** Switch the active stream to a selected camera. */
    switchCamera,
    /** Return the active camera video element. */
    getVideoElement() { return videoEl; },
    /** Show or hide the gaze cursor. */
    setCursorVisible,

    /** Pause gaze sample processing without stopping camera detection. */
    pause()  { _paused = true; },
    /** Resume gaze sample processing after a pause. */
    resume() { _paused = false; },

    /** Run the calibration sequence and accuracy check. */
    calibrate,
    /** Run calibration again. */
    recalibrate: calibrate,
    /** Start calibration directly without an intermediate screen. */
    startDirectCalibration: calibrate,
    /** Request cancellation of the active calibration sequence. */
    abortCalibration() { _calAborted = true; },

    /** Stop tracking and release all camera and detector resources. */
    stop() {
      _listeners = [];
      _calibrated = false;
      isCalibrating = false;
      _calAborted = true;
      _previewCb = null;
      teardown();
      _startPromise = null;
      window._handoffMediaStream = null;
    },
  };

  return api;
})();

/** Start the tracker through the legacy battery-controller hook. */
window._startEyeTrackerNow = function () {
  return EyeTracker.start();
};

if (typeof window.sleep !== 'function') {
  /** Provide a shared delay helper when the page does not define one. */
  window.sleep = function (ms) { return new Promise(r => setTimeout(r, ms)); };
}
