/**
 * EyeTracker — NeurOcular Engine  v13.0
 * ════════════════════════════════════════════════════════════════
 *
 *  WHAT CHANGED VS v12 (and why)
 *  ─────────────────────────────
 *  1. ONE CAMERA, ONE PREVIEW, ONE DETECTOR.
 *     v12 opened a getUserMedia stream in BatteryController.start() for the
 *     lighting screen, then EyeTracker opened/handed-off its own, then
 *     showAlignmentScreen() drew a SECOND camera preview ("Eye Tracker
 *     Ready") before the grid. That is the "camera opens twice / extra
 *     calibration screen" symptom. showAlignmentScreen() is gone. The
 *     camera-check screen now previews EyeTracker's own <video> through
 *     startPreview(), so what the operator sees is literally what the
 *     tracker sees, and nothing is opened a second time.
 *
 *  2. FRAME LOOP IS rAF-DRIVEN, NOT rVFC-DRIVEN.
 *     v12 drove inference from requestVideoFrameCallback on a video parked
 *     at left:-9999px. Chromium throttles (and in some states stops) rVFC
 *     for videos it considers non-rendered, and the element was also moved
 *     between three different parents during startup. When rVFC stopped
 *     firing, processGazeSample() never ran, no onGaze listener ever fired,
 *     and every task recorded zero rows -> "FV:0 SPEM:0 SZ:0". The loop is
 *     now plain requestAnimationFrame (60 Hz >> the 33-50 FPS MediaPipe
 *     ceiling, so nothing is lost) with a 2 s stall watchdog that clears a
 *     stuck _detectorBusy flag and restarts the loop.
 *
 *  3. CAMERA SELECTION NO LONGER PREFERS IR CAMERAS.
 *     v12 scored device labels with `label.includes('ir')`, which matches
 *     "Wireless", "Virtual", "Direct", "IR Camera", ... On laptops with a
 *     Windows Hello IR sensor this selected the infrared camera: a dark
 *     red/greyscale image that FaceMesh cannot land 478 landmarks on. The
 *     matcher is now word-boundary based and *demotes* IR/depth devices.
 *     listCameras()/switchCamera() let the operator override from the UI.
 *
 *  4. CALIBRATION IS AUTOMATIC AND SELF-CHECKING.
 *     33 points x "press SPACE" is 33 chances to capture a frame where the
 *     participant is not actually on the dot. Now: 20 points (5x4), dot
 *     travels, settles, shrinks, and samples are pulled from the loop's
 *     latest landmarks with a quality gate; weak points are retried once;
 *     then 5 held-out validation points measure real error in pixels and
 *     the result is shown with Continue / Recalibrate.
 *
 *  5. THE GAZE CURSOR IS HIDDEN AFTER CALIBRATION.
 *     A dot following the participant's gaze during SPEM / antisaccade /
 *     free viewing is a closed feedback loop and contaminates every task.
 *     setCursorVisible(true) if you want it back for debugging.
 *
 *  API (superset of v12 — nothing that battery-controller.js called was removed)
 *  ─────────────────────────────────────────────────────────────────────────
 *    window._startEyeTrackerNow()          open camera + load FaceMesh
 *    EyeTracker.startPreview(el, onStats)  show live preview inside el
 *    EyeTracker.stopPreview()              park the video, keep the stream
 *    EyeTracker.listCameras()              -> [{deviceId,label,isIR}]
 *    EyeTracker.switchCamera(deviceId)     re-open on another device
 *    EyeTracker.calibrate()                full grid + validation
 *    EyeTracker.recalibrate()              alias of calibrate()
 *    EyeTracker.startDirectCalibration()   alias of calibrate()
 *    EyeTracker.isCalibrated() / getCalibrationError()
 *    EyeTracker.onGaze(fn) / offGaze(fn) / getGaze()
 *    EyeTracker.isEmitting()               true if gaze fired in last 1.5 s
 *    EyeTracker.getPerformanceStats()      incl. emitting / lastEmitAgoMs
 *    EyeTracker.setCursorVisible(bool)
 *    EyeTracker.pause() / resume() / stop()
 */

'use strict';

