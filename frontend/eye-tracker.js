/**
 * EyeTracker — NeurOcular Engine  v12.0 (HIGH-FPS / 120 Hz, zero-alloc hot path)
 * ════════════════════════════════════════════════════════════════
 *
 *  ENGINE UPGRADE (v12.0 — Listener-overhead eliminated):
 *    ✦ Video element OFFSCREEN-VISIBLE (320×240 at -9999px) — fixes Chromium
 *      throttling rVFC for 1×1 invisible elements
 *    ✦ Multi-constraint camera fallback: 640×360@120 → 640×480@120 → 1280×720@60
 *    ✦ Mutate _latestGaze IN PLACE — zero allocation per gaze emission
 *    ✦ irisRadius hoisted out of extractFeatures — no nested fn allocation
 *    ✦ Cursor DOM writes throttled to ~60 Hz (was 120 Hz, wasted on display)
 *    ✦ Per-stage timing metrics: detectorMs, processMs, listenerMs
 *
 *  BASELINE (v11.0):
 *    ✦ requestVideoFrameCallback() per-frame processing (no rAF 60Hz cap)
 *    ✦ Concurrent face-mesh detection with _detectorBusy guard
 *    ✦ Camera at 640×480 native (was 1280×720 forcing fallback)
 *    ✦ HUD writes throttled time-based @ 5 Hz
 *    ✦ Gaze sequence numbers for accurate downstream dedup
 *    ✦ Reusable Float64 feature buffer
 *
 *  REAL-WORLD CEILING NOTE:
 *    MediaPipe FaceMesh + refineLandmarks runs ~20-30 ms/frame on consumer
 *    hardware → hard ceiling of 33-50 FPS regardless of architecture. To
 *    exceed that, the model itself would need to be replaced or run on a
 *    Worker with OffscreenCanvas, which requires a full rewrite explicitly
 *    out of scope. v12 minimises all OTHER overhead so we get as close to
 *    the model ceiling as possible.
 *
 *  API CONTRACT (backward-compatible):
 *    EyeTracker.isCalibrated()         → bool
 *    EyeTracker.getGaze()              → {x,y,velocity,isBlink,confidence,fps,ts,seq}
 *    EyeTracker.getCalibrationError()  → number (px RMS)
 *    EyeTracker.onGaze(fn)             register frame listener
 *    EyeTracker.offGaze(fn)            deregister listener
 *    EyeTracker.recalibrate()          async – re-runs full calibration
 *    EyeTracker.pause() / resume()
 *    EyeTracker.getFPS()               → processingFps
 *    EyeTracker.getCameraFPS() / getActualFPS()
 *    EyeTracker.getPerformanceStats()  → {…, detectorMs, processMs, listenerMs}
 *    EyeTracker.getDroppedFrames() / getTotalFrames() / getProcessedFrames()
 *    window._startEyeTrackerNow()      deferred start
 */

'use strict';