const EyeTracker = (() => {

  const $ = (id) => document.getElementById(id);
  const W = () => window.innerWidth;
  const H = () => window.innerHeight;
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

  // 640x480@60 first: MediaPipe FaceMesh tops out near 33-50 FPS anyway, and
  // 60 FPS modes are far more widely supported (and better exposed) than the
  // 120 FPS modes v12 asked for first.
  const CAMERA_CONSTRAINT_SETS = [
    { name: '640x480@60',  video: { width:{ideal:640},  height:{ideal:480}, frameRate:{ideal:60} } },
    { name: '1280x720@30', video: { width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30} } },
    { name: '640x480@30',  video: { width:{ideal:640},  height:{ideal:480}, frameRate:{ideal:30} } },
    { name: 'default',     video: {} },
  ];

  // Word-boundary match so "Wireless"/"Virtual"/"Direct" are not read as "ir".
  const IR_LABEL_RE = /(^|[^a-z])(ir|infra[- ]?red|depth|tof|3d)([^a-z]|$)/i;
  const CAMERA_PREF_KEY = 'neurocular.cameraId';

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

  // ── Kalman filter (unchanged maths from v12) ─────────────────
  const KF = {
    px:0, vx:0, py:0, vy:0,
    pPP:500, pPV:0, pVP:0, pVV:500,
    qPP:500, qPV:0, qVP:0, qVV:500,
    Q_p:1.0, Q_v:3.0, R:110, inited:false,
  };
  let lastKfTime = null;

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
  function applyKalman(rawX, rawY, tsMs) {
    if (!KF.inited) { KF.px=rawX; KF.py=rawY; KF.vx=0; KF.vy=0; KF.inited=true; lastKfTime=tsMs; return; }
    const dt = Math.max(0.001, Math.min((tsMs - lastKfTime)/1000, 0.1));
    lastKfTime = tsMs;
    kfPredict(dt);
    kfUpdate(rawX, rawY);
  }

  // ── Feature extraction (12-D, unchanged) ─────────────────────
  function _irisRadius(kp, center, ringIdx, vScale) {
    let s = 0;
    for (let i=0;i<ringIdx.length;i++) {
      const p = kp[ringIdx[i]];
      const dx = p.x-center.x, dy = p.y-center.y;
      s += Math.sqrt(dx*dx+dy*dy);
    }
    return (s/ringIdx.length)/vScale;
  }

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

  // v12's quality score summed raw landmark z values, which are signed and
  // unbounded, so it collapsed to ~0 for perfectly good frames. This version
  // scores what actually matters for a webcam gaze model: how much of the
  // frame the face fills, and how frontal the head is.
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

  function ridgePredict(coef, features) {
    let v=0;
    for (let i=0;i<12;i++) v+=coef[i]*features[i];
    return v+coef[12];
  }

  function fitRms(samples) {
    let sse=0, wSum=0;
    for (const s of samples) {
      const px=ridgePredict(modelX,s.features), py=ridgePredict(modelY,s.features);
      sse+=s.weight*((px-s.sx)**2+(py-s.sy)**2); wSum+=s.weight;
    }
    return wSum > 0 ? Math.sqrt(sse/wSum) : NaN;
  }

  // ── Motion metrics ───────────────────────────────────────────
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

  // ══════════════════════════════════════════════════════════════
  // HOT PATH
  // ══════════════════════════════════════════════════════════════
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

  // ── Frame loop (requestAnimationFrame driven) ────────────────
  function frameTick() {
    if (!_running) return;
    _rafHandle = requestAnimationFrame(frameTick);

    if (!detector || !videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0) return;
    if (_detectorBusy) { _droppedFrames++; return; }

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

  function startLoop() {
    if (_running) return;
    _running = true;
    _lastFrameTs = performance.now();
    _rafHandle = requestAnimationFrame(frameTick);
    if (!_watchdog) _watchdog = setInterval(watchdogTick, 1000);
    tdiag('frame loop started', { mode: _mode });
  }

  function stopLoop() {
    _running = false;
    if (_rafHandle != null) { try { cancelAnimationFrame(_rafHandle); } catch (_) {} _rafHandle = null; }
    if (_watchdog) { clearInterval(_watchdog); _watchdog = null; }
    _detectorBusy = false;
  }

  // A hung estimateFaces promise (WebGL context loss, tab throttling, a
  // camera track that went "muted") used to silently end the session: the
  // busy flag stayed true forever and no further frame was ever processed.
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

  // ══════════════════════════════════════════════════════════════
  // CAMERA
  // ══════════════════════════════════════════════════════════════
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

  async function pickDefaultCamera() {
    const saved = (() => { try { return localStorage.getItem(CAMERA_PREF_KEY); } catch (_) { return null; } })();
    const cams = await enumerateCameras();
    if (saved && cams.some(c => c.deviceId === saved)) return saved;
    const rgb = cams.find(c => !c.isIR);
    return rgb ? rgb.deviceId : (cams[0] ? cams[0].deviceId : null);
  }

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

  function parkVideo() {
    if (!videoEl) return;
    // Kept in the layout (3x3 px, near-invisible) rather than at left:-9999px:
    // browsers de-prioritise decoding for elements they consider off-screen.
    videoEl.style.cssText =
      'position:fixed;left:2px;bottom:2px;width:3px;height:3px;opacity:0.02;' +
      'pointer-events:none;z-index:0;object-fit:cover;';
    document.body.appendChild(videoEl);
    videoEl.play().catch(() => {});
  }

  // ── Startup ──────────────────────────────────────────────────
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

  // ══════════════════════════════════════════════════════════════
  // PREVIEW (used by the camera-check screen)
  // ══════════════════════════════════════════════════════════════
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

  function stopPreview() {
    _previewCb = null;
    if (_mode === 'preview') _mode = 'idle';
    parkVideo();
  }

  // ══════════════════════════════════════════════════════════════
  // CALIBRATION
  // ══════════════════════════════════════════════════════════════
  const CAL_BG = '#0b0d12';

  function calUI() {
    const screen = $('cal-screen');
    if (!screen) throw new Error('#cal-screen missing from the page.');
    screen.style.cssText =
      'position:fixed;inset:0;z-index:2600;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;background:' + CAL_BG + ';';

    const header = $('cal-header');
    if (header) header.style.display = 'none';

    let panel = $('_nt_cal_panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = '_nt_cal_panel';
      panel.style.cssText =
        'position:fixed;left:50%;bottom:56px;transform:translateX(-50%);width:min(520px,80vw);' +
        'text-align:center;color:#c9d2e0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;';
      panel.innerHTML =
        '<div id="_nt_cal_hint" style="font-size:15px;line-height:1.5;color:#e8edf5;margin-bottom:14px;min-height:22px;"></div>' +
        '<div style="height:3px;background:#1d2430;border-radius:2px;overflow:hidden;">' +
          '<div id="_nt_cal_bar" style="height:100%;width:0%;background:#4fd8c4;transition:width .25s ease;"></div>' +
        '</div>' +
        '<div id="_nt_cal_count" style="font-size:12px;color:#6e7a8c;margin-top:8px;"></div>';
      document.body.appendChild(panel);
    }
    panel.style.display = 'block';
    return panel;
  }

  function calHint(text)  { const el = $('_nt_cal_hint');  if (el) el.textContent = text; }
  function calCount(text) { const el = $('_nt_cal_count'); if (el) el.textContent = text; }
  function calBar(frac)   { const el = $('_nt_cal_bar');   if (el) el.style.width = Math.round(frac*100) + '%'; }
  function hideCalUI() {
    const panel = $('_nt_cal_panel'); if (panel) panel.style.display = 'none';
    const screen = $('cal-screen');   if (screen) screen.style.display = 'none';
  }

  function calDotEl() {
    const dot = $('cal-dot');
    if (!dot) return null;
    if (!dot._ntStyled) {
      dot._ntStyled = true;
      dot.innerHTML = '<span style="position:absolute;left:50%;top:50%;width:6px;height:6px;' +
                      'margin:-3px 0 0 -3px;border-radius:50%;background:' + CAL_BG + ';"></span>';
    }
    dot.style.background = '#ffffff';
    dot.style.boxShadow  = '0 0 0 4px rgba(255,255,255,.08), 0 0 22px rgba(255,255,255,.35)';
    dot.style.transition = 'left ' + CFG.DOT_TRAVEL_MS + 'ms cubic-bezier(.22,.61,.36,1),' +
                           ' top ' + CFG.DOT_TRAVEL_MS + 'ms cubic-bezier(.22,.61,.36,1),' +
                           ' width .18s, height .18s, opacity .25s';
    return dot;
  }

  function moveDot(x, y) {
    const dot = calDotEl(); if (!dot) return;
    dot.classList.remove('hidden');
    dot.style.position = 'fixed';
    dot.style.display  = 'block';
    dot.style.left     = x + 'px';
    dot.style.top      = y + 'px';
    dot.style.transform = 'translate(-50%,-50%)';
  }
  function hideDot() {
    const dot = $('cal-dot');
    if (dot) { dot.classList.add('hidden'); dot.style.display = 'none'; }
  }

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

  function validationPoints() {
    const mx = W()*0.25, Mx = W()*0.75, my = H()*0.25, My = H()*0.75;
    return [
      { sx: W()/2, sy: H()/2 },
      { sx: mx, sy: my }, { sx: Mx, sy: my },
      { sx: Mx, sy: My }, { sx: mx, sy: My },
    ].slice(0, CFG.VALIDATION_PTS);
  }

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

  // Pull samples from the loop's latest landmarks instead of issuing extra
  // estimateFaces() calls: one inference pipeline, no contention, and every
  // captured sample is a frame the tracker genuinely processed.
  async function captureAtPoint(pt, out, weightScale) {
    const dot = $('cal-dot');
    if (dot) dot.classList.add('shrink');
    const end = performance.now() + CFG.CAPTURE_MS;
    let n = 0, lastTs = 0;
    while (performance.now() < end && n < CFG.CAPTURE_TARGET) {
      if (_calAborted) break;
      if (_lastKp && _lastKpTs !== lastTs && (performance.now() - _lastKpTs) < 250 && _lastQuality >= CFG.QUALITY_MIN) {
        lastTs = _lastKpTs;
        const f = new Float64Array(12);
        extractFeatures(_lastKp, f);
        out.push({ features: Array.from(f), sx: pt.sx, sy: pt.sy, weight: Math.max(0.3, _lastQuality) * (weightScale || 1) });
        n++;
      }
      await nap(CFG.SAMPLE_POLL_MS);
    }
    if (dot) dot.classList.remove('shrink');
    return n;
  }

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
      'position:fixed;inset:0;z-index:2700;display:flex;align-items:center;justify-content:center;' +
      'background:' + CAL_BG + ';font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#e8edf5;';
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
      box.style.display = 'none';
      hideCalUI();
      setCursorVisible(false);
      if (typeof BatteryController !== 'undefined' && BatteryController.onCalibrationComplete) {
        BatteryController.onCalibrationComplete();
      }
    };
  }

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

    try {
      const ok = await waitForFace(CFG.FACE_WAIT_MS);
      if (!ok) throw new Error('No face was detected. Check the camera, the lighting, and that the right camera is selected.');

      const points = buildGrid(CFG.GRID_COLS, CFG.GRID_ROWS);
      const data = [];
      calHint('Follow the dot with your eyes. Keep your head still.');
      await nap(900);

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

      // Held-out validation: the fit RMS always flatters itself, so measure
      // against points the model was never trained on.
      calHint('Quick accuracy check — keep following the dot.');
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
      console.log('[EyeTracker v13] calibration: ' + data.length + ' samples / ' + points.length +
                  ' points, validation error ' + _calError.toFixed(1) + ' px');

      isCalibrating = false;
      _mode = 'tracking';
      startLoop();
      showSummary(_calError, data.length, points.length);

    } catch (err) {
      isCalibrating = false;
      _calibrated = false;
      _mode = 'idle';
      hideDot();
      hideCalUI();
      console.error('[EyeTracker v13] calibration error:', err);
      if (typeof window.reportClientError === 'function') window.reportClientError('calibration', err);
      const retry = confirm(err.message + '\n\nTry calibrating again?');
      if (retry) { setTimeout(calibrate, 200); }
      else if (typeof window.TestDiag === 'function') window.TestDiag('calibration abandoned by operator');
    }
  }

  function setCursorVisible(visible) {
    const cursor = $('gaze-cursor');
    if (cursor) cursor.style.display = visible ? 'block' : 'none';
  }

  // ══════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════
  const api = {
    onGaze(fn)  { if (typeof fn === 'function') _listeners.push(fn); },
    offGaze(fn) { _listeners = _listeners.filter(l => l !== fn); },
    getGaze()   { return { ..._latestGaze }; },

    isCalibrated()        { return _calibrated; },
    getCalibrationError() { return _calError || 0; },
    getValidationError()  { return _validationError; },
    getFPS()              { return _fps; },
    getProcessingFPS()    { return _fps; },
    getCameraFPS()        { return _cameraFps; },
    getRequestedFPS()     { return _requestedFps; },
    getActualFPS()        { return _actualFps; },
    getCameraResolution() { return _cameraResolution; },
    getDroppedFrames()    { return _droppedFrames; },
    getTotalFrames()      { return _totalFrames; },
    getProcessedFrames()  { return _processedFrames; },
    getEmittedSamples()   { return _emittedSamples; },
    getDetectorMs()       { return _detectorMs; },
    getProcessMs()        { return _processMs; },
    getListenerMs()       { return _listenerMs; },
    getBlinkCount()       { return 0; },

    // The single most useful guard for the "every task recorded zero rows"
    // failure: ask before starting a task instead of finding out at the end.
    isEmitting() {
      return _mode === 'tracking' && _calibrated && !_paused &&
             (performance.now() - _lastEmitTs) < 1500;
    },
    isFaceVisible() { return !!_lastKp && (performance.now() - _lastKpTs) < 600; },

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
      };
    },

    // preview / camera management
    start: ensureStarted,
    startPreview,
    stopPreview,
    listCameras: enumerateCameras,
    switchCamera,
    getVideoElement() { return videoEl; },
    setCursorVisible,

    pause()  { _paused = true; },
    resume() { _paused = false; },

    calibrate,
    recalibrate: calibrate,
    startDirectCalibration: calibrate,
    abortCalibration() { _calAborted = true; },

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

// Deferred start hook kept for backwards compatibility with battery-controller.js
window._startEyeTrackerNow = function () {
  return EyeTracker.start();
};

if (typeof window.sleep !== 'function') {
  window.sleep = function (ms) { return new Promise(r => setTimeout(r, ms)); };
}