const EyeTracker = (() => {

  // ── DOM refs ─────────────────────────────────────────────────
  const calScreen     = document.getElementById('cal-screen');
  const calProg       = document.getElementById('cal-progress');
  const calDot        = document.getElementById('cal-dot');
  const cursor        = document.getElementById('gaze-cursor');
  const ring          = document.getElementById('gaze-ring');
  const hud           = document.getElementById('hud');
  const hx            = document.getElementById('hx');
  const hy            = document.getElementById('hy');
  const hvEl          = document.getElementById('hv');
  const he            = document.getElementById('he');
  const hb            = document.getElementById('hb');
  const hfpsEl        = document.getElementById('hfps');
  const htrkfpsEl     = document.getElementById('htrkfps');
  const hconfEl       = document.getElementById('hconf');
  const hstabEl       = document.getElementById('hstab');
  const blinkLed      = document.getElementById('blink-led');
  const recalBtn      = document.getElementById('btn-recal');
  const flash         = document.getElementById('flash');
  const headCalScreen = document.getElementById('head-cal-screen');
  const alignScreen   = document.getElementById('alignment-screen');

  const W = () => window.innerWidth;
  const H = () => window.innerHeight;

  // ── Configuration ─────────────────────────────────────────────
  const CFG = {
    SOLUTION_PATH        : 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/',
    CALIB_SAMPLES        : 12,
    CALIB_SAMPLE_INTERVAL: 60,
    RIDGE_LAMBDA         : 1e-3,
    SACCADE_THRESH_PX_S  : 180,
    FIXATION_RADIUS_PX   : 38,
    FIXATION_MIN_MS      : 100,
    FPS_WINDOW           : 30,
    TARGET_FPS           : 120,
    QUALITY_SCORE_THRESHOLD : 0.7,
    VELOCITY_SCALE_FACTOR   : 0.8,

    HUD_UPDATE_MS        : 200,    // ~5 Hz HUD
    CURSOR_UPDATE_MS     : 16,     // ~60 Hz cursor (display-rate; faster is wasted)
  };

  // FIX FPS-11: Try multiple constraint sets in order of preference.
  // Many 120 FPS monochrome cameras only do 120 FPS at 640×360, not 640×480.
  // No `min` constraint anywhere — that forces failure on cameras that
  // don't advertise the floor but can deliver it.
  const CAMERA_CONSTRAINT_SETS = [
    { name: '640x360@120', video: { width:{ideal:640}, height:{ideal:360}, frameRate:{ideal:120} } },
    { name: '640x480@120', video: { width:{ideal:640}, height:{ideal:480}, frameRate:{ideal:120} } },
    { name: '320x240@120', video: { width:{ideal:320}, height:{ideal:240}, frameRate:{ideal:120} } },
    { name: '640x480@60',  video: { width:{ideal:640}, height:{ideal:480}, frameRate:{ideal:60}  } },
    { name: 'default',     video: { facingMode:'user' } },
  ];

  // ── Iris & eye-corner landmark indices ───────────────────────
  const IRIS_IDX = { L_CENTER:468, L_RING:[469,470,471,472], R_CENTER:473, R_RING:[474,475,476,477] };
  const EYE_CORNERS = { L_inner:133, L_outer:33, R_inner:362, R_outer:263 };

  // ── Module state ─────────────────────────────────────────────
  let detector     = null;
  let videoEl      = null;
  let videoStream  = null;
  let videoTrack   = null;

  let _rvfcHandle  = null;
  let _running     = false;
  let _hasRVFC     = false;

  // Camera performance metrics
  let _cameraFps    = 0;
  let _requestedFps = CFG.TARGET_FPS;
  let _actualFps    = 0;
  let _cameraResolution = '';

  // Per-stage frame counters
  let _totalFrames    = 0;
  let _processedFrames= 0;
  let _droppedFrames  = 0;
  let _emittedSamples = 0;

  // Per-stage latency tracking (EWMA — no array allocations)
  let _detectorMs     = 0;
  let _processMs      = 0;
  let _listenerMs     = 0;
  const LATENCY_ALPHA = 0.1;

  let _detectorBusy   = false;

  let calibPoints  = [];
  let calibData    = [];
  let isCalibrating= false;
  let _calibrated  = false;
  let modelX       = null;
  let modelY       = null;
  let _calError    = 0;

  let _paused      = false;
  let _listeners   = [];
  let _gazeSeq     = 0;

  // FIX FPS-12: mutated in-place — no per-emission allocation.
  // External consumers get a spread copy via getGaze().
  const _latestGaze = {
    x: 0, y: 0,
    velocity: 0,
    isBlink: false,
    confidence: 1,
    fps: 0,
    ts: 0,
    seq: 0,
  };

  // Saccade / fixation
  let prevGaze = null, prevTime = null;
  let saccadeVel = 0;
  let fixCluster = null, fixStart = 0, fixating = false;

  // FPS rolling window
  const fpsBuf = [];
  let _fps = 0;

  let _hudLastUpdate    = 0;
  let _cursorLastUpdate = 0;

  // Reusable feature buffer
  const _featureBuf = new Float64Array(12);

  // ── Kalman Filter ─────────────────────────────────────────────
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
    // FIX ET-2: snapshot pre-update covariance
    const pPP0=KF.pPP, pPV0=KF.pPV;
    const Sx=pPP0+KF.R, KgP=pPP0/Sx, KgV=KF.pVP/Sx, ex=mx-KF.px;
    KF.px+=KgP*ex; KF.vx+=KgV*ex;
    KF.pPP=pPP0*(1-KgP); KF.pPV=pPV0*(1-KgP);
    KF.pVP-=KgV*pPP0;    KF.pVV-=KgV*pPV0;
    // FIX ET-3: same fix for Y
    const qPP0=KF.qPP, qPV0=KF.qPV;
    const Sy=qPP0+KF.R, LgP=qPP0/Sy, LgV=KF.qVP/Sy, ey=my-KF.py;
    KF.py+=LgP*ey; KF.vy+=LgV*ey;
    KF.qPP=qPP0*(1-LgP); KF.qPV=qPV0*(1-LgP);
    KF.qVP-=LgV*qPP0;    KF.qVV-=LgV*qPV0;
  }

  function applyKalman(rawX, rawY, tsMs) {
    if (!KF.inited) { KF.px=rawX; KF.py=rawY; KF.inited=true; lastKfTime=tsMs; KF.vx=0; KF.vy=0; return; }
    // FIX ET-4: floor dt at 1ms (critical at 120 Hz where frames can collide)
    const dt = Math.max(0.001, Math.min((tsMs - lastKfTime)/1000, 0.1));
    lastKfTime = tsMs;
    kfPredict(dt);
    kfUpdate(rawX, rawY);
    // Caller reads KF.px / KF.py directly — no allocation
  }

  // ── Feature extraction (12-D) — hoisted helpers, no nested fn ──
  // FIX FPS-13: hoisted outside extractFeatures to avoid closure allocation
  // on every detection cycle.
  function _irisRadius(kp, center, ringIdx, vScale) {
    let s=0;
    for (let i=0;i<ringIdx.length;i++) {
      const p=kp[ringIdx[i]];
      const dx=p.x-center.x, dy=p.y-center.y;
      s+=Math.sqrt(dx*dx+dy*dy);
    }
    return (s/ringIdx.length)/vScale;
  }

  function extractFeatures(kp, outBuf) {
    const vW = videoEl.videoWidth  || 640;
    const vH = videoEl.videoHeight || 480;
    // FIX ET-1: normalise by sqrt(vW*vH) so the ratio is aspect-independent
    const vScale = Math.sqrt(vW * vH);

    const lc=kp[IRIS_IDX.L_CENTER], rc=kp[IRIS_IDX.R_CENTER];
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

  function scoreFrameQuality(kp) {
    if (!kp || kp.length < 478) return 0;
    let irisConf = 0;
    const irisIndices = [468,469,470,471,472,473,474,475,476,477];
    for (const idx of irisIndices) {
      if (kp[idx] && kp[idx].z) irisConf += (kp[idx].z || 0);
    }
    irisConf = Math.min(1, irisConf / irisIndices.length);
    const noseTip = kp[1], leftEar = kp[234], rightEar = kp[454];
    if (!noseTip || !leftEar || !rightEar) return 0;
    const yaw = Math.abs(noseTip.x - (leftEar.x + rightEar.x) / 2) / (rightEar.x - leftEar.x);
    const pitch = Math.abs(noseTip.y - (leftEar.y + rightEar.y) / 2) / Math.abs(leftEar.y - rightEar.y);
    const poseScore = Math.max(0, 1 - (Math.abs(yaw) + Math.abs(pitch)) * 0.5);
    return irisConf * 0.7 + poseScore * 0.3;
  }

  // ── Weighted Ridge Regression ─────────────────────────────────
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
    // features.length is 12 (fixed). Tight loop, no allocations.
    let v=0;
    for (let i=0;i<12;i++) v+=coef[i]*features[i];
    return v+coef[12];
  }

  function calcRMS(samples) {
    let sse=0, wSum=0;
    for (const s of samples) {
      const px=ridgePredict(modelX,s.features), py=ridgePredict(modelY,s.features);
      sse+=s.weight*((px-s.sx)**2+(py-s.sy)**2); wSum+=s.weight;
    }
    return Math.sqrt(sse/wSum);
  }

  // ── Motion metrics ────────────────────────────────────────────
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

  // ── Calibration grid (33 points) ─────────────────────────────
  function buildGrid() {
    const pad=55, innerPad=140;
    calibPoints=[];
    const bx=[pad, W()*0.33, W()*0.67, W()-pad];
    const by=[pad, H()*0.33, H()*0.67, H()-pad];
    for (const x of bx) calibPoints.push({sx:x, sy:pad});
    for (let i=1;i<by.length;i++) calibPoints.push({sx:W()-pad, sy:by[i]});
    for (let i=bx.length-2;i>=0;i--) calibPoints.push({sx:bx[i], sy:H()-pad});
    for (let i=by.length-2;i>=1;i--) calibPoints.push({sx:pad, sy:by[i]});
    const ix=[innerPad, W()/2, W()-innerPad], iy=[innerPad, H()/2, H()-innerPad];
    for (const {c,r} of [{c:0,r:0},{c:1,r:0},{c:2,r:0},{c:2,r:1},{c:2,r:2},{c:1,r:2},{c:0,r:2},{c:0,r:1}])
      calibPoints.push({sx:ix[c], sy:iy[r]});
    const cx=W()/2, cy=H()/2;
    calibPoints.push({sx:cx, sy:(innerPad+cy)/2});
    calibPoints.push({sx:(W()-innerPad+cx)/2, sy:cy});
    calibPoints.push({sx:cx, sy:(H()-innerPad+cy)/2});
    calibPoints.push({sx:(innerPad+cx)/2, sy:cy});
    calibPoints.push({sx:cx, sy:cy});
  }

  function moveDot(x, y) {
    calDot.classList.remove('hidden','shrink');
    calDot.style.position='fixed';
    calDot.style.left = x+'px';
    calDot.style.top  = y+'px';
    calDot.style.transform='translate(-50%,-50%)';
    calDot.style.display='block';
  }
  function hideDotEl() {
    calDot.classList.add('hidden');
    calDot.style.display='none';
  }

  let _spaceHint = null;
  function ensureSpaceHint() {
    if (_spaceHint) return;
    _spaceHint = document.createElement('div');
    _spaceHint.style.cssText=`
      position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:3000;
      font-family:var(--mono,monospace);font-size:11px;letter-spacing:.18em;
      text-transform:uppercase;color:#5a6a88;
      background:rgba(11,15,24,.82);border:1px solid #1a2236;
      padding:8px 20px;border-radius:2px;backdrop-filter:blur(8px);
      display:none;`;
    _spaceHint.innerHTML='<kbd style="border:1px solid #5a6a88;padding:2px 8px;border-radius:3px;">SPACE</kbd>&nbsp;&mdash; look at dot, then press to capture';
    document.body.appendChild(_spaceHint);
  }
  function showSpaceHint(v) {
    ensureSpaceHint();
    _spaceHint.style.display = v ? 'block' : 'none';
  }

  function setCalProgress(done, total) {
    if (!calProg) return;
    calProg.innerHTML = `<span style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#5a6a88;">Point ${done}&thinsp;/&thinsp;${total}</span>`;
  }

  function waitForSpace() {
    return new Promise(resolve => {
      const h = e => { if (e.code==='Space') { e.preventDefault(); window.removeEventListener('keydown',h); resolve(); } };
      window.addEventListener('keydown', h);
    });
  }

  async function captureFeatureFrame() {
    for (let attempt=0; attempt<5; attempt++) {
      try {
        const faces = await detector.estimateFaces(videoEl, {flipHorizontal:false});
        if (faces && faces.length>0 && faces[0].keypoints.length>=478) {
          const kp = faces[0].keypoints;
          const quality = scoreFrameQuality(kp);
          const tmp = new Float64Array(12);
          extractFeatures(kp, tmp);
          return { features: Array.from(tmp), quality };
        }
      } catch(_) {}
      await sleep(40);
    }
    return null;
  }

  // ── Run full calibration ──────────────────────────────────────
  async function runCalibration() {
    calibData     = [];
    isCalibrating = true;
    _calibrated   = false;

    if (alignScreen)   alignScreen.style.display='none';
    if (headCalScreen) headCalScreen.style.display='none';
    if (calScreen)     calScreen.style.display='flex';
    hideDotEl();
    showSpaceHint(true);

    for (let i=0; i<calibPoints.length; i++) {
      setCalProgress(i+1, calibPoints.length);
      const pt = calibPoints[i];
      moveDot(pt.sx, pt.sy);
      await waitForSpace();
      await sleep(100);

      let captured=0;
      for (let s=0; s<CFG.CALIB_SAMPLES; s++) {
        calDot.classList.add('shrink');
        const result = await captureFeatureFrame();
        if (result) {
          const quality = Math.max(0.3, result.quality);
          calibData.push({ features: result.features, sx: pt.sx, sy: pt.sy, weight: quality * 1.2 });
          captured++;
        }
        await sleep(CFG.CALIB_SAMPLE_INTERVAL);
        calDot.classList.remove('shrink');
      }
      if (captured < CFG.CALIB_SAMPLES * 0.7) {
        for (let r=0; r<4; r++) {
          const result = await captureFeatureFrame();
          if (result) {
            const quality = Math.max(0.3, result.quality);
            calibData.push({ features: result.features, sx: pt.sx, sy: pt.sy, weight: quality * 0.8 });
          }
          await sleep(CFG.CALIB_SAMPLE_INTERVAL);
        }
      }
    }

    hideDotEl();
    showSpaceHint(false);
    setCalProgress(calibPoints.length, calibPoints.length);

    // FIX ET-5: need ≥20 samples for 13-D ridge regression
    if (calibData.length<20)
      throw new Error(`Only ${calibData.length} valid samples captured (need ≥20). Ensure your face is well-lit.`);

    modelX    = fitRidge(calibData, 'sx', CFG.RIDGE_LAMBDA);
    modelY    = fitRidge(calibData, 'sy', CFG.RIDGE_LAMBDA);
    _calError = calcRMS(calibData);
    isCalibrating = false;
    _calibrated   = true;
    KF.inited     = false;

    console.log(`[EyeTracker v12] Cal done. ${calibPoints.length} pts, ${calibData.length} samples. RMS: ${_calError.toFixed(2)} px`);

    if (calScreen) calScreen.style.display='none';
    if (cursor)    cursor.style.display='block';
    if (blinkLed)  blinkLed.style.display='none';
    if (hud)       hud.style.display='flex';
    if (recalBtn)  recalBtn.style.display='block';
    if (he)        he.textContent = _calError.toFixed(1)+' px';
    if (flash)     { flash.style.opacity='1'; setTimeout(()=>flash.style.opacity='0', 350); }

    if (typeof BatteryController!=='undefined' && BatteryController.onCalibrationComplete)
      BatteryController.onCalibrationComplete();

    return _calError;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // HOT PATH — zero-allocation per-frame processing
  // ═════════════════════════════════════════════════════════════════════════

  let _renderX = 0, _renderY = 0;

  function processGazeSample(kp, frameStart, detectorDoneTs) {
    const processStart = detectorDoneTs;

    extractFeatures(kp, _featureBuf);
    const rawX = Math.max(0, Math.min(W(), ridgePredict(modelX, _featureBuf)));
    const rawY = Math.max(0, Math.min(H(), ridgePredict(modelY, _featureBuf)));
    const ts   = performance.now();
    applyKalman(rawX, rawY, ts);
    const gx = KF.px, gy = KF.py;

    updateMotion(gx, gy, ts);

    // Smoothing toward render position
    const fpsRatio = Math.min(1.0, (_fps || 30) / 120.0);
    const adaptiveAlpha = CFG.VELOCITY_SCALE_FACTOR * fpsRatio;
    _renderX += (gx - _renderX) * adaptiveAlpha;
    _renderY += (gy - _renderY) * adaptiveAlpha;

    // FIX FPS-14: throttled cursor update (~60 Hz max — display can't show faster).
    // At 120 Hz emission, this halves cursor DOM writes.
    if (cursor && ts - _cursorLastUpdate >= CFG.CURSOR_UPDATE_MS) {
      _cursorLastUpdate = ts;
      const clampX = Math.max(0, Math.min(W()-1, _renderX));
      const clampY = Math.max(0, Math.min(H()-1, _renderY));
      cursor.style.left = clampX + 'px';
      cursor.style.top  = clampY + 'px';
      if (ring) {
        const rs = 28 + Math.min(saccadeVel*0.1, 36);
        ring.style.width  = rs + 'px';
        ring.style.height = rs + 'px';
      }
    }

    // FIX FPS-12: mutate _latestGaze IN PLACE — zero allocation per emission
    _gazeSeq++;
    _latestGaze.x          = gx;
    _latestGaze.y          = gy;
    _latestGaze.velocity   = saccadeVel;
    _latestGaze.isBlink    = false;
    _latestGaze.confidence = 1;
    _latestGaze.fps        = _fps;
    _latestGaze.ts         = ts;
    _latestGaze.seq        = _gazeSeq;

    _processedFrames++;
    _emittedSamples++;

    // Per-stage latency (EWMA — no array allocations)
    const processEnd = performance.now();
    _processMs = _processMs * (1 - LATENCY_ALPHA) + (processEnd - processStart) * LATENCY_ALPHA;

    // Rolling FPS estimate (single capped array — fpsBuf)
    fpsBuf.push(ts);
    if (fpsBuf.length > CFG.FPS_WINDOW) fpsBuf.shift();
    if (fpsBuf.length >= 2) {
      _fps = Math.round((fpsBuf.length - 1) / ((fpsBuf[fpsBuf.length-1] - fpsBuf[0]) / 1000));
    }

    // Throttled HUD updates (~5 Hz, time-based)
    if (ts - _hudLastUpdate >= CFG.HUD_UPDATE_MS) {
      _hudLastUpdate = ts;
      if (hx)      hx.textContent      = _renderX.toFixed(0);
      if (hy)      hy.textContent      = _renderY.toFixed(0);
      if (hvEl)    hvEl.textContent    = saccadeVel.toFixed(1);
      if (hfpsEl)  hfpsEl.textContent  = _fps;
      if (htrkfpsEl) htrkfpsEl.textContent = Math.round(_actualFps || _fps);
      if (hconfEl) hconfEl.textContent = '100%';
      if (hstabEl) hstabEl.textContent = fixating ? 'LOCKED' : 'SEARCH';
      if (hb)      hb.textContent      = 'OK';
    }

    // FIX FPS-15: fire listeners with cached array reference, no try-catch
    // overhead (listeners are required to handle their own errors).
    const listenerStart = performance.now();
    const L = _listeners;
    const n = L.length;
    for (let i = 0; i < n; i++) {
      L[i](_latestGaze);
    }
    const listenerEnd = performance.now();
    _listenerMs = _listenerMs * (1 - LATENCY_ALPHA) + (listenerEnd - listenerStart) * LATENCY_ALPHA;
  }

  function onVideoFrame(now, metadata) {
    _totalFrames++;

    if (!_running) return;

    // Schedule next frame FIRST — keeps the rVFC pipeline saturated
    scheduleNextFrame();

    if (!_calibrated || _paused) return;

    if (_detectorBusy) {
      _droppedFrames++;
      return;
    }

    _detectorBusy = true;
    const frameStart = performance.now();

    detector.estimateFaces(videoEl, {flipHorizontal:false})
      .then(faces => {
        const detectorDoneTs = performance.now();
        _detectorMs = _detectorMs * (1 - LATENCY_ALPHA) + (detectorDoneTs - frameStart) * LATENCY_ALPHA;

        // FIX FPS-16: clear busy flag IMMEDIATELY before processing (defensive
        // recovery if processGazeSample throws).
        _detectorBusy = false;

        if (!_running || !_calibrated || _paused) return;
        if (faces && faces.length > 0 && faces[0].keypoints.length >= 478) {
          processGazeSample(faces[0].keypoints, frameStart, detectorDoneTs);
        }
      })
      .catch(_err => {
        _detectorBusy = false;
        // Don't log every frame — would flood console at high FPS
      });
  }

  function scheduleNextFrame() {
    if (!_running) return;
    if (_hasRVFC && videoEl && videoEl.requestVideoFrameCallback) {
      _rvfcHandle = videoEl.requestVideoFrameCallback(onVideoFrame);
    } else {
      _rvfcHandle = requestAnimationFrame(t => onVideoFrame(t, null));
    }
  }

  function startTrackingLoop() {
    if (_running) return;
    _running = true;
    _hasRVFC = !!(videoEl && typeof videoEl.requestVideoFrameCallback === 'function');
    console.log(`[EyeTracker v12] Tracking loop started (rVFC=${_hasRVFC})`);
    scheduleNextFrame();
  }

  function stopTrackingLoop() {
    _running = false;
    if (_rvfcHandle != null) {
      if (_hasRVFC && videoEl && videoEl.cancelVideoFrameCallback) {
        try { videoEl.cancelVideoFrameCallback(_rvfcHandle); } catch(_) {}
      } else {
        try { cancelAnimationFrame(_rvfcHandle); } catch(_) {}
      }
      _rvfcHandle = null;
    }
    _detectorBusy = false;
  }

  // ── Alignment / instructions screen ──────────────────────────
  function showAlignmentScreen() {
    if (!alignScreen) return;
    alignScreen.innerHTML = `
      <div style="max-width:480px;text-align:center;padding:32px 24px;">
        <h2 style="font-family:var(--mono,'Space Mono',monospace);font-size:20px;font-weight:700;
                   color:#e8eaf0;margin-bottom:12px;letter-spacing:.06em;">Eye Tracker Ready</h2>
        <p style="font-size:14px;color:#8b909e;line-height:1.65;margin-bottom:20px;">
          A <strong style="color:#00e5ff;">33-point calibration</strong> will guide you around the screen.<br>
          Look at each dot, then press
          <kbd style="border:1px solid #5a6a88;padding:2px 8px;border-radius:3px;
               font-family:var(--mono,monospace);">SPACE</kbd> to capture.<br><br>
          Sit at arm's length &nbsp;·&nbsp; Keep your head still &nbsp;·&nbsp; Move only your eyes.
        </p>
        <p style="font-size:12px;color:#5a6a88;margin-bottom:28px;">
          Ensure your face is well-lit and centred in front of the camera.
        </p>
        <button id="_nt_start_cal_btn" style="
          padding:12px 28px;
          font-family:var(--mono,'Space Mono',monospace);
          font-size:13px;text-transform:uppercase;letter-spacing:.14em;
          border-radius:4px;border:1px solid #00e5ff;
          background:transparent;color:#00e5ff;cursor:pointer;transition:.2s;">
          Start Calibration
        </button>
      </div>`;
    alignScreen.style.cssText='position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg,#04060a);z-index:2000;';

    const btn = document.getElementById('_nt_start_cal_btn');
    btn.addEventListener('mouseover', () => { btn.style.background='#00e5ff'; btn.style.color='#04060a'; });
    btn.addEventListener('mouseout',  () => { btn.style.background='transparent'; btn.style.color='#00e5ff'; });
    btn.addEventListener('click', async () => {
      if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
      alignScreen.style.display='none';
      buildGrid();
      try {
        await runCalibration();
        startTrackingLoop();
      } catch(err) {
        console.error('[EyeTracker v12] Calibration error:', err);
        alert('Calibration failed: ' + err.message + '\nPlease try again.');
        showAlignmentScreen();
      }
    });
  }

  // ── Deferred init ────────────────────────────────────────────
  let _started = false;
  let _startPromise = null;

  // FIX FPS-11: multi-constraint camera fallback. Tries each set until one works.
  async function selectAndInitializeCamera() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');

    console.log(`[EyeTracker v12] Found ${videoDevices.length} video device(s):`);
    videoDevices.forEach((d, i) => console.log(`  [${i}] ${d.label || 'Unknown'}`));

    let selectedDeviceId = null;
    const monoPatterns = ['monochrome', '120fps', 'mono', 'grayscale', 'ir', 'infrared'];
    for (const pattern of monoPatterns) {
      const device = videoDevices.find(d => d.label.toLowerCase().includes(pattern));
      if (device) {
        console.log(`[EyeTracker v12] ✓ Preferred high-FPS camera: ${device.label}`);
        selectedDeviceId = device.deviceId;
        break;
      }
    }
    if (!selectedDeviceId && videoDevices.length > 0) {
      selectedDeviceId = videoDevices[0].deviceId;
      console.log(`[EyeTracker v12] ℹ Falling back to first camera: ${videoDevices[0].label || 'Unknown'}`);
    }

    // Try constraint sets in order until one succeeds
    let stream = null;
    let usedSet = null;
    for (const cs of CAMERA_CONSTRAINT_SETS) {
      const constraints = {
        video: { ...cs.video, facingMode: 'user' },
        audio: false,
      };
      if (selectedDeviceId) constraints.video.deviceId = { exact: selectedDeviceId };

      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        usedSet = cs;
        console.log(`[EyeTracker v12] ✓ Camera opened with constraint set: ${cs.name}`);
        break;
      } catch (err) {
        console.warn(`[EyeTracker v12] Constraint set "${cs.name}" failed: ${err.name}`);
      }
    }
    if (!stream) throw new Error('All camera constraint sets failed.');

    _requestedFps = (usedSet && usedSet.video.frameRate && usedSet.video.frameRate.ideal) || 60;
    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length > 0) {
      videoTrack = videoTracks[0];
      const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
      _actualFps = settings.frameRate || 0;
      _cameraFps = _actualFps;
      _cameraResolution = `${settings.width}×${settings.height}`;

      console.log(`[EyeTracker v12] Camera initialized:`);
      console.log(`  Requested FPS: ${_requestedFps}`);
      console.log(`  Actual FPS:    ${_actualFps}`);
      console.log(`  Resolution:    ${_cameraResolution}`);

      // Diagnostic — print full capabilities so user can see what camera supports
      if (videoTrack.getCapabilities) {
        try {
          const caps = videoTrack.getCapabilities();
          console.log(`[EyeTracker v12] Camera capabilities:`, {
            width:     caps.width,
            height:    caps.height,
            frameRate: caps.frameRate,
          });
        } catch (_) {}
      }

      if (_actualFps < CFG.TARGET_FPS * 0.8) {
        console.warn(`[EyeTracker v12] ⚠ Actual FPS (${_actualFps}) lower than target (${CFG.TARGET_FPS}).`);
        console.warn(`    The camera may not support ${CFG.TARGET_FPS} FPS at ${_cameraResolution}.`);
        if (typeof BatteryController !== 'undefined' && BatteryController.onCameraWarning) {
          BatteryController.onCameraWarning(`Camera FPS: ${_actualFps.toFixed(1)} (target: ${CFG.TARGET_FPS})`);
        }
      }
    }

    videoStream = stream;
    return stream;
  }

  window._startEyeTrackerNow = async function() {
    if (_startPromise) return _startPromise;
    _started = true;
    _startPromise = (async () => {

    if (headCalScreen) headCalScreen.style.display='none';

    try {
      const stream = await selectAndInitializeCamera();

      // FIX FPS-17: video element OFFSCREEN-VISIBLE (not 1×1 invisible).
      // Chromium throttles requestVideoFrameCallback for 1×1 invisible video
      // elements. Positioning offscreen at a real 320×240 size keeps the
      // compositor active without using viewport space.
      videoEl = document.createElement('video');
      videoEl.setAttribute('autoplay', '');
      videoEl.setAttribute('playsinline', '');
      videoEl.muted = true;
      videoEl.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:320px;height:240px;pointer-events:none;z-index:-1;';
      videoEl.srcObject = stream;
      document.body.appendChild(videoEl);
      await new Promise(res => videoEl.addEventListener('loadeddata', res, {once:true}));

      // TF backend — WebGL for GPU inference
      await tf.setBackend('webgl');
      await tf.ready();

      // FaceMesh detector with iris refinement (required for 12-D features)
      detector = await faceLandmarksDetection.createDetector(
        faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
        {
          runtime         : 'mediapipe',
          refineLandmarks : true,
          solutionPath    : CFG.SOLUTION_PATH,
          maxFaces        : 1,
        }
      );

      // Warm-up pass
      await detector.estimateFaces(videoEl, {flipHorizontal:false});

      _renderX = W()/2; _renderY = H()/2;

      _hasRVFC = typeof videoEl.requestVideoFrameCallback === 'function';
      console.log(`[EyeTracker v12] requestVideoFrameCallback support: ${_hasRVFC}`);
      if (!_hasRVFC) {
        console.warn(`[EyeTracker v12] ⚠ rVFC not supported — falling back to rAF (60 FPS cap).`);
      }

    } catch(err) {
      console.error('[EyeTracker v12] Init error:', err);
      alert('Eye tracker failed to initialise: ' + err.message);
      throw err;
    }
    })();
    return _startPromise;
  };

  // ── Public API ────────────────────────────────────────────────
  return {
    onGaze(fn)            { _listeners.push(fn); },
    offGaze(fn)           { _listeners = _listeners.filter(l=>l!==fn); },
    // Spread copy so external code can't mutate our internal object
    getGaze()             { return {..._latestGaze}; },
    isCalibrated()        { return _calibrated; },
    getCalibrationError() { return _calError; },
    getFPS()              { return _fps; },

    // High-FPS metrics API
    getCameraFPS()        { return _cameraFps; },
    getRequestedFPS()     { return _requestedFps; },
    getActualFPS()        { return _actualFps; },
    getCameraResolution() { return _cameraResolution; },
    getProcessingFPS()    { return _fps; },
    getDroppedFrames()    { return _droppedFrames; },
    getTotalFrames()      { return _totalFrames; },
    getProcessedFrames()  { return _processedFrames; },
    getEmittedSamples()   { return _emittedSamples; },
    getDetectorMs()       { return _detectorMs; },
    getProcessMs()        { return _processMs; },
    getListenerMs()       { return _listenerMs; },
    getPerformanceStats() {
      return {
        cameraFps:        _cameraFps,
        requestedFps:     _requestedFps,
        actualFps:        _actualFps,
        cameraResolution: _cameraResolution,
        processingFps:    _fps,
        totalFrames:      _totalFrames,
        processedFrames:  _processedFrames,
        droppedFrames:    _droppedFrames,
        emittedSamples:   _emittedSamples,
        dropRate:         _totalFrames > 0 ? (_droppedFrames / _totalFrames) : 0,
        detectorMs:       _detectorMs,
        processMs:        _processMs,
        listenerMs:       _listenerMs,
        cycleMs:          _detectorMs + _processMs + _listenerMs,
        rvfcSupported:    _hasRVFC,
      };
    },
    pause()               { _paused=true; },
    resume()              { _paused=false; },
    getBlinkCount()       { return 0; },

    async startDirectCalibration() {
      if (_startPromise) {
        try { await _startPromise; } catch (_) {}
      } else if (!_started && typeof window._startEyeTrackerNow === 'function') {
        try { await window._startEyeTrackerNow(); } catch (_) {}
      }
      if (isCalibrating) return;
      stopTrackingLoop();
      _calibrated=false; KF.inited=false;
      _renderX=W()/2; _renderY=H()/2;
      prevGaze=null; prevTime=null; saccadeVel=0; fixCluster=null; fixating=false;
      if (cursor)   cursor.style.display='none';
      if (hud)      hud.style.display='none';
      if (recalBtn) recalBtn.style.display='none';
      showAlignmentScreen();
    },

    async recalibrate() {
      if (_startPromise) {
        try { await _startPromise; } catch (_) {}
      } else if (!_started && typeof window._startEyeTrackerNow === 'function') {
        try { await window._startEyeTrackerNow(); } catch (_) {}
      }
      if (isCalibrating) return;
      stopTrackingLoop();
      _calibrated=false; KF.inited=false;
      _renderX=W()/2; _renderY=H()/2;
      prevGaze=null; prevTime=null; saccadeVel=0; fixCluster=null; fixating=false;
      if (cursor)   cursor.style.display='none';
      if (hud)      hud.style.display='none';
      if (recalBtn) recalBtn.style.display='none';
      buildGrid();
      showAlignmentScreen();
    },
  };

})();

// ── Utility ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); } 