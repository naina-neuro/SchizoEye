/*
 * ============================================================
 *  battery-controller.js  —  Oculomotor Battery
 * ============================================================
 *
 *  The main application controller. Orchestrates all three
 *  tasks and the unified results screen.
 *
 *  ── TASK FLOW ───────────────────────────────────────────
 *  start()
 *    → camera check → video guide → grid calibration
 *    → onCalibrationComplete() → showTaskTransition(0)
 *
 *  Task 1 — SPEM (Smooth Pursuit Eye Movement)
 *    startSPEM() → practice trial → 3 clinical sequences
 *    (Horizontal_0.4Hz, Lissajous_0.2Hz, Lissajous_0.4Hz)
 *    each 20 s, target animated via rAF
 *    → finishSPEM() → showTaskTransition(1)
 *
 *  Task 2 — SchizoEye
 *    startSZ() [async]
 *      Phase I:  6 fixation trials (none/single/multi distractor)
 *      Phase II: 10 antisaccade trials (random ecc + side)
 *    → showTaskTransition(2)
 *
 *  Task 3 — Free Viewing
 *    startFreeViewing() → 25 images × 8 s
 *    gaze recorded by RawGazeCollector
 *    → finishFreeViewing() → showAllResults()
 *
 *  ── RESULTS ─────────────────────────────────────────────
 *  showAllResults() calls:
 *    renderFVResults()    — per-image sample count table
 *    renderSPEMResults()  — Plotly dual-axis graphs per sequence
 *    renderSZResults()    — scatter plots, waterfall, metric cards,
 *                           clinical interpretation flags
 *    runAIClassification() — 3-step pipeline:
 *        1. Parse raw gaze rows from all three tasks
 *        2. Extract 59 oculomotor features (pure JS, see below)
 *        3. POST features to Flask /classify endpoint (deployed model)
 *        → renderAIResults() + save to /save_results
 *        → reveal PDF download button
 *
 *  ── FEATURE EXTRACTOR (embedded inside this IIFE) ───────
 *  A pure-JS port of the Python oculomotor feature pipeline.
 *  Contained within this file because it shares state
 *  (spemDataLog, szCsv, RawGazeCollector) with the task code.
 *
 *  Sections inside battery-controller.js:
 *    FEATURE_ORDER  — ordered list of 59 feature names
 *    BOUNDS         — physiological clamp ranges per feature
 *    CONFIG         — algorithm hyperparameters (IDT, pursuit…)
 *    normalizeFv / normalizeSpem / normalizeSz
 *    idtFixations / idtResidualFixations
 *    computePointSpeeds / buildTransitions
 *    estimateScreenGeometry
 *    resampleLinear / amplitudeAtFrequency / periodogram
 *    computeLogSNR / computeGain / computeRmse
 *    extractFreeViewing / extractPursuit
 *    extractFixationCondition / extractAntisaccade
 *    roundFeature / finalizeFeature
 *    buildFvRows / buildSpemRowsForExtractor / buildSzRowsForExtractor
 *    runAIClassification / renderAIResults / renderFeaturesOnly
 *
 *  ── CSV / PDF EXPORT ─────────────────────────────────────
 *  downloadFVCSV()      raw gaze CSV (image_index, x, y, …)
 *  downloadSPEMCSV()    SPEM gaze CSV (Timestamp, phase, target, eye)
 *  downloadSZCSV()      SZ gaze CSV  (Timestamp_ms, phase, Gaze, Target)
 *  downloadAllCSV()     all three, staggered 600ms apart
 *  downloadSPEMPlots()  exports Plotly graphs as PNG via Plotly.downloadImage
 *  downloadPDFReport()  POSTs to Flask /generate-report, streams PDF blob
 *
 *  ── PUBLIC API ───────────────────────────────────────────
 *  Returned from IIFE:
 *    start, startVideoCal, startClickCal, onCalibrationComplete,
 *    downloadFVCSV, downloadSPEMCSV, downloadSZCSV, downloadAllCSV,
 *    downloadSPEMPlots, downloadPDFReport
 *
 *  Dependencies
 *  ────────────
 *  EyeTracker        (eye-tracker.js)
 *  RawGazeCollector  (gaze-collector.js)
 *  Plotly            (CDN — plotly-2.24.1.min.js)
 *  (audio instructions removed — no audio-utils.js)
 *  Flask backend     https://schizoeye-backend.onrender.com  (for /classify, /save_results,
 *                                            /generate-report endpoints)
 * ============================================================
 */
const BatteryController = (() => {
  const API_BASE = typeof window.getApiBase === 'function'
    ? window.getApiBase()
    : (window.SCHIZOEYE_API_BASE || 'https://schizoeye-backend.onrender.com').replace(/\/$/, '');
  const TEST_TOKEN = new URLSearchParams(window.location.search).get('token');
  const apiHeaders = () => TEST_TOKEN ? {'X-Test-Token': TEST_TOKEN} : {};
  // ── State ──────────────────────────────────────────────────────────────────
  let screenDiagonalInches = 15.6;  // default, overwritten in start()
let pxPerDeg = 37;                 // safe default for 15.6" 1920×1080 at 60 cm; overwritten in start()                
  let subjectId        = 'Subject_01';
  let patientName      = '';
  let patientAge       = '';
  let patientSex       = '';
  let panssScore       = '';
  let doctorNotes      = '';
  let currentTask      = 0; // 0=SPEM, 1=SZ, 2=FV
  let fvImages         = [];
  let fvImageLoadErrors = [];
  const FV_NUM_IMAGES  = 25;
  const FV_IMAGE_FOLDER = 'stimuli/';
  const FV_IMAGE_DISPLAY_DURATION = 8000;
  const FV_CROSSHAIR_DURATION = 1000;
  let fvCurrentImageIndex = 0;
  let fvExperimentTimeout = null, fvTimerInterval = null;

  // SPEM state
  const SPEM_TASK_DURATION_MS = 20000;
  const SPEM_FIXATION_DELAY_MS = 2000;
  const SPEM_REST_DELAY_MS = 2000;
  // FIX BC-1 (CRITICAL): Was 2000 px/s = only ~54°/s at 37px/deg.
  // Normal smooth pursuit peaks at 30–50°/s and saccades start above ~80–100°/s.
  // 2000 px/s incorrectly flagged the entire pursuit trace as saccades.
  // Correct clinical threshold: ~100°/s × 37 px/deg = 3700 px/s.
  const SPEM_SACCADE_THR_PX = 3700;
  const spemTestSequence = [
    { id: 'Horizontal_0.4Hz', type: 'horizontal', freq: 0.4 },
    { id: 'Lissajous_0.2Hz',  type: 'lissajous',  freq: 0.2 },
    { id: 'Lissajous_0.4Hz',  type: 'lissajous',  freq: 0.4 },
  ];
  let spemDataLog = [], spemCurrentTaskIndex = 0, spemIsTrackingActive = false, spemIsTrial = true;
  let spemTaskStartTime = 0, spemAnimFrameId, spemCurTargetX = 0, spemCurTargetY = 0;
  let spemGlobalCSVContent = '';

  // SchizoEye state
  // NOTE: szN normative values now in DEGREES (converted from pixels for clinical display)
  // rms: 35px ≈ 0.95° at 37px/deg; ratio: dimensionless; err: 0.25 (25%); lat: 300ms
  const szN = { rms: 0.95, ratio: 1.8, err: 0.25, lat: 300 };  // rms in °, lat in ms
  let szFixT = [], szAntiT = [], szCsv = [], szTaskStartTime = 0;

  // SPEM adapter
  let _spemGazeHandler = null, _spemPollTimer = null;
  const SpemAdapter = {
    waitForReady(cb) { _spemPollTimer = setInterval(() => { if (EyeTracker.isCalibrated()) { clearInterval(_spemPollTimer); cb(); } }, 300); },
    subscribe(fn) { _spemGazeHandler = (d) => { if (!d.isBlink) fn({ x: d.x, y: d.y }); }; EyeTracker.onGaze(_spemGazeHandler); },
    unsubscribe() { if (_spemGazeHandler) { EyeTracker.offGaze(_spemGazeHandler); _spemGazeHandler = null; } },
    getCalError() { const e = EyeTracker.getCalibrationError(); return e ? e.toFixed(1) + ' px' : '—'; }
  };

  // FIX BC-MATH-11 / SAMPLING-RATE UNIFICATION: SzTracker used to be
  // PULL-based — `getGaze()` was called once per animation-frame tick
  // inside the trial render loop, gated by display paint rate, then
  // deduplicated against the previous pulled value. SpemAdapter, right
  // above, was already PUSH-based (`EyeTracker.onGaze(fn)` — fired once
  // per genuinely new frame the tracker actually processed). Mixing pull-
  // at-paint-rate with push-at-processing-rate is the root cause of SZ
  // and SPEM ever showing different achieved sample rates within the same
  // recording session on the same camera: SZ's true rate was bounded by
  // whichever was slower, paint rate or tracker rate, while SPEM's was
  // bounded only by the tracker. SzTracker now uses the identical push
  // pattern as SpemAdapter, so both — and, once gaze-collector.js is
  // patched the same way, free-viewing too — are bounded only by the same
  // real ceiling: how fast EyeTracker (eye-tracker.js) can actually
  // process camera frames, which the file's own docs put at ~33-50 FPS on
  // typical consumer hardware and which we saw hit ~60 Hz on a faster
  // machine. There is no dedup step here because a push-based onGaze
  // listener already fires only on genuinely new gaze estimates.
  let _szGazeHandler = null;
  const SzTracker = {
    isCalibrated() { return EyeTracker.isCalibrated(); },
    subscribe(fn) {
      this.unsubscribe();
      _szGazeHandler = (d) => { if (!d.isBlink) fn({ x: d.x, y: d.y }); };
      EyeTracker.onGaze(_szGazeHandler);
    },
    unsubscribe() {
      if (_szGazeHandler) { EyeTracker.offGaze(_szGazeHandler); _szGazeHandler = null; }
    },
  };

  const $ = id => document.getElementById(id);
  const frame = () => new Promise(r => requestAnimationFrame(r));
  // Cross-browser safe wait using setTimeout (reliable across all browsers)
  const wait = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
  // Timed frame loop: uses performance.now() consistently (not rAF timestamps
  // which use a different origin in Firefox/Safari and can cause immediate exit).
  // Falls back to setTimeout when tab is backgrounded (rAF throttled in hidden tabs).
  const timedLoop = (durationMs, cb) => new Promise(resolve => {
    const start = performance.now();
    const end   = start + durationMs;
    function tick() {
      const now = performance.now();
      if (now >= end) { resolve(); return; }
      try { cb(now); } catch(e) { console.warn('[timedLoop] cb error:', e); }
      if (document.hidden) {
        // Tab hidden: rAF is throttled — use setTimeout to keep the loop alive
        const remaining = end - performance.now();
        if (remaining > 0) setTimeout(tick, Math.min(16, remaining));
        else resolve();
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });
  const d2p = d => d * pxPerDeg;
  const mean = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0;
  const rms  = pts => pts.length ? Math.sqrt(pts.reduce((s,p)=>s+p.dx*p.dx+p.dy*p.dy,0)/pts.length) : 0;
  const sd   = a => { const m=mean(a); return Math.sqrt(mean(a.map(v=>(v-m)**2))); };
  const cls  = (v,t1,t2) => v < t1 ? 'ok' : v < t2 ? 'warn' : 'alert';

  // ── Start Battery ──────────────────────────────────────────────────────────
  function start() {
    if (typeof window.TestDiag === 'function') window.TestDiag('BatteryController.start begin');
    if (typeof window._stopAlignStream === 'function') {
      window._stopAlignStream();
      window._stopAlignStream = null;
    }
    if (typeof EyeTracker !== 'undefined' && typeof EyeTracker.stop === 'function') {
      EyeTracker.stop();
    }
    subjectId = $('global-subject-id').value.trim() || 'Subject_01';
    patientName = $('global-patient-name').value.trim();
    patientAge = $('global-patient-age').value.trim();
    patientSex = $('global-patient-sex').value.trim();
    panssScore = $('global-panss-score').value.trim() || '';
    //changed--added formulae to find px per degree(ppd)
    const diagInput = $('global-screen-diagonal');
    screenDiagonalInches = diagInput ? parseFloat(diagInput.value) || 15.6 : 15.6;

// Compute pixels per degree of visual angle.
// Formula: pxPerDeg = screenDiagonalPx / screenDiagonalDeg
// screenDiagonalPx  = sqrt(screenW^2 + screenH^2)
// screenDiagonalIn  = user-supplied value (inches)
// pxPerIn           = screenDiagonalPx / screenDiagonalInches
// 1 deg of vis angle at 60cm = 2 * 60cm * tan(0.5°) ≈ 1.0472 cm ≈ 0.412 inches
// pxPerDeg = pxPerIn * 0.412
const screenDiagPx = Math.hypot(window.innerWidth, window.innerHeight);
const pxPerInch    = screenDiagPx / screenDiagonalInches;
const inchesPerDeg = 2 * 60 * Math.tan(0.5 * Math.PI / 180) / 2.54;  // ~0.412 in/deg at 60 cm
pxPerDeg = pxPerInch * inchesPerDeg;
console.log(`[Calibration] pxPerDeg = ${pxPerDeg.toFixed(2)}  (diagonal: ${screenDiagonalInches}″, ${screenDiagPx.toFixed(0)}px)`);
    // Automatically trigger Fullscreen mode for the whole test
    if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(err => {
          if (typeof window.TestDiag === 'function') window.TestDiag('Fullscreen request rejected, continuing in windowed mode', err);
          console.warn('[TestDiag] Fullscreen request rejected, continuing in windowed mode:', err);
        });
    }

    $('battery-intro').classList.add('protocol-started');
    $('battery-intro').style.display = 'none';

    // Begin Camera Check
    $('camera-check-screen').style.display = 'flex';
    $('camera-check-screen').classList.remove('hidden');
    if (typeof window.TestDiag === 'function') window.TestDiag('camera-check-screen visible; requesting preview camera');

    // FIX BC-7 (CRITICAL): eye-tracker.js v9.0 does NOT use WebGazer — it creates its
    // own hidden <video> element appended to <body>. The old code looked for
    // '#webgazerVideoFeed' which never exists, so the cam-stage was always empty
    // and MediaPipe face-alignment detection never ran on real video.
    //
    // Fix: open a separate mirrored camera stream for the alignment preview ONLY.
    // EyeTracker will open its own independent stream later (getUserMedia allows
    // multiple simultaneous consumers of the same camera on modern browsers).
    (async () => {
      try {
        const previewConstraints = [
          { video: { width:{ideal:640}, height:{ideal:480}, facingMode:'user' } },
          { video: { facingMode:'user' } },
          { video: true },
        ];
        let alignStream = null;
        let lastCameraError = null;
        for (const constraints of previewConstraints) {
          try {
            alignStream = await navigator.mediaDevices.getUserMedia(constraints);
            break;
          } catch (error) {
            lastCameraError = error;
          }
        }
        if (!alignStream) throw lastCameraError || new Error('Unable to open camera');
        if (typeof window.TestDiag === 'function') window.TestDiag('preview getUserMedia succeeded', { tracks: alignStream.getTracks().map(track => ({ kind: track.kind, state: track.readyState })) });
        const alignVid = document.createElement('video');
        alignVid.setAttribute('autoplay','');
        alignVid.setAttribute('playsinline','');
        alignVid.muted = true;
        alignVid.srcObject = alignStream;
        alignVid.style.cssText = 'position:absolute;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);';
        document.getElementById('cam-stage').appendChild(alignVid);
        await new Promise(res => alignVid.addEventListener('loadeddata', res, {once:true}));
        // Hide the "initialising…" overlay
        const startScreen = document.getElementById('cam-start-screen');
        if (startScreen) startScreen.style.display = 'none';
        // Now initialise MediaPipe face detection against this real video
        if (typeof window._initFaceAlignment === 'function') {
          window._initFaceAlignment();
        }
        const proceedBtn = document.getElementById('cam-proceed-btn');
        if (proceedBtn) {
          proceedBtn.textContent = 'Lighting Good — Proceed to Calibration';
          proceedBtn.onclick = startVideoCal;
        }
        // Stop the alignment stream once the user proceeds to calibration
        window._stopAlignStream = () => {
          alignStream.getTracks().forEach(t => t.stop());
          alignVid.remove();
        };
      } catch(e) {
        if (typeof window.TestDiag === 'function') window.TestDiag('preview getUserMedia failed', { name: e.name, message: e.message });
        console.warn('[BatteryController] Alignment camera stream failed:', e);
        if (typeof window.reportClientError === 'function') {
          window.reportClientError('camera permission/preview', e, 'navigator.mediaDevices.getUserMedia failed');
        }
        // Do not proceed without a live stream: EyeTracker would request the
        // same unavailable camera again and produce a less useful error.
        const proceedBtn = document.getElementById('cam-proceed-btn');
        const tipsEl = document.getElementById('cam-tips');
        const statusText = document.getElementById('cam-status-text');
        const statusBanner = document.getElementById('cam-status-banner');
        if (proceedBtn) {
          proceedBtn.disabled = false;
          proceedBtn.textContent = 'Retry Camera';
          proceedBtn.onclick = start;
        }
        const sourceBusy = e.name === 'NotReadableError';
        if (tipsEl) tipsEl.innerHTML = sourceBusy
          ? '<strong>Camera is busy or unavailable.</strong> Close Camera, Teams, Zoom, or other browser tabs using the webcam, then retry.'
          : '<strong>Camera preview unavailable.</strong> Check browser permission, then retry.';
        if (statusText) statusText.textContent = sourceBusy
          ? 'Camera is busy — close other camera apps and retry'
          : 'Camera unavailable — check permission and retry';
        if (statusBanner) statusBanner.className = 'warning';
        const startScreen = document.getElementById('cam-start-screen');
        if (startScreen) startScreen.style.display = 'none';
      }
    })();
  }

  async function startVideoCal() {
    try {
      if (typeof window.TestDiag === 'function') window.TestDiag('startVideoCal: stopping preview');
      // Preserve the authorized preview stream for EyeTracker. Reopening the
      // same camera immediately can fail with NotReadableError on Windows.
      if (typeof window._stopCameraPreview === 'function') {
        await window._stopCameraPreview({ preserveStream: false });
      }
      $('camera-check-screen').style.display = 'none';
      if (typeof window._stopAlignStream === 'function') {
        window._stopAlignStream = null;
      }
      $('video-cal-screen').style.display = 'flex';
      if (typeof window.TestDiag === 'function') window.TestDiag('video-cal-screen visible');
    } catch (err) {
      if (typeof window.reportClientError === 'function') window.reportClientError('camera preview teardown', err);
      $('camera-check-screen').style.display = 'flex';
    }
  }

  async function startClickCal() {
    if (typeof window.TestDiag === 'function') window.TestDiag('startClickCal begin');
    $('battery-intro').classList.add('protocol-started');
    $('video-cal-screen').style.display = 'none';
    ['battery-container', 'calibration-screen', 'cal-screen', 'cal-dot'].forEach(id => {
      const element = $(id);
      if (element) {
        element.classList.remove('hidden');
        if (id === 'cal-screen') element.style.display = 'flex';
        if (id === 'cal-dot') element.style.display = 'none';
      }
    });
    ['camera-check-screen', 'video-cal-screen'].forEach(id => {
      const element = $(id);
      if (element) element.classList.remove('active', 'visible');
    });
    if (typeof window.TestDiag === 'function') window.TestDiag('calibration surfaces reset', {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      calScreen: $('cal-screen') ? { width: $('cal-screen').offsetWidth, height: $('cal-screen').offsetHeight } : null
    });

    // Request fullscreen while this handler still has the user's gesture.
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        if (typeof window.TestDiag === 'function') window.TestDiag('Fullscreen request rejected during calibration', err);
        console.warn('[TestDiag] Fullscreen request rejected, continuing in windowed mode:', err);
      });
    }

    // The camera-check FaceDetection runtime must be fully closed before
    // FaceMesh/TF starts, otherwise both MediaPipe WASM modules collide.
    try {
      if (typeof window._stopCameraPreview === 'function') {
        await window._stopCameraPreview({ preserveStream: false });
      }
      if (typeof window.TestDiag === 'function') window.TestDiag('preview teardown complete; starting EyeTracker');
      if (typeof window._startEyeTrackerNow === 'function') {
        await window._startEyeTrackerNow();
        if (typeof window.TestDiag === 'function') window.TestDiag('window._startEyeTrackerNow completed');
      }

      // Always use the alignment-aware path so users complete alignment before the grid starts.
      if (typeof EyeTracker !== 'undefined' && typeof EyeTracker.recalibrate === 'function') {
        await EyeTracker.recalibrate();
        if (typeof window.TestDiag === 'function') window.TestDiag('calibration setup visible; waiting for calibration start');
      } else if (typeof EyeTracker !== 'undefined' && typeof EyeTracker.startDirectCalibration === 'function') {
        await EyeTracker.startDirectCalibration();
      }
    } catch (err) {
      if (typeof window.TestDiag === 'function') window.TestDiag('EyeTracker startup/calibration failed', err);
      console.error('[BatteryController] Camera handoff failed:', err);
      if (typeof window.reportClientError === 'function') window.reportClientError('EyeTracker startup/calibration', err, `API base: ${API_BASE}`);
      $('video-cal-screen').style.display = 'flex';
      const message = $('video-cal-screen').querySelector('h1');
      if (message) message.textContent = 'Camera setup failed: ' + err.message;
    }
  }

  function onCalibrationComplete() {
    showTaskTransition(0);
  }

  // ── Task Transition ────────────────────────────────────────────────────────
  function showTaskTransition(taskIdx) {
    currentTask = taskIdx;
    const tt = $('task-transition');
    const label = $('tx-label');
    const title = $('tx-title');
    const instrBox = $('tx-instructions');
    const beginBtn = $('tx-begin-btn');
    const imgStatus = $('image-status');

    tt.style.display = 'flex';

    if (taskIdx === 0) {
      // TASK 1: SPEM
      label.textContent = 'Task 1 of 3'; title.textContent = 'SPEM Protocol';
      imgStatus.style.display = 'none';
      instrBox.innerHTML = `
        <div class="instruction-item"><div class="instruction-number">1</div><div class="instruction-text"><strong>Follow the target point</strong> with your eyes only — keep your head still.</div></div>
        <div class="instruction-item"><div class="instruction-number">2</div><div class="instruction-text">A short <strong class="highlight">practice trial</strong> will begin first.</div></div>
        <div class="instruction-item"><div class="instruction-number">3</div><div class="instruction-text">Three <strong class="highlight">20-second</strong> tracking sequences: horizontal and Lissajous patterns.</div></div>
        <div class="instruction-item"><div class="instruction-number">4</div><div class="instruction-text">Brief rest periods between sequences.</div></div>
        <div class="instruction-note"><span>⏱ Duration:</span> ~100 seconds total</div>
      `;
      beginBtn.disabled = false; beginBtn.textContent = 'Begin SPEM Task';
      
    } else if (taskIdx === 1) {
      // TASK 2: SchizoEye
      label.textContent = 'Task 2 of 3'; title.textContent = 'SchizoEye Assessment';
      imgStatus.style.display = 'none';
      instrBox.innerHTML = `
        <div class="instruction-item"><div class="instruction-number">1</div><div class="instruction-text"><strong>Phase I — Fixation:</strong> A black dot will appear at centre. Stare at it. Some trials show other dots — ignore them.</div></div>
        <div class="instruction-item"><div class="instruction-number">2</div><div class="instruction-text"><strong>Phase II — Antisaccade:</strong> A black dot will flash to one side. Look immediately to the <strong class="warning">OPPOSITE</strong> side.</div></div>
        <div class="instruction-note"><span>⏱ Duration:</span> ~4 minutes · 6 fixation + 10 antisaccade trials</div>
      `;
      beginBtn.disabled = false; beginBtn.textContent = 'Begin SchizoEye Task';
      
    } else if (taskIdx === 2) {
      // TASK 3: Free Viewing
      label.textContent = 'Task 3 of 3'; title.textContent = 'Free Viewing';
      instrBox.innerHTML = `
        <div class="instruction-item"><div class="instruction-number">1</div><div class="instruction-text"><strong>View each image naturally</strong> — Look at whatever catches your attention. There are no right or wrong ways to view the images.</div></div>
        <div class="instruction-item"><div class="instruction-number">2</div><div class="instruction-text">Each image will be displayed for <strong class="highlight">8 seconds</strong>. A cross will appear briefly before each image.</div></div>
        <div class="instruction-item"><div class="instruction-number">3</div><div class="instruction-text"><strong>Keep your head still</strong> throughout the experiment.</div></div>
        <div class="instruction-item"><div class="instruction-number">4</div><div class="instruction-text"><strong class="warning">Do not look away</strong> from the screen during the experiment.</div></div>
        <div class="instruction-item"><div class="instruction-number">5</div><div class="instruction-text">The experiment will display <strong class="highlight">25 images</strong> in total.</div></div>
        <div class="instruction-note"><span>⏱ Duration:</span> ~6-7 minutes · <span>📁 Images:</span> From stimuli/ folder</div>
      `;
      imgStatus.style.display = 'block'; imgStatus.textContent = 'Loading images...';
      beginBtn.disabled = true; beginBtn.textContent = 'Begin Free Viewing';
      loadFVImages();
    }

    beginBtn.onclick = () => {
      tt.style.display = 'none';
      if (taskIdx === 0) startSPEM();
      else if (taskIdx === 1) startSZ();
      else if (taskIdx === 2) startFreeViewing();
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TASK 1: SPEM WITH PRE-TRIAL
  // ══════════════════════════════════════════════════════════════════════════
  function startSPEM() {
    spemDataLog = []; 
    spemCurrentTaskIndex = 0; 
    spemIsTrial = true; // Initialize with Practice Trial
    
    $('spem-test-canvas').style.display = 'block';
    $('spem-persistent-text').style.display = 'none';

    const ot = $('spem-overlay-text');
    ot.innerHTML = '⚠️ PRACTICE TRIAL';
    ot.style.fontSize = '4.5rem';
    ot.style.display = 'block';
    
    setTimeout(() => {
      ot.style.display = 'none';
      spemRunCountdown(3);
    }, 2000);
  }

  function spemRunCountdown(n) {
    const ot = $('spem-overlay-text');
    ot.style.display = 'block';
    if (n > 0) { ot.textContent = `Starting in ${n}`; setTimeout(() => spemRunCountdown(n-1), 1000); }
    else { ot.style.display = 'none'; spemPrepareTask(); }
  }

  function spemPrepareTask() {
    if (!spemIsTrial && spemCurrentTaskIndex >= spemTestSequence.length) { finishSPEM(); return; }

    const task = spemIsTrial ? { id: 'Trial_Horizontal', type: 'horizontal', freq: 0.4 } : spemTestSequence[spemCurrentTaskIndex];
    const target = $('spem-target'), ot = $('spem-overlay-text');
    
    $('spem-task-bar-fill').style.width = '0%';
    $('spem-phase-label').textContent = spemIsTrial ? 'TRIAL PHASE' : task.id.replace(/_/g, ' ');
    
    const cX = window.innerWidth/2, cY = window.innerHeight/2;
    target.style.transform = `translate(${cX-10}px, ${cY-10}px)`; 
    target.style.display = 'block';
    spemCurTargetX = cX; spemCurTargetY = cY;

    if (spemIsTrial) {
      $('spem-persistent-text').style.display = 'none';
      ot.textContent = 'Track the target'; 
      ot.style.fontSize = '3.5rem'; 
      ot.style.display = 'block';
    } else {
      $('spem-persistent-text').style.display = 'block';
      ot.style.display = 'none';
    }

    setTimeout(() => {
      if (spemIsTrial) ot.style.display = 'none';
      spemStartMovingTask();
    }, SPEM_FIXATION_DELAY_MS);
  }

  function spemStartMovingTask() {
    spemIsTrackingActive = true; 
    spemTaskStartTime = performance.now();
    const task = spemIsTrial ? { id: 'Trial_Horizontal', type: 'horizontal', freq: 0.4 } : spemTestSequence[spemCurrentTaskIndex];
    const target = $('spem-target');
    const cX = window.innerWidth/2, cY = window.innerHeight/2;
    const ampX = cX-80, ampY = cY-80;
    const dur = spemIsTrial ? 10 : SPEM_TASK_DURATION_MS/1000;

    SpemAdapter.subscribe(({x,y}) => {
      if (!spemIsTrackingActive) return;
      // Do not log data for the practice trial
      if (!spemIsTrial) {
        spemDataLog.push({ time:(performance.now()-spemTaskStartTime)/1000, phase:task.id, targetX:spemCurTargetX, targetY:spemCurTargetY, eyeX:x, eyeY:y });
      }
    });

    function animate() {
      const elapsed = (performance.now()-spemTaskStartTime)/1000;
      if (elapsed < dur) {
        let x=cX, y=cY;
        if (task.type==='horizontal') x = cX + ampX*Math.sin(2*Math.PI*task.freq*elapsed);
        else { x = cX + ampX*Math.sin(2*Math.PI*task.freq*elapsed); y = cY + ampY*Math.sin(2*Math.PI*(task.freq*2)*elapsed); }
        target.style.transform = `translate(${x-10}px, ${y-10}px)`; spemCurTargetX=x; spemCurTargetY=y;
        $('spem-task-bar-fill').style.width = ((elapsed/dur)*100)+'%';
        spemAnimFrameId = requestAnimationFrame(animate);
      } else spemEndMovingTask();
    }
    animate();
  }

  function spemEndMovingTask() {
    spemIsTrackingActive = false; 
    cancelAnimationFrame(spemAnimFrameId);
    SpemAdapter.unsubscribe(); 
    $('spem-target').style.display = 'none';
    $('spem-task-bar-fill').style.width = '100%';

    const ot = $('spem-overlay-text');
    $('spem-persistent-text').style.display = 'none'; // Ensure it's hidden during transitions/resting

    if (spemIsTrial) {
      spemIsTrial = false;
      ot.textContent = 'Practice complete. Preparing clinical assessment.';
      ot.style.fontSize = '3.0rem';
      ot.style.display = 'block';
      setTimeout(() => {
        ot.style.display = 'none';
        spemRunCountdown(3);
      }, 3000);
    } else {
      spemCurrentTaskIndex++;
      if (spemCurrentTaskIndex < spemTestSequence.length) {
        ot.textContent = 'Rest Phase'; ot.style.fontSize = '3.5rem'; ot.style.display = 'block';
        setTimeout(() => { ot.style.display = 'none'; spemPrepareTask(); }, SPEM_REST_DELAY_MS);
      } else {
        finishSPEM();
      }
    }
  }

  function finishSPEM() {
    const ot = $('spem-overlay-text'); ot.textContent = 'Generating report…'; ot.style.fontSize = '2.5rem'; ot.style.display = 'block';
    const csvLines = ['Timestamp,TaskPhase,TargetX,TargetY,EyeX,EyeY'];
    spemDataLog.forEach(r => csvLines.push(`${r.time.toFixed(3)},${r.phase},${r.targetX.toFixed(1)},${r.targetY.toFixed(1)},${r.eyeX.toFixed(1)},${r.eyeY.toFixed(1)}`));
    spemGlobalCSVContent = csvLines.join('\n');
    setTimeout(() => {
      ot.style.display = 'none'; $('spem-test-canvas').style.display = 'none';
      showTaskTransition(1); // Routes to SchizoEye
    }, 900);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TASK 2: SCHIZOEYE
  // ══════════════════════════════════════════════════════════════════════════
  async function startSZ() {
    szFixT = []; szAntiT = []; szCsv = [];
    const cv = $('sz-stage'); cv.width = innerWidth; cv.height = innerHeight;
    cv.style.display = 'block';
    const cx = cv.getContext('2d');
    const W = cv.width, H = cv.height;

    await szInstr('Phase I — Fixation Stability', 'A red dot will appear at centre.\nStare at it — do not look away.\n\nSome trials show other dots — ignore them.\n\n6 trials · 5 seconds each');
    szTaskStartTime = performance.now();

    for (const cond of ['none','none','single','single','multi','multi']) {
      const trial = { cond, pts: [] }; const ds = [];
      if (cond==='single') { const a=Math.random()*Math.PI*2, r=d2p(10); ds.push({x:W/2+Math.cos(a)*r, y:H/2+Math.sin(a)*r}); }
      else if (cond==='multi') { for (let i=0;i<4;i++) { const a=(i/4)*Math.PI*2, r=d2p(8+Math.random()*5); ds.push({x:W/2+Math.cos(a)*r, y:H/2+Math.sin(a)*r, ph:i*(Math.PI/2)}); } }
      const t0 = performance.now();
      // FIX BC-MATH-11: gaze sampling is now a push subscription, decoupled
      // from the render loop below — see SzTracker definition above.
      SzTracker.subscribe(({x,y}) => {
        trial.pts.push({dx:x-W/2, dy:y-H/2});
        const ts=(performance.now()-szTaskStartTime).toFixed(2);
        szCsv.push(`${ts},FIX_${cond.toUpperCase()},${x.toFixed(1)},${y.toFixed(1)},${(W/2).toFixed(1)},${(H/2).toFixed(1)}`);
      });
      await timedLoop(5000, (now) => {
        const e = now - t0; cx.clearRect(0,0,W,H);
        // Dark background fill
        cx.fillStyle = '#0a0a0f'; cx.fillRect(0,0,W,H);
        if (cond==='single') ds.forEach(d => szDot(cx, d.x, d.y, 20, '#ffffff')); // white distractor
        else if (cond==='multi') ds.forEach(d => { if (Math.sin(e/210+d.ph)>0) szDot(cx, d.x, d.y, 10, '#ffffff'); });
        // Bright red center fixation dot
        szDot(cx, W/2, H/2, 9, '#ff2244');
        // Red glow
        cx.save();
        cx.shadowColor = '#ff2244'; cx.shadowBlur = 16;
        szDot(cx, W/2, H/2, 9, '#ff2244');
        cx.restore();
      });
      SzTracker.unsubscribe();
      szFixT.push(trial);
    }

    await szInstr('Phase II — Antisaccade', 'A red dot will flash to one side.\nLook immediately to the OPPOSITE side.\n\nReact fast — accuracy matters more than speed.\n\n10 trials');

    for (let i=0;i<10;i++) {
      const ecc=[4,8,12][Math.floor(Math.random()*3)], side=Math.random()>.5?1:-1;
      const tx=d2p(ecc)*side; const trial={side,ecc,pts:[]};
      cx.clearRect(0,0,W,H); cx.fillStyle='#0a0a0f'; cx.fillRect(0,0,W,H);
      // Show a small dim fixation cross during inter-trial interval
      cx.save();
      cx.strokeStyle='rgba(255,255,255,0.15)'; cx.lineWidth=2;
      cx.beginPath(); cx.moveTo(W/2-12,H/2); cx.lineTo(W/2+12,H/2); cx.stroke();
      cx.beginPath(); cx.moveTo(W/2,H/2-12); cx.lineTo(W/2,H/2+12); cx.stroke();
      cx.restore();
      await wait(800+Math.random()*600);
      const antiT0 = performance.now();
      // FIX BC-MATH-11: push subscription, same as the fixation phase above.
      SzTracker.subscribe(({x,y}) => {
        trial.pts.push({normX:(x-W/2)*side/Math.max(Math.abs(tx),1), t:performance.now()-antiT0});
        const ts=(performance.now()-szTaskStartTime).toFixed(2);
        szCsv.push(`${ts},ANTISACCADE,${x.toFixed(1)},${y.toFixed(1)},${(W/2+tx).toFixed(1)},${(H/2).toFixed(1)}`);
      });
      await timedLoop(1200, () => {
        cx.clearRect(0,0,W,H);
        // Dark background
        cx.fillStyle='#0a0a0f'; cx.fillRect(0,0,W,H);
        // Bright red flash dot with glow
        cx.save();
        cx.shadowColor = '#ff2244'; cx.shadowBlur = 20;
        szDot(cx, W/2+tx, H/2, Math.round(pxPerDeg * 0.25), '#ff2244'); // 0.5° diameter → 0.25° radius
        cx.restore();
      });
      SzTracker.unsubscribe();
      szAntiT.push(trial);
    }

    cv.style.display = 'none';
    showTaskTransition(2); // Routes to Free Viewing
  }
  

  function szDot(cx, x, y, r, c) { cx.fillStyle=c; cx.beginPath(); cx.arc(x,y,r,0,Math.PI*2); cx.fill(); }

  function szInstr(title, body) {
    return new Promise(res => {
      $('sz-stage').style.display = 'none';
      $('sz-instr-title').innerText = title;
      $('sz-instr-body').innerText = body;
      $('sz-instr-overlay').style.display = 'flex';
      $('sz-instr-btn').onclick = () => {
        $('sz-instr-overlay').style.display = 'none';
        $('sz-stage').style.display = 'block';
        res();
      };
    });
  }
  

  // ══════════════════════════════════════════════════════════════════════════
  // TASK 3: FREE VIEWING
  // ══════════════════════════════════════════════════════════════════════════
  function loadFVImages() {
    fvImages = []; fvImageLoadErrors = []; let loadedCount = 0;
    for (let i = 1; i <= FV_NUM_IMAGES; i++) {
      const img = new Image(); const imgSrc = `${FV_IMAGE_FOLDER}${i}.jpg`;
      img.onload = () => { loadedCount++; fvImages[i-1] = { src: imgSrc, name: `${i}.jpg`, loaded: true }; updateFVLoadStatus(loadedCount); };
      img.onerror = () => { loadedCount++; fvImages[i-1] = { src: imgSrc, name: `${i}.jpg`, loaded: false }; fvImageLoadErrors.push(i); updateFVLoadStatus(loadedCount); };
      img.src = imgSrc;
    }
  }
  

  // ── Global Scope Variables for Report Generation ──
  let _lastFeatures = {};
  let _lastDataQuality = {}; // FIX BC-MATH-10: which features (if any) fell back to a no-data placeholder
  let _lastResult = null;
  let _lastPrediction = null;
  let _lastFvRaw = []; // NEW

  async function getPlotlyImage(divId) {
    try {
        const el = document.getElementById(divId);
        if (!el) return "";
        return await Plotly.toImage(divId, {format: 'png', width: 900, height: 350});
    } catch(e) { 
        return ""; 
    }
  }

  async function downloadPDFReport() {
    const btn = document.getElementById('btn-dl-pdf');
    const oldText = btn.textContent;
    btn.textContent = '⏳ Generating PDF...';
    btn.disabled = true;

    try {
        // Collect canvas elements
        const fixPureCanvas = document.getElementById('cFP');
        const fixDistCanvas = document.getElementById('cFD');
        const hs4Img = await getPlotlyImage('spem-graph-Horizontal_0.4Hz');
        const ls2Img = await getPlotlyImage('spem-graph-Lissajous_0.2Hz');
        const ls4Img = await getPlotlyImage('spem-graph-Lissajous_0.4Hz');

        // Create Payload mimicking PDF structure
        const payload = {
            patient: {
              id: subjectId,
              name: patientName || subjectId,
              age_sex: [patientAge, patientSex].filter(Boolean).join(' / ') || 'Unknown',
              date: new Date().toLocaleDateString('en-GB', {day:'2-digit', month:'short', year:'numeric'})
            },
            panss_score: (function(){
              const rPanss = document.getElementById('results-panss-score');
              const val = rPanss ? rPanss.value.trim() : '';
              return val ? parseFloat(val) : (panssScore ? parseFloat(panssScore) : null);
            })(),
            metrics: _lastFeatures,
            images: {
                heatmap: "",
                spem_hs4: hs4Img,
                spem_ls2: ls2Img,
                spem_ls4: ls4Img,
                fix_pure: fixPureCanvas ? fixPureCanvas.toDataURL('image/png') : "",
                fix_dist: fixDistCanvas ? fixDistCanvas.toDataURL('image/png') : ""
            },
            fv_gaze: _lastFvRaw
        };

        const response = await fetch(`${API_BASE}/generate-report`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', ...apiHeaders()},
          credentials: 'include',
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error('PDF Generation Failed');

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Oculomotor_Report_${subjectId}.pdf`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();
    } catch (e) {
        alert("Failed to generate PDF report: " + e.message);
    } finally {
        btn.textContent = oldText;
        btn.disabled = false;
    }
  }

  function updateFVLoadStatus(loadedCount) {
    const successCount = fvImages.filter(img => img && img.loaded).length;
    const imgStatus = $('image-status');
    const beginBtn  = $('tx-begin-btn');
    if (loadedCount === FV_NUM_IMAGES) {
      if (fvImageLoadErrors.length > 0) {
        imgStatus.innerHTML = `<span style="color:var(--accent2);">⚠ Missing ${fvImageLoadErrors.length} image(s): ${fvImageLoadErrors.slice(0,5).join(', ')}${fvImageLoadErrors.length>5?'...':''}</span><br><span style="color:var(--dim);">Found ${successCount} images</span>`;
      } else {
        imgStatus.innerHTML = `<span style="color:var(--accent);">✓ All ${FV_NUM_IMAGES} images loaded — Ready</span>`;
      }
      beginBtn.disabled = successCount < 10;
      if (successCount < FV_NUM_IMAGES && successCount >= 10) imgStatus.innerHTML += `<br><span style="color:var(--accent2);">Proceeding with ${successCount} images</span>`;
    } else {
      imgStatus.textContent = `Loading images... ${loadedCount} / ${FV_NUM_IMAGES}`;
    }
  }

  function startFreeViewing() {
    if (typeof window.TestDiag === 'function') window.TestDiag('Task 3 Free Viewing started');
    $('fv-experiment-screen').style.display = 'flex';
    $('gaze-cursor').style.display = 'none';
    fvCurrentImageIndex = 0;
    RawGazeCollector.reset();
    showNextFVImage();
  }

  function showNextFVImage() {
    if (fvCurrentImageIndex >= FV_NUM_IMAGES) { finishFreeViewing(); return; }

    const crosshair = $('crosshair'), stimulusImage = $('stimulus-image');
    const expProgress = $('exp-progress'), expTimer = $('exp-timer');
    crosshair.style.display = 'block'; stimulusImage.style.display = 'none';
    expProgress.style.display = 'none';
    expTimer.style.display = 'none';
    const successCount = fvImages.filter(img => img && img.loaded).length;
    expProgress.textContent = `Image ${fvCurrentImageIndex + 1} / ${successCount}`;
    expTimer.textContent = '—';

    fvExperimentTimeout = setTimeout(() => {
      crosshair.style.display = 'none'; stimulusImage.style.display = 'block';
      expProgress.style.display = 'block';
      expTimer.style.display = 'block';
      const image = fvImages[fvCurrentImageIndex];
      if (image && image.loaded) {
        stimulusImage.style.background = '';
        stimulusImage.src = image.src;
      } else {
        stimulusImage.removeAttribute('src');
        stimulusImage.style.background = 'radial-gradient(circle, #ff2244 0 10px, transparent 11px)';
        if (typeof window.TestDiag === 'function') window.TestDiag('Free Viewing image missing; using fallback target', { index: fvCurrentImageIndex + 1 });
      }
      RawGazeCollector.startRecording();
      let timeLeft = FV_IMAGE_DISPLAY_DURATION / 1000;
      expTimer.textContent = timeLeft.toFixed(1) + 's';
      fvTimerInterval = setInterval(() => {
        timeLeft -= 0.1; if (timeLeft <= 0) { clearInterval(fvTimerInterval); expTimer.textContent = '0.0s'; } else expTimer.textContent = timeLeft.toFixed(1) + 's';
      }, 100);
      fvExperimentTimeout = setTimeout(() => {
        clearInterval(fvTimerInterval); RawGazeCollector.stopRecording();
        RawGazeCollector.saveImageData((image && image.name) || `${fvCurrentImageIndex + 1}.jpg`);
        fvCurrentImageIndex++; showNextFVImage();
      }, FV_IMAGE_DISPLAY_DURATION);
    }, FV_CROSSHAIR_DURATION);
  }

  function finishFreeViewing() {
    $('fv-experiment-screen').style.display = 'none';
    showAllResults(); // Finishes the battery
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UNIFIED RESULTS
  // ══════════════════════════════════════════════════════════════════════════
  function showAllResults() {
    $('results-screen').style.display = 'block';
    document.body.style.overflow = 'auto';
    const patientInfo = [patientName, patientAge ? `Age: ${patientAge}` : '', patientSex].filter(Boolean).join(' · ');
    $('results-meta').textContent = `Subject: ${subjectId}${patientInfo ? '  ·  ' + patientInfo : ''}  ·  ${new Date().toLocaleString()}  ·  Calibration Error: ${EyeTracker.getCalibrationError().toFixed(1)} px`;

    renderFVResults();
    renderSPEMResults();
    renderSZResults();

    document.getElementById('ai-result-section').style.display = 'block';
    setTimeout(runAIClassification, 300);
  }

  function renderFVResults() {
    const allImageData = RawGazeCollector.getAllImageData();
    const totalSamples = allImageData.reduce((sum,img) => sum + img.sampleCount, 0);
    const tbody = $('fv-results-body');
    tbody.innerHTML = allImageData.map(img => `<tr><td>${img.imageName}</td><td>${img.sampleCount}</td></tr>`).join('');
    tbody.innerHTML += `<tr style="border-top:3px solid var(--accent);"><td style="color:var(--accent); font-weight:bold;">TOTAL</td><td style="color:var(--accent); font-weight:bold;">${totalSamples}</td></tr>`;
  }

  function renderSPEMResults() {
    const now = new Date();
    const ts = now.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) + '  ·  ' + now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    $('spem-report-meta').textContent = `Subject: ${subjectId}  ·  ${ts}`;
    const container = $('spem-graphs-container'); container.innerHTML = '';

    // NEW DARK THEME COLOR SCHEME
    const P = { 
      paper:'#1a1a2e', plot:'#1a1a2e', grid:'#2a2b3d', zero:'#44465e', 
      tick:'#8a8d9e', label:'#ffffff', title:'#ffffff', 
      red:'#ff3366', blue:'#33ccff', redDim:'rgba(255, 51, 102, 0.4)', 
      orange:'#ffaa00', amber:'#777777' 
    };

    spemTestSequence.forEach((task, idx) => {
      const taskData = spemDataLog.filter(d => d.phase === task.id);
      if (taskData.length < 10) return;
      const time = taskData.map(d=>d.time), targetX = taskData.map(d=>d.targetX), rawEyeX = taskData.map(d=>d.eyeX);
      const bias = rawEyeX.reduce((s,v,i)=>s+(v-targetX[i]),0)/rawEyeX.length;
      const eyeX = rawEyeX.map(v=>v-bias);

      function smoothData(data, w) { return data.map((_,i) => { const s=Math.max(0,i-Math.floor(w/2)), e=Math.min(data.length,i+Math.floor(w/2)+1); let sum=0; for(let j=s;j<e;j++) sum+=data[j]; return sum/(e-s); }); }
      const smEyeX = smoothData(eyeX, 7);
      const saccadeT=[], saccadeX=[], timeVel=[], eyeVel=[], targetVel=[], validGains=[];
      const ampX = (Math.max(...targetX)-Math.min(...targetX))/2, omega=2*Math.PI*task.freq;
      for (let i=1;i<smEyeX.length-1;i++) {
        const dt=time[i+1]-time[i-1]; if(dt<=0) continue;
        const vEye=Math.abs((smEyeX[i+1]-smEyeX[i-1])/dt);
        const vTarget=Math.abs(ampX*omega*Math.cos(omega*time[i]));
        timeVel.push(time[i]); eyeVel.push(vEye); targetVel.push(vTarget);
        if(vEye>SPEM_SACCADE_THR_PX) { if(!saccadeT.length||time[i]-saccadeT[saccadeT.length-1]>0.1) { saccadeT.push(time[i]); saccadeX.push(smEyeX[i]); } }
        else if(vTarget>50) validGains.push(Math.min(vEye/vTarget,1.5));
      }
      const avgGain = validGains.length ? validGains.reduce((a,b)=>a+b,0)/validGains.length : 0;
      const saccadeHz = (saccadeT.length/(SPEM_TASK_DURATION_MS/1000)).toFixed(2);
      if (idx>0) { const sep=document.createElement('div'); sep.className='spem-divider'; container.appendChild(sep); }
      const divId=`spem-graph-${task.id}`, graphEl=document.createElement('div');
      graphEl.id=divId; graphEl.className='spem-graph-container'; container.appendChild(graphEl);
      Plotly.newPlot(divId, [
        {x:time,y:targetX,mode:'lines',name:'Target Pos',line:{color:P.red,width:2.5},xaxis:'x',yaxis:'y'},
        {x:time,y:smEyeX,mode:'lines',name:'Eye Pos',line:{color:P.blue,width:2.5},xaxis:'x',yaxis:'y'},
        {x:saccadeT,y:saccadeX,mode:'markers',name:'Saccade',marker:{color:P.orange,size:10,symbol:'circle'},xaxis:'x',yaxis:'y'},
        {x:timeVel,y:targetVel,mode:'lines',name:'Target Vel',line:{color:P.redDim,width:1.8,dash:'dash'},xaxis:'x',yaxis:'y2'},
        {x:timeVel,y:eyeVel,mode:'lines',name:'Eye Vel',line:{color:P.blue,width:2},xaxis:'x',yaxis:'y2'},
        {x:[timeVel[0],timeVel[timeVel.length-1]],y:[SPEM_SACCADE_THR_PX,SPEM_SACCADE_THR_PX],mode:'lines',name:'Threshold',line:{color:P.amber,width:1.2,dash:'dot'},xaxis:'x',yaxis:'y2'},
      ], {
        title:{text:`<b>${task.id.replace(/_/g,' ')}</b>  |  Avg Velocity Gain: ${avgGain.toFixed(2)}  |  Saccades: ${saccadeHz} Hz`,font:{color:P.title,size:14},x:0.5,xanchor:'center'},
        paper_bgcolor:P.paper, plot_bgcolor:P.plot, font:{color:P.label,size:11},
        grid:{rows:2,columns:1,pattern:'independent',ygap:0.12},
        xaxis:{title:{text:'Time (s)'},gridcolor:P.grid,zerolinecolor:P.zero,linecolor:P.grid,tickfont:{color:P.tick},showgrid:true},
        yaxis:{title:{text:'Position (px)'},gridcolor:P.grid,zerolinecolor:P.zero,linecolor:P.grid,tickfont:{color:P.tick},domain:[0.55,1],showgrid:true},
        yaxis2:{title:{text:'Velocity (px/s) - screen coords'},gridcolor:P.grid,zerolinecolor:P.zero,linecolor:P.grid,tickfont:{color:P.tick},domain:[0,0.45],showgrid:true},
        legend:{orientation:'v',x:1.01,xanchor:'left',y:1,bgcolor:'rgba(0,0,0,0)',font:{color:P.label,size:10}},
        margin:{t:60,b:50,l:70,r:130},autosize:true,
      }, {responsive:true, displayModeBar:true});
    });
  }

  function renderSZResults() {
    $('sz-rmeta').textContent = `Subject: ${subjectId}   ·   ${new Date().toLocaleString()}`;
    const f = szFix(), a = szAnti();
    szSummary(f, a); szFixMetrics(f);
    
    // Update legend colors to match the dark theme and actual plot colors
    $('cFP').parentElement.querySelector('.key').innerHTML = `
      <span class="ki"><span class="kd" style="background:rgba(51, 204, 255, 0.6); border-color:#33ccff"></span>Gaze Points</span>
      <span class="ki"><span class="kd" style="background:#ff3366; border-color:#ff3366"></span>Target</span>`;
    $('cFD').parentElement.querySelector('.key').innerHTML = `
      <span class="ki"><span class="kd" style="background:rgba(51, 204, 255, 0.6); border-color:#33ccff"></span>Gaze Points</span>
      <span class="ki"><span class="kd" style="background:#555; border-color:#555"></span>Distractor</span>`;
      
    szScatter('cFP', szFixT.filter(t=>t.cond==='none').flatMap(t=>t.pts));
    szScatter('cFD', szFixT.filter(t=>t.cond!=='none').flatMap(t=>t.pts));
    szAntiMetrics(a); szWaterfall(a); szFlags(f, a);
  }

  function szScatter(id, pts) {
    const el=$(id); const dpr=devicePixelRatio||1; const W=el.offsetWidth, H=200;
    el.width=W*dpr; el.height=H*dpr; const ctx=el.getContext('2d'); ctx.scale(dpr,dpr);
    ctx.fillStyle='#1a1a2e'; ctx.fillRect(0,0,W,H); // Dark background
    const cx=W/2, cy=H/2;

    // Scale: map the full half-screen range (window.innerWidth/2, window.innerHeight/2) to
    // the canvas half-size so gaze points at the screen edge map to the canvas edge.
    // pts store dx/dy as pixel offsets from screen centre, so we normalise by screen half-dims.
    const screenHW = window.innerWidth  / 2 || 960;
    const screenHH = window.innerHeight / 2 || 540;
    const sc = Math.min((cx - 8) / screenHW, (cy - 8) / screenHH);

    // Reference rings at 10°, 25°, 40° of gaze eccentricity (in pixels at current pxPerDeg)
    [[pxPerDeg*10,'rgba(255,255,255,.2)',1.5,'10°'],[pxPerDeg*25,'rgba(255,255,255,.1)',1,''],[pxPerDeg*40,'rgba(255,255,255,.05)',1,'']].forEach(([r,col,lw,lbl]) => {
      ctx.beginPath(); ctx.arc(cx,cy,r*sc,0,Math.PI*2); ctx.strokeStyle=col; ctx.lineWidth=lw; ctx.stroke();
      if(lbl) { ctx.fillStyle='rgba(255,255,255,.5)'; ctx.font='10px Share Tech Mono'; ctx.textAlign='left'; ctx.fillText(lbl,cx+r*sc+3,cy-3); }
    });

    ctx.strokeStyle='rgba(255,255,255,.1)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(cx,4); ctx.lineTo(cx,H-4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(4,cy); ctx.lineTo(W-4,cy); ctx.stroke();

    // Light Blue Gaze points
    pts.forEach(p => {
      const px = cx + p.dx * sc, py = cy + p.dy * sc;
      ctx.beginPath(); ctx.arc(Math.max(2,Math.min(W-2,px)),Math.max(2,Math.min(H-2,py)),1.8,0,Math.PI*2);
      ctx.fillStyle='rgba(51, 204, 255, 0.6)'; ctx.fill();
    });

    // Bright Red Target at centre
    ctx.beginPath(); ctx.arc(cx,cy,5,0,Math.PI*2); ctx.fillStyle='#ff3366'; ctx.fill();
    ctx.fillStyle='rgba(255,255,255,.7)'; ctx.font='10px Share Tech Mono'; ctx.textAlign='left'; ctx.fillText(`${pts.length} samples`,6,H-6);
  }

  function szWaterfall(a) {
    const el=$('cA'); const dpr=devicePixelRatio||1; const W=el.offsetWidth, H=240;
    el.width=W*dpr; el.height=H*dpr; const ctx=el.getContext('2d'); ctx.scale(dpr,dpr);
    ctx.fillStyle='#1a1a2e'; ctx.fillRect(0,0,W,H); // Dark background
    const pL=40,pR=12,pT=8,pB=24,pW=W-pL-pR,pH=H-pT-pB,rH=pH/Math.max(a.cl.length,1);
    
    // Updated bright colors for lines
    const cm={correct:'#44ffaa',corrected:'#ffb347',uncorrected:'#ff3366',none:'#555'};
    
    [0,300,600,900,1200].forEach(ms => {
      const x=pL+ms/1200*pW; ctx.strokeStyle='rgba(255,255,255,.1)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(x,pT); ctx.lineTo(x,pT+pH); ctx.stroke();
      ctx.fillStyle='rgba(255,255,255,.7)'; ctx.font='10px Share Tech Mono'; ctx.textAlign='center'; ctx.fillText(ms+'ms',x,H-8);
    });
    ctx.strokeStyle='rgba(255,255,255,.3)'; ctx.lineWidth=1.5; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(pL+600/1200*pW,pT); ctx.lineTo(pL+600/1200*pW,pT+pH); ctx.stroke(); ctx.setLineDash([]);
    
    a.cl.forEach((t,ti) => {
      if(!t.pts||!t.pts.length) return;
      const mY=pT+ti*rH+rH/2, col=cm[t.type]||'#888';
      ctx.fillStyle=col; ctx.font='10px Share Tech Mono'; ctx.textAlign='right'; ctx.fillText(`T${ti+1}`,pL-3,mY+3);
      ctx.beginPath(); t.pts.forEach((p,i) => { const x=pL+Math.min(p.t/1200,1)*pW, y=mY-p.normX*rH*.45; i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
      ctx.strokeStyle=col; ctx.lineWidth=1.5; ctx.stroke();
    });
  }

  function szFix() {
    const pure=szFixT.filter(t=>t.cond==='none').flatMap(t=>t.pts);
    const dist=szFixT.filter(t=>t.cond!=='none').flatMap(t=>t.pts);
    const rP=rms(pure), rD=rms(dist), ratio=rP>0?rD/rP:1;
    return {pure, dist, rP, rD, ratio};
  }

  function szAnti() {
    let errs=0, corr=0; const lats=[];
    const cl=szAntiT.map(t => {
      if (!t.pts.length) return {...t, type:'none'};
      const isErr=t.pts.filter(p=>p.t<500).some(p=>p.normX>0.4);
      const isCor=isErr && t.pts.filter(p=>p.t>200).some(p=>p.normX<-0.4);
      if (isErr) errs++; if (isCor) corr++;
      // Latency = time of first sample that crosses the CORRECT side threshold (normX < -0.3).
      // Using the first crossing (not two consecutive) avoids ~100–200ms over-estimation.
      const firstCorrect = t.pts.find(p => p.normX < -0.3);
      if (firstCorrect) lats.push(firstCorrect.t);
      return {...t, type:!isErr?'correct':isCor?'corrected':'uncorrected'};
    });
    return {errs, corr, unc:errs-corr, rate:szAntiT.length?errs/szAntiT.length:0, lat:mean(lats), lats, cl};
  }

  function szMc(lbl,val,norm,unit,c) {
    const pct=Math.min(100,parseFloat(val)/parseFloat(norm)*100), fc=c==='ok'?'var(--accent)':'var(--dim)';
    return `<div class="mc"><div class="ml">${lbl}</div><div class="mv ${c}">${val}${unit}</div><div class="mn">norm &lt; ${norm}${unit}</div><div class="mb"><div class="mf" style="width:${pct}%;background:${fc}"></div></div></div>`;
  }

  function szSummary(f,a) {
    // Convert gaze spread to degrees for summary display
    const rPDeg = f.rP / pxPerDeg;
    const items = [
      ['Fixation Stability',rPDeg<szN.rms?'Normal':rPDeg<szN.rms*2?'Mildly Elevated':'Elevated',cls(rPDeg,szN.rms,szN.rms*2)],
      ['Distractibility',f.ratio<szN.ratio?'Normal':f.ratio<szN.ratio*1.5?'Elevated':'High',cls(f.ratio,szN.ratio,szN.ratio*1.5)],
      ['Antisaccade Errors',a.rate<szN.err?'Normal':a.rate<0.4?'Elevated':'High',cls(a.rate,szN.err,0.4)],
      ['Response Latency',a.lat<szN.lat?'Normal':a.lat<450?'Slow':'Very Slow',cls(a.lat,szN.lat,450)]
    ];
    $('sz-sbar').innerHTML = items.map(([l,v,c]) => `<div class="sc"><div class="sc-icon">${c==='ok'?'✓':'⚠'}</div><div><div class="sc-lbl">${l}</div><div class="sc-val ${c}">${v}</div></div></div>`).join('');
  }

  function szFixMetrics(f) {
    // Convert pixel RMS values to degrees using pxPerDeg factor
    const rPDeg = f.rP / pxPerDeg;
    const rDDeg = f.rD / pxPerDeg;
    
    $('sz-fmet').innerHTML = 
      szMc('Gaze Spread — Pure',rPDeg.toFixed(2),szN.rms,'°',cls(rPDeg,szN.rms,szN.rms*2)) + 
      szMc('Gaze Spread — Distractor',rDDeg.toFixed(2),szN.rms*2,'°',cls(rDDeg,szN.rms,szN.rms*3)) + 
      szMc('Distractibility Ratio',f.ratio.toFixed(2),szN.ratio,'×',cls(f.ratio,szN.ratio,szN.ratio*1.5));
  }

  function szAntiMetrics(a) {
    // Error Rate    = errs / total trials
    // Self-Corrected = corr (subset of errors where the subject recovered to the correct side)
    // Uncorrected    = unc = errs - corr
    $('sz-amet').innerHTML =
      szMc('Error Rate',(a.rate*100).toFixed(0),25,'%',cls(a.rate,szN.err,0.4)) +
      szMc('Mean Latency (Correct)',a.lat>0?a.lat.toFixed(0):'—',szN.lat,'ms',cls(a.lat,szN.lat,450)) +
      szMc('Self-Corrected Errors',a.corr,2,'/10',cls(a.corr,2,4));
  }

  function szFlags(f, a) {
    const fgs=[]; const add=(lvl,main,sub)=>fgs.push({lvl,main,sub});
    
    // Convert to degrees for display
    const rPDeg = f.rP / pxPerDeg;
    const rDDeg = f.rD / pxPerDeg;
    
    if(rPDeg>szN.rms*2) add('alert','High fixation instability (pure)',`Gaze spread ${rPDeg.toFixed(2)}° vs norm <${szN.rms}°.`);
    else if(rPDeg>szN.rms) add('warn','Mild fixation instability',`Gaze spread ${rPDeg.toFixed(2)}° (norm <${szN.rms}°).`);
    if(f.ratio>szN.ratio*1.5) add('alert','Strongly elevated distractibility',`Ratio ${f.ratio.toFixed(2)}× (norm <${szN.ratio}×).`);
    else if(f.ratio>szN.ratio) add('warn','Elevated distractibility',`Ratio ${f.ratio.toFixed(2)}×.`);
    if(a.rate>0.4) add('alert','High antisaccade error rate',`${(a.rate*100).toFixed(0)}% error rate (norm <25%) — strong impairment in suppressing reflexive saccades.`);
    else if(a.rate>szN.err) add('warn','Elevated antisaccade errors',`${(a.rate*100).toFixed(0)}% error rate (norm <25%).`);
    if(a.unc>3) add('alert','Uncorrected antisaccade errors',`${a.unc} trials not self-corrected.`);
    if(a.lat>450) add('alert','Very prolonged response latency',`${a.lat.toFixed(0)}ms (norm <${szN.lat}ms).`);
    else if(a.lat>szN.lat) add('warn','Prolonged response latency',`${a.lat.toFixed(0)}ms (norm <${szN.lat}ms).`);
    const nAlert=fgs.filter(f=>f.lvl==='alert').length;
    const sc='var(--accent)';
    const sm=nAlert>=2?`${nAlert} elevated markers — profile consistent with significant frontal inhibitory dysfunction`:fgs.length?`${fgs.length} marker(s) mildly elevated`:'All markers within normative range';
    $('sz-flags').innerHTML = `<h3>Clinical Interpretation</h3><div class="fg"><div class="fi" style="color:${sc};">${nAlert>=2?'⚠':fgs.length?'△':'✓'}</div><div><div class="fm" style="color:${sc}">${sm}</div></div></div>` + fgs.map(f=>`<div class="fg"><div class="fi" style="color:var(--accent)">${f.lvl==='alert'?'⚠':'△'}</div><div><div class="fm" style="color:var(--accent)">${f.main}</div><div class="fs">${f.sub}</div></div></div>`).join('');
  }

  function downloadFVCSV() {
    const allImageData = RawGazeCollector.getAllImageData();
    let csv = 'image_index,image_name,x,y,timestamp_ms,velocity,is_blink,confidence,frame_number\n';
    allImageData.forEach(img => img.gazeData.forEach(point => { csv += `${img.imageIndex},${img.imageName},${point.x.toFixed(4)},${point.y.toFixed(4)},${point.timestamp.toFixed(2)},${point.velocity.toFixed(4)},${point.isBlink?1:0},${point.confidence.toFixed(4)},${point.frameNumber}\n`; }));
    dlBlob(csv, `fv_gaze_raw_${Date.now()}.csv`);
  }

  function downloadSPEMCSV() { dlBlob(spemGlobalCSVContent, `spem_${subjectId.replace(/[^a-z0-9]/gi,'_')}_${Date.now()}.csv`); }

  function downloadSZCSV() {
    const content = 'Timestamp_ms,Phase,Gaze_X,Gaze_Y,Target_X,Target_Y\n' + szCsv.join('\n');
    dlBlob(content, `sz_${subjectId}_${Date.now()}.csv`);
  }

  // Increased stagger time slightly to ensure browsers don't block multiple rapid downloads
  function downloadAllCSV() { 
    downloadFVCSV(); 
    setTimeout(downloadSPEMCSV, 600); 
    setTimeout(downloadSZCSV, 1200); 
  }

  function downloadSPEMPlots() {
    spemTestSequence.forEach(task => {
      const divId = `spem-graph-${task.id}`;
      if (document.getElementById(divId)) Plotly.downloadImage(divId, {format:'png',width:1400,height:700,filename:`${subjectId}_${task.id}`});
    });
  }

  function dlBlob(content, filename) {
    const blob = new Blob([content], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }


  // ════════════════════════════════════════════════════════════════
  // FEATURE EXTRACTOR — pure-JS port (clashing helpers prefixed _ft_)
  // ════════════════════════════════════════════════════════════════
  const FEATURE_ORDER = [
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
 
"HS4_Mean_H_RMSE":   { lower: 0.5,   upper: 12.0  },  // FIX BC-MATH-2: was 0.5-5.0 and saturating on real data (see audit — the one available reference session hit this exact ceiling on all 5 RMSE features); webcam gaze-estimation noise alone is commonly 1-3 deg RMS, so a 5 deg ceiling clips legitimate noisy trials rather than only broken ones
  // SPEM — spatial in DEGREES
  "HS4_SacAmp":        { lower: 0.3,  upper: 15.0   },  // (°)
  "HS4_SacPV":         { lower: 20.0, upper: 500.0  },  // (°/s)
  "HS4_SacAV":         { lower: 10.0, upper: 250.0  },  // (°/s)
  // LS2 — dimensionless / ms
  "LS2_Mean_H_logSNR": { lower: 0.2,  upper: 3.5   },
  "LS2_Mean_H_gain":   { lower: 0.4,  upper: 1.3   },
  "LS2_Mean_V_logSNR": { lower: 0.2,  upper: 3.5   },
  "LS2_Mean_V_gain":   { lower: 0.4,  upper: 1.3   },
  "LS2_FixNum":        { lower: 0.0,  upper: 80.0   },  // FIX BC-MATH-3: was 3.0 — inconsistent with HS4's 0.0 floor for the exact same kind of count; 0 fixations is a legitimate (if poor) outcome, not an impossible one
  "LS2_FixDur":        { lower: 80.0, upper: 1000.0 },
  "LS2_SacNum":        { lower: 0.0,  upper: 80.0   },  // FIX BC-MATH-3
  "LS2_SacDur":        { lower: 8.0,  upper: 60.0   },
"LS2_Mean_H_RMSE":   { lower: 0.5,   upper: 10.0  },  // FIX BC-MATH-2 (see HS4_Mean_H_RMSE)
 "LS2_Mean_V_RMSE":   { lower: 0.5,   upper: 10.0  },  // FIX BC-MATH-2
  // LS2 — spatial in DEGREES
  "LS2_SacAmp":        { lower: 0.3,  upper: 8.0    },
  "LS2_SacPV":         { lower: 20.0, upper: 300.0  },
  "LS2_SacAV":         { lower: 10.0, upper: 150.0  },
  // LS4 — dimensionless / ms
  "LS4_Mean_H_logSNR": { lower: 0.2,  upper: 3.5   },
  "LS4_Mean_H_gain":   { lower: 0.2,  upper: 1.5   },
  "LS4_Mean_V_logSNR": { lower: 0.2,  upper: 3.5   },
  "LS4_Mean_V_gain":   { lower: 0.2,  upper: 1.5   },
  "LS4_FixNum":        { lower: 0.0,  upper: 100.0  },  // FIX BC-MATH-3
  "LS4_FixDur":        { lower: 80.0, upper: 800.0  },
  "LS4_SacNum":        { lower: 0.0,  upper: 100.0  },  // FIX BC-MATH-3
  "LS4_SacDur":        { lower: 8.0,  upper: 80.0   },
 "LS4_Mean_H_RMSE":   { lower: 0.5,   upper: 12.0  },  // FIX BC-MATH-2
 "LS4_Mean_V_RMSE":   { lower: 0.5,   upper: 12.0  },  // FIX BC-MATH-2
  // LS4 — spatial in DEGREES
  "LS4_SacAmp":        { lower: 0.3,  upper: 10.0   },
  "LS4_SacPV":         { lower: 20.0, upper: 400.0  },
  "LS4_SacAV":         { lower: 10.0, upper: 150.0  },
  // Fixation stability — counts and durations
  "fix_fs_fn":  { lower: 0.0,  upper: 25.0    },
"fix_fs_fd":  { lower: 100.0, upper: 5000.0 },  // was 100-10000
  "fix_fs_sn":  { lower: 0.0,  upper: 25.0    },
  "fix_fs_spl": { lower: 0.0,  upper: 600.0   },  // cumulative scanpath (°)
  "fix_fs_sa":  { lower: 0.0,  upper: 6.0     },  // saccade amplitude (°)
  // Fixation distractor — counts and durations
  "fix_fd_fn":  { lower: 0.0,  upper: 30.0    },
"fix_fd_fd":  { lower: 100.0, upper: 5000.0 },  // was 100-10000
  "fix_fd_sn":  { lower: 0.0,  upper: 30.0    },
  "fix_fd_spl": { lower: 0.0,  upper: 500.0   },  // cumulative scanpath (°)
  "fix_fd_sa":  { lower: 0.0,  upper: 6.0     },  // saccade amplitude (°)
  // Antisaccade — rates (0–1) and latency (ms)
  "antisaccade_error_rate":            { lower: 0.0,   upper: 1.0   },
  "antisaccade_correction_error_rate": { lower: 0.0,   upper: 1.0   },
  "antisaccade_latency":               { lower: 100.0, upper: 900.0 },
  "antisaccade_accuracy":              { lower: 0.0,   upper: 1.0   },  // FIX BC-MATH-4: was capped at 0.99 — a participant who lands correctly on all 10 trials has 100% accuracy; the old cap silently rewrote a genuinely perfect score into "one trial short of perfect" (confirmed against the one real reference session: error_rate=0.30 with correction_error_rate=0% implies true accuracy=1.00, which the old bound clamped to 0.99)
};
//changed
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
  residualDispersionThresholdDeg: 1.0,   // was 2.5 — too loose, merge too many points
  ampDegPerUnit:       1.0,
  peakVelocityScale:   1.0 ,
  avgVelocityScale:    1.0 ,
},
'Lissajous_0.2Hz': {
  residualDispersionThresholdDeg: 0.8,   // was 1.5
  ampDegPerUnit:       1.0,
  peakVelocityScale:   1.0 ,
  avgVelocityScale:    1.0 ,
},
'Lissajous_0.4Hz': {
  residualDispersionThresholdDeg: 2.0,   // was 5.0 — way too loose
  ampDegPerUnit:       1.0,
  peakVelocityScale:   1.0 ,
  avgVelocityScale:    1.0 ,
},
    },
  },
  antisaccade: {
    trialGapMs:                 700,
    // FIX BC-MATH-5: was 15.0 deg/s. The antisaccade literature consistently
    // uses ~30 deg/s for onset detection (Gitelman 2002, widely cited; see
    // also ScienceDirect's Antisaccade overview using the same figure), with
    // some studies as low as 20 or as high as 40. 15 deg/s is below every
    // value we found in the literature and is exactly the range where
    // webcam positional jitter alone can cross threshold on a single frame.
    velocityThresholdDegPerSec: 30.0,
    // New: minimum sustained duration and net amplitude before a threshold
    // crossing counts as a real saccade, not a noise spike — analogous to
    // the same guards added to detectEventsEK() and standard in the
    // literature (e.g. minimum amplitude/velocity/latency criteria in
    // Karatekin & Asarnow-style antisaccade scoring; PLOS ONE 2011 used a
    // 1.5 deg minimum saccade length with a 40 deg/s threshold).
    minSaccadeDurationMs:        20,
    minSaccadeAmplitudeDeg:      1.0,
    // New: saccades detected faster than this are anticipatory/artifactual
    // and are excluded from the LATENCY estimate specifically (error/
    // direction classification still uses them) — standard practice, e.g.
    // PLOS ONE (2011): "SRTs shorter than 80 ms were considered anticipatory
    // and discarded."
    anticipatoryLatencyMs:       80,
    landingToleranceDeg:         5,
  },
  // Shared adaptive event-detection parameters (see detectEventsEK).
  // FIX BC-MATH-13: this needed two iterations to get right, and both are
  // worth recording so the next round of tuning doesn't repeat them.
  //   Attempt 1 was lambda=4 with minThresholdDegPerSec=15,
  //   maxThresholdDegPerSec=80 -- reasoning: real webcam noise is much
  //   higher than the infrared-tracker noise the original lambda=6 was
  //   calibrated against (Engbert & Kliegl 2003), so lower lambda + a
  //   ceiling should let genuine saccades through even on noisy sessions.
  //   Tested against a real post-fix session this reasoning was based on
  //   (HS4/LS2/LS4 SacNum 0-1 across three 20s trials, fv_fnum_mean
  //   pinned at its floor, fix_fs/fd_fd pinned at their ceiling -- i.e.
  //   near-total non-detection almost everywhere the adaptive detector
  //   runs). That attempt made detection WORSE, not better: simulating a
  //   realistic short (20-35ms) 1-2deg microsaccade at ~35Hz showed its
  //   own SMOOTHED (+/-2-sample) velocity typically lands only ~8-16
  //   deg/s -- BELOW the 15 deg/s floor -- so the floor itself was
  //   silently discarding genuine small saccades before the noise-based
  //   ceiling ever came into play. The ceiling of 80 was also too high to
  //   matter: fixing the real session's under-detection only needed the
  //   threshold capped somewhere well under the ~8-16 deg/s a genuine
  //   short saccade's smoothed velocity actually reaches, not 80.
  //   Attempt 2 (current values) was calibrated by simulating both small
  //   (1-2deg, fixation/microsaccade-scale) and large (4-6deg, SPEM
  //   catch-up-scale) saccades against synthetic noise swept from clean
  //   (0.05deg SD) to quite poor (1.5deg SD) tracking, and choosing the
  //   lambda/floor/ceiling combination that recovered close to the true
  //   injected count across that whole range without either
  //   under-detecting at realistic noise levels or exploding into false
  //   positives at high noise. lambda=3 (not 4 or 6), floor=3 (not 15),
  //   ceiling=25 (not 80) was the best-performing combination tested.
  // This is still simulated-noise calibration, not real-recording
  // calibration -- see VALIDATION notes; re-tune here in one place if
  // real sessions show it still needs adjustment either direction.
  eventDetection: {
    lambda: 3,
    minSaccadeDurationMs: 20,
    minSaccadeAmplitudeDeg: 0.3,
    minThresholdDegPerSec: 3,
    maxThresholdDegPerSec: 25,
  },
};
// FIX BC-MATH-6 (IMPORTANT): the app was placing stimuli at real visual
// angles during the session using the LIVE, per-session `pxPerDeg` (derived
// from the participant's actual screen-diagonal input — see the pxPerDeg
// calibration block near the top of this file), but every post-hoc feature
// extraction below was re-converting those same recorded pixel coordinates
// back to degrees using a hardcoded REFERENCE_PPD=37.0 regardless of the
// session's real value. For any session where the real screen differs from
// the "15.6-inch at 60cm" assumption baked into that 37, every degree-based
// feature (amplitudes, velocities, RMSE, dispersion, scanpath length) would
// be systematically scaled by (true_pxPerDeg / 37) — e.g. a larger monitor
// or different viewing distance would silently inflate or deflate reported
// degrees session-to-session, which is exactly the kind of hidden nuisance
// variable that can masquerade as a real HC/SZ signal in downstream ML.
//
// Extraction runs in the SAME page load immediately after recording (see
// runAIClassification below), so the correct, already-computed live
// `pxPerDeg` for this session is available and is now used by default.
// LEGACY_REFERENCE_PPD is kept only as an explicit fallback for offline
// re-analysis of historical CSVs that don't carry a recorded pxPerDeg.
const LEGACY_REFERENCE_PPD = 37.0;
function px2deg(px, ppd) { return px / (Number.isFinite(ppd) && ppd > 0 ? ppd : pxPerDeg); }


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

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const val = row[key];
    if (!map.has(val)) map.set(val, []);
    map.get(val).push(row);
  }
  return map;
}

function _ft_mean(arr) {
  if (!arr || arr.length === 0) return NaN;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

function _ft_median(arr) {
  if (!arr || arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return 0.5 * (sorted[mid - 1] + sorted[mid]);
}

function _ft_sum(arr) {
  if (!arr || arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s;
}

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

function _ft_unique(arr) {
  return [...new Set(arr)];
}

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

// ════════════════════════════════════════════════════════════════
// FIX BC-MATH-1: Adaptive velocity-threshold event detector.
// ────────────────────────────────────────────────────────────────
// Replaces the fixed dispersion-threshold (I-DT) detector above for all
// live extraction call sites. I-DT with a single fixed pixel/degree
// threshold is known to be brittle when noise level varies session to
// session (exactly what we found: this app's effective sampling rate
// and tracking noise both vary 2-3x between sessions/hardware) — see
// Nyström & Holmqvist (2010), Behav Res Methods 42:188-204, and
// Salvucci & Goldberg (2000) ETRA taxonomy.
//
// This detector instead follows Engbert & Kliegl (2003, Vision Research
// 43:1035-1045) and Engbert & Mergenthaler (2006, PNAS): eye velocity is
// smoothed with a short central-difference window, a per-session/per-
// phase NOISE-ADAPTIVE threshold is computed from the median-based SD of
// that velocity distribution (formula #2 in the original paper — robust
// to the very outliers/saccades it's trying to detect), and a sample is
// flagged as saccadic when it exceeds an elliptical 2D threshold
// (lambda x SD in each axis). On top of the core EK criterion we add the
// two extra guards that the low-rate/noisy-webcam literature consistently
// recommends (e.g. Nyström & Holmqvist 2010; standard practice reviewed
// in Hessels et al. 2018): a MINIMUM SUSTAINED DURATION (translated from
// ms into a sample-count using this segment's own median inter-sample
// interval, since our effective rate varies ~20-60 Hz across sessions)
// and a MINIMUM NET AMPLITUDE, so an isolated noisy sample can't be
// misclassified as a saccade. Candidate saccade runs failing either
// guard are folded back into the surrounding fixation.
//
// `detectXKey`/`detectYKey` is the signal used for velocity/threshold
// classification; `measureXKey`/`measureYKey` is the signal used to
// report fixation centres and saccade amplitude/velocity/path length.
// For plain fixation tasks these are the same (raw gaze position). For
// smooth pursuit we classify on the RESIDUAL (gaze - target) so that the
// expected pursuit motion itself is never mistaken for a saccade, while
// still reporting saccade kinematics from the raw eye trajectory — this
// mirrors standard pursuit analysis practice (e.g. the eye-velocity-
// relative-to-target criterion in Heinen & Watamaniuk-style pursuit-
// saccade studies) and is what the previous idtResidualFixations/
// buildTransitions pairing was already doing, just with a fixed
// dispersion threshold instead of an adaptive velocity one.
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

function ekMedianBasedSD(v) {
  const med = _ft_median(v);
  const sqDev = v.map((x) => (x - med) * (x - med));
  return Math.sqrt(Math.max(_ft_median(sqDev), 0));
}

function detectEventsEK(rows, detectXKey, detectYKey, measureXKey, measureYKey, tSecKey, tMsKey, opts) {
  const cfg = Object.assign(
    // FIX BC-MATH-13 (revised after testing against realistic simulated
    // noise -- see comment block below CONFIG.eventDetection for the full
    // story, including a first attempt at this fix that made things
    // WORSE and why): lambda lowered from the Engbert & Kliegl (2003)
    // infrared-tracker default of 6 to 3, with an absolute [min,max] band
    // on the resulting threshold itself.
    { lambda: 3, minDurationMs: 20, minAmplitude: 0.3,
      minThresholdDegPerSec: 3, maxThresholdDegPerSec: 25 },
    opts || {}
  );
  const sorted = [...rows].sort((a, b) => a[tSecKey] - b[tSecKey]);
  const n = sorted.length;
  if (n < 5) return { fixations: [], saccades: [], rows: sorted };

  const { vx, vy } = ekAxisVelocity(sorted, detectXKey, detectYKey, tSecKey);
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

  // Pass 1: find "fast" runs, and demote any that fail the sustained-
  // duration or minimum-amplitude criteria back to "fixation" — this is
  // what keeps single noisy frames from fragmenting fixations.
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

  // Pass 2: final runs on the corrected flags — adjacent fixation runs
  // that were only split by a now-rejected noise blip merge naturally.
  const finalRuns = runsOf(corrected);
  const fixations = [];
  const saccades = [];
  for (const run of finalRuns) {
    const durMs = sorted[run.end][tMsKey] - sorted[run.start][tMsKey];
    if (run.flag) {
      // FIX BC-MATH-14: peak velocity was computed from the SMOOTHED
      // (+/-2-sample central-difference) velocity of the DETECT channel
      // (the residual, for pursuit) -- for a short event, that smoothing
      // window pulls in slower neighbouring samples and can dilute the
      // peak below the plain path-length/duration AVERAGE velocity
      // computed just below from the raw MEASURE channel, which is
      // mathematically impossible for one continuous movement (confirmed
      // against a real session: HS4_SacPV=34.2 < HS4_SacAV=41.11 for a
      // single detected saccade). Peak and average now come from the
      // SAME per-segment raw (unsmoothed) measure-channel speeds, which
      // guarantees peak >= average by construction: average = total
      // distance / total duration is a duration-weighted mean of the
      // per-segment speeds, and a weighted mean can never exceed the
      // maximum of the values it's averaging.
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

//changed entire estimateScreenGeometry
function estimateScreenGeometry(fvRows, spRows, szRows) {
  // Screen dimensions in degrees
  const wDeg = px2deg(window.innerWidth);
  const hDeg = px2deg(window.innerHeight);
  return { width: wDeg, height: hDeg, diag: Math.hypot(wDeg, hDeg) };
}

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

// FIX BC-MATH-12: Hann-window the signal before the DFT in both of these.
// An un-windowed (rectangular-window) DFT on a short, non-integer-period
// segment leaks power from the true peak into neighbouring bins — a
// standard, well-known spectral-analysis issue (e.g. Harris 1978, "On the
// Use of Windows for Harmonic Analysis with the Discrete Fourier
// Transform") — which is exactly the failure mode that would bias both
// the signal estimate (amplitudeAtFrequency, used by computeGain) and the
// noise-floor estimate (periodogram, used by computeLogSNR) here, since
// our pursuit segments are ~20s of desaccaded, gappy, non-integer-cycle
// data rather than a clean integer number of stimulus periods.
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
  // Hann windowing attenuates in-band amplitude by a factor of ~0.5 (its
  // coherent gain) — rescale so the returned amplitude stays comparable
  // to the un-windowed estimate used previously.
  return (2.0 * Math.hypot(re, im)) / Math.max(n * 0.5, 1e-9);
}

function periodogram(values, sampleRate) {
  const centered = hannWindow(values.map((v) => v - _ft_mean(values)));
  const n = centered.length;
  const maxK = Math.floor(n / 2);
  const freqs = new Array(maxK + 1);
  const power = new Array(maxK + 1);
  // Hann window power (mean-square) gain correction, so absolute power
  // values stay on roughly the same scale as the previous un-windowed
  // version (the noise-vs-signal RATIO that logSNR actually uses is
  // unaffected either way, but keeping the scale stable avoids silently
  // breaking anyone relying on the raw power numbers elsewhere).
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

function computeGain(times, eyeValues, targetValues, frequencyHz, sampleRate) {
  const eye = resampleLinear(times, eyeValues, sampleRate);
  const target = resampleLinear(times, targetValues, sampleRate);
  if (!eye.values.length || !target.values.length) return NaN;
  const eyeAmp = amplitudeAtFrequency(eye.times, eye.values, frequencyHz);
  const targetAmp = amplitudeAtFrequency(target.times, target.values, frequencyHz);
  return eyeAmp / Math.max(targetAmp, 1e-9);
}

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

function extractFreeViewing(fvRows, screen) {
  const groups = groupBy(fvRows, "image_index");
  const perImage = [];
  for (const rows of groups.values()) {
    const clean = rows
      .filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.tMs))
      .sort((a, b) => a.tMs - b.tMs);
    if (clean.length < 8) continue;
      // FIX BC-MATH-1: adaptive velocity-threshold detector (see
      // detectEventsEK) instead of the fixed-dispersion I-DT approach —
      // saccades/fixations come straight out of one call, with kinematics
      // (amplitude, peak/avg velocity, path length) computed from the same
      // smoothed velocity used for classification rather than a separate
      // unsmoothed single-sample-difference speed estimate.
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
//changed
        perImage.push({
      fv_fnum_mean: fixations.length,
      fv_fdur_mean: _ft_mean(fixations.map((f) => f.durMs)),
      fv_snum_mean: transitions.length,
      fv_sdur_mean: _ft_mean(transitions.map((s) => s.durMs)),   // raw ms, no scale
      fv_samp_mean: _ft_mean(transitions.map((s) => s.ampPx / CONFIG.fv.ampDegPerUnit)),
      fv_spv_mean:  _ft_mean(transitions.map((s) => s.peakVelocityPxPerSec / CONFIG.fv.peakVelocityScale)),
      fv_sav_mean:  _ft_mean(transitions.map((s) => s.avgVelocityPxPerSec / CONFIG.fv.avgVelocityScale)),
      // The issue is pathPx is in DEGREES (since we pass degree arrays to buildTransitions)
// but scanpathScale = 1/37 makes it larger, not smaller
// REPLACE with:
fv_spl_mean:  _ft_sum(transitions.map((s) => s.pathPx)),  // already in degrees, just sum  // per-image total
      fv_disp_mean: disp,
    });
  }

  const out = {};
  for (const feature of FEATURE_ORDER.filter((name) => name.startsWith("fv_"))) {
    if(perImage.map((r) => r[feature]).filter(Number.isFinite).length===0){out[feature]=0; continue; }
    if (feature === 'fv_spl_mean') {
      // Sum scanpath totals across all images (training data = cumulative across session)
      out[feature] = _ft_sum(perImage.map((r) => r[feature]).filter(Number.isFinite));
    } else {
      out[feature] = _ft_mean(perImage.map((r) => r[feature]).filter(Number.isFinite));
    }
  }
  return out;
}

function parseBaseFrequency(phaseName) {
  const match = String(phaseName).match(/([0-9.]+)Hz/i);
  return match ? Number(match[1]) : NaN;
}

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
        //changed
          residualX: r.EyeXDeg - r.TargetXDeg,
          residualY: r.EyeYDeg - r.TargetYDeg,
      }))
      .sort((a, b) => a.tSec - b.tSec);

    if (!rows.length) continue;

    // FIX BC-MATH-1: classify on the RESIDUAL (gaze - target) signal with
    // the adaptive EK detector — a catch-up saccade is a brief high-
    // velocity excursion correcting pursuit error, so thresholding the
    // residual's velocity is the standard way to separate it from the
    // (fast but expected) pursuit motion itself. Kinematics are still
    // measured from the raw eye trajectory (EyeXDeg/EyeYDeg), matching
    // how the original idtResidualFixations + buildTransitions pairing
    // was already split, just with an adaptive threshold instead of a
    // fixed dispersion one.
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
    // FIX BC-MATH-7: fixation/saccade duration are now real, directly-
    // measured onset-to-offset durations from the detector — no more
    // 50/50 blend with phase-duration/count, and no more empirical
    // "x0.55" fudge factor on saccade duration. Both were compensating
    // for the coarse dispersion-based segmentation; the adaptive
    // velocity detector's run boundaries don't need that correction.
    const fixMeanDur = _ft_mean(fixations.map((f) => f.durMs));
    const meanSacDur = _ft_mean(transitions.map((s) => s.durMs));

    // FIX BC-MATH-8: desaccade before computing pursuit quality metrics.
    // Standard practice in the smooth-pursuit literature (e.g. "Metrics of
    // two-dimensional smooth pursuit", PMC11801394; "Two-Dimensional
    // Analysis of Smooth Pursuit...", PMC6753966) is to exclude saccadic
    // samples before estimating gain/RMSE/SNR, since a handful of large
    // catch-up-saccade excursions can dominate an RMSE or SNR estimate
    // computed over the raw signal and bias it independently of how good
    // the underlying pursuit actually is. We build a pursuit-only (eye,
    // target, time) series by dropping every sample inside a detected
    // saccade, then feed that into computeLogSNR / computeRmse /
    // computeGain instead of the raw arrays.
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
//changed
// NOTE: `dispersionThresholdDeg` is kept as a parameter for call-site
// compatibility but is no longer used — detection now runs through the
// shared adaptive detectEventsEK() (CONFIG.eventDetection) instead of a
// per-condition fixed dispersion threshold. See FIX BC-MATH-1.
function extractFixationCondition(szRows, phaseName, dispersionThresholdDeg, ampDegPerUnit, scanpathScale) {
  const phases = Array.isArray(phaseName) ? phaseName : [phaseName];
  const rows = szRows
    .filter((r) => phases.includes(r.Phase))
    .filter((r) => Number.isFinite(r.tMs) && Number.isFinite(r.Gaze_X) && Number.isFinite(r.Gaze_Y))
    .sort((a, b) => a.tMs - b.tMs);

  // FIX BC-MATH-1: adaptive velocity-threshold detector, see detectEventsEK.
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

function splitAntisaccadeTrials(szRows, gapMs) {
  const ant = szRows
    .filter((r) => r.Phase === "ANTISACCADE")
    .filter((r) => Number.isFinite(r.tMs) && Number.isFinite(r.Gaze_XDeg) && Number.isFinite(r.Target_XDeg))
    .sort((a, b) => a.tMs - b.tMs);

  if (!ant.length) return [];
  const trials = [];
  let start = 0;
  for (let i = 1; i < ant.length; i += 1) {
    //changed
        if ((ant[i].tMs - ant[i - 1].tMs) > gapMs) {
      trials.push(ant.slice(start, i));
      start = i;
    }
  }
  trials.push(ant.slice(start));
  return trials;
}

function estimateCenterX(szRows, screen) {
  const stableTargets = szRows
    .filter((r) => r.Phase !== "ANTISACCADE")
    .map((r) => r.Target_XDeg)
    .filter(Number.isFinite);
  if (stableTargets.length) return _ft_median(stableTargets);
  return screen.width / 2.0;
}

// FIX BC-MATH-9: robust saccade-onset detection for the antisaccade task.
// The previous version flagged a saccade the instant ANY single sample's
// raw single-difference velocity crossed 15 deg/s — well below every
// value we found in the antisaccade literature (Gitelman 2002's commonly-
// cited ~30 deg/s; PLOS ONE 2011 used 40 deg/s with a 1.5 deg amplitude
// floor; Journal of Cognition 2019 used 30 deg/s with 1 deg amplitude and
// a 100ms anticipatory cutoff) and with no duration or amplitude floor at
// all — exactly the conditions under which webcam positional jitter can
// masquerade as a saccade. This version: (1) smooths velocity the same
// way as detectEventsEK, (2) requires the threshold crossing to sustain
// for a minimum duration, (3) requires a minimum net amplitude, and
// (4) excludes anticipatory "responses" from the latency estimate
// specifically (error/direction classification still uses them, since a
// fast reflexive error is still a real error).
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

// In estimateCenterX — changed Target_X to Target_XDeg
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

    // Minimum sustained-duration criterion, translated from ms into a
    // sample count using this trial's own median inter-sample interval
    // (this session's effective rate varies session-to-session — see the
    // sampling-rate audit — so a fixed sample count would be wrong at a
    // different rate).
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

// FIX BC-MATH-10 (IMPORTANT): NaN can mean two very different things here,
// and the old code collapsed both into "use the lower bound":
//  (a) a genuine count of zero — e.g. zero saccades really did occur.
//      0 (bound.lower for the *Num features) IS the correct value.
//  (b) insufficient valid data to estimate a rate/duration/amplitude/
//      velocity/signal-quality metric — e.g. every antisaccade trial was
//      an initial error, so there is no valid "correct-response latency"
//      to average. Falling back to bound.lower here (100ms for
//      antisaccade_latency) silently turned "we couldn't measure this"
//      into "this participant responded unusually fast" — the opposite
//      of what happened, and exactly the kind of artifact that could
//      look like a spurious HC/SZ signal downstream (a clinically more
//      impaired participant, more likely to have all-error blocks, would
//      be more likely to get this floor value).
// For class (b) we now fall back to the bound MIDPOINT (a neutral
// "unknown", not an extreme) and flag the feature as low-confidence via
// the returned `lowConfidence` flag, surfaced separately as
// `dataQuality` (see runAIClassification) — NOT as one of the 59 feature
// columns, so the exported feature contract is unchanged.
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

function cloneRows(rows) {
  return rows.map((row) => ({ ...row }));
}

  // ── In-memory CSV builders ──
  function buildFvRows() {
    const allImageData = RawGazeCollector.getAllImageData();
    const rows = [];
    allImageData.forEach(img => img.gazeData.forEach(pt => {
      rows.push({ timestamp_ms:pt.timestamp, x:pt.x, y:pt.y,
        velocity:pt.velocity||0, image_index:img.imageIndex,
        is_blink:pt.isBlink?1:0, confidence:pt.confidence||0 });
    }));
    return rows;
  }

  function buildSpemRowsForExtractor() {
    return spemDataLog.map(r => ({
      Timestamp:r.time, TaskPhase:r.phase,
      TargetX:r.targetX, TargetY:r.targetY,
      EyeX:r.eyeX, EyeY:r.eyeY,
    }));
  }

  function buildSzRowsForExtractor() {
    return szCsv.map(line => {
      const p = line.split(',');
      return { Timestamp_ms:parseFloat(p[0]), Phase:p[1],
        Gaze_X:parseFloat(p[2]), Gaze_Y:parseFloat(p[3]),
        Target_X:parseFloat(p[4]), Target_Y:parseFloat(p[5]) };
    });
  }

  // ── Main AI pipeline ──
  // ── Main AI pipeline ──
  // ── Feature extraction and model inference ──
  async function runAIClassification() {
    const statusEl = document.getElementById('ai-status-text');
    let featuresReady = false;
    try {
      statusEl.textContent = '⏳ Step 1/2 — Parsing raw gaze data...';
      await new Promise(r => setTimeout(r, 60));

      const fvRaw = buildFvRows();
      _lastFvRaw = fvRaw;
      const spRaw = buildSpemRowsForExtractor();
      const szRaw = buildSzRowsForExtractor();

      if (fvRaw.length < 10 || spRaw.length < 10 || szRaw.length < 10) {
        const message = `Insufficient data - FV:${fvRaw.length} SPEM:${spRaw.length} SZ:${szRaw.length} rows.`;
        statusEl.textContent = `⚠ ${message} Complete all three tasks first.`;
        if (typeof window.reportClientError === 'function') window.reportClientError('feature extraction', new Error(message));
        return;
      }

      statusEl.textContent = '⏳ Step 2/2 — Extracting 59 oculomotor features...';
      await new Promise(r => setTimeout(r, 60));

      const fvRows2 = normalizeFv(fvRaw, pxPerDeg);
      const spRows2 = normalizeSpem(spRaw, pxPerDeg);
      const szRows2 = normalizeSz(szRaw, pxPerDeg);
      const screen  = estimateScreenGeometry(fvRows2, spRows2, szRows2);

      const fm = {};
      Object.assign(fm, extractFreeViewing(fvRows2, screen));
      Object.assign(fm, extractPursuit(spRows2));

      const fixS = extractFixationCondition(szRows2,
        CONFIG.fixationSingle.phase,
        CONFIG.fixationSingle.dispersionThresholdDeg,
        CONFIG.fixationSingle.ampDegPerUnit,
        CONFIG.fixationSingle.scanpathScale);
      fm.fix_fs_fn = fixS.fixNum;
      fm.fix_fs_fd = fixS.fixDur;
      fm.fix_fs_sn = fixS.sacNum;
      fm.fix_fs_sa = fixS.sacAmp;
      fm.fix_fs_spl = fixS.scanpath;

      const fixM = extractFixationCondition(szRows2,
        CONFIG.fixationDistractor.phase,
        CONFIG.fixationDistractor.dispersionThresholdDeg,
        CONFIG.fixationDistractor.ampDegPerUnit,
        CONFIG.fixationDistractor.scanpathScale);
      fm.fix_fd_fn = fixM.fixNum;
      fm.fix_fd_fd = fixM.fixDur;
      fm.fix_fd_sn = fixM.sacNum;
      fm.fix_fd_sa = fixM.sacAmp;
      fm.fix_fd_spl = fixM.scanpath;

      Object.assign(fm, extractAntisaccade(szRows2, screen));

      const finalFeatures = {};
      const dataQuality = {};
      for (const name of FEATURE_ORDER) {
        const r = finalizeFeature(name, fm[name]);
        finalFeatures[name] = r.value;
        if (r.lowConfidence) dataQuality[name] = 'insufficient_valid_data';
      }

      _lastFeatures = finalFeatures;
      _lastDataQuality = dataQuality;
      featuresReady = true;

      // Render the extracted features BEFORE inference. A model/API failure
      // must never hide the measurements that were successfully collected.
      renderFeaturesOnly(finalFeatures);

      // Classification is best-effort. Persistence is mandatory after feature
      // extraction. The backend also re-validates/inferences during saving.
      statusEl.textContent = '⏳ Sending the 59 features to the inference API...';
      try {
        const classifyResponse = await fetch(`${API_BASE}/classify`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', ...apiHeaders()},
          credentials: 'include',
          body: JSON.stringify({features: finalFeatures})
        });
        const classifyData = await classifyResponse.json().catch(() => ({}));
        if (!classifyResponse.ok || !classifyData.success) {
          throw new Error(classifyData.error || `Inference HTTP ${classifyResponse.status}`);
        }
        if (!classifyData.prediction) {
          // Tolerate a flatter response shape ({predicted_label, confidence, ...})
          // instead of assuming every backend revision nests it under `prediction`.
          classifyData.prediction = {
            label: classifyData.predicted_label,
            confidence: classifyData.confidence,
          };
        }
        _lastPrediction = classifyData.prediction;
        statusEl.textContent = `✓ Inference complete — ${classifyData.prediction.label}`;
        renderPrediction(classifyData.prediction, classifyData.class_probabilities);
      } catch (inferenceErr) {
        _lastPrediction = null;
        statusEl.textContent = `⚠ Inference unavailable — saving collected data anyway...`;
        console.warn('[BatteryController] Classification failed; continuing to save:', inferenceErr);
        if (typeof window.reportClientError === 'function') window.reportClientError('classification (non-blocking)', inferenceErr, `API: ${API_BASE}/classify`);
        renderPredictionUnavailable(inferenceErr.message);
      }

      // This is intentionally outside the inference try/catch: once features
      // exist, the session must be sent to /save_results regardless of model
      // availability. A 401/403 is still a genuine authorization failure.
      await saveSessionToDatabase();
    } catch(err) {
      statusEl.textContent = '✗ Error: ' + err.message;
      if (typeof window.reportClientError === 'function') window.reportClientError('feature extraction', err, `API base: ${API_BASE}`);
      console.error('Feature extraction error', err);
      // If feature extraction completed but a later non-model step failed,
      // make one final persistence attempt rather than silently losing data.
      if (featuresReady) {
        try { await saveSessionToDatabase(); } catch (_) {}
      }
    }
  }

  function renderFeaturesOnly(features) {
    const el = document.getElementById('ai-features-summary');
    el.innerHTML = '<div style="columns:3;column-gap:24px;">' +
      FEATURE_ORDER.map(n => `<div style="break-inside:avoid;padding:2px 0"><span style="color:var(--dim)">${n}</span> <span style="color:var(--accent); font-weight:bold; float:right;">${features[n]}</span></div>`).join('') +
      '</div>';
    document.getElementById('ai-results-body').style.display = 'block';
    // downloadPDFReport() only reads _lastFeatures/canvas snapshots — it never
    // touches _lastPrediction — so the button belongs here, not behind a
    // successful /classify call. That gating is exactly why it stayed hidden
    // whenever inference failed even though a report could still be built.
    const pdfBtn = document.getElementById('btn-dl-pdf');
    if (pdfBtn) pdfBtn.style.display = 'inline-block';
  }

  function _extractProbs(prediction, classProbabilities) {
    let healthy = null, schizo = null;
    if (prediction) {
      if (typeof prediction.healthy_probability === 'number') healthy = prediction.healthy_probability;
      if (typeof prediction.schizophrenia_probability === 'number') schizo = prediction.schizophrenia_probability;
    }
    if ((healthy === null || schizo === null) && classProbabilities) {
      for (const [label, p] of Object.entries(classProbabilities)) {
        const l = label.toLowerCase();
        if (healthy === null && l.startsWith('health')) healthy = p;
        if (schizo === null && l.includes('schiz')) schizo = p;
      }
    }
    return { healthy, schizo };
  }

  function renderPrediction(prediction, classProbabilities) {
    const el = document.getElementById('ai-prediction-summary');
    if (!el || !prediction) return;
    el.style.cssText = 'margin-bottom:20px;';   // clear the plain-text card styling baked into the HTML
    const { healthy, schizo } = _extractProbs(prediction, classProbabilities);
    const healthyPct = healthy != null ? healthy * 100 : null;
    const schizoPct  = schizo  != null ? schizo  * 100 : null;
    const confPct = ((prediction.confidence || 0) * 100).toFixed(1);
    const isSchizo = /schiz/i.test(prediction.label || '');
    const labelColor = isSchizo ? '#b91c1c' : '#166534';

    const bar = (label, pct, color) => `
      <div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--dim);margin-bottom:6px;">
          <span>${label}</span><span style="font-weight:700;color:${color};">${pct == null ? '—' : pct.toFixed(1) + '%'}</span>
        </div>
        <div style="height:10px;background:var(--off-white);border:1px solid var(--border);border-radius:5px;overflow:hidden;">
          <div style="height:100%;width:${pct == null ? 0 : pct}%;background:${color};transition:width .5s ease;"></div>
        </div>
      </div>`;

    el.innerHTML = `
      <div style="border:2px solid var(--border);border-radius:8px;padding:22px 24px;background:var(--white);">
        <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-bottom:12px;">Model Prediction</div>
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
          <div style="font-size:26px;font-weight:800;color:${labelColor};">${prediction.label}</div>
          <div style="font-size:13px;color:var(--dim);">${confPct}% confidence</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
          ${bar('Healthy', healthyPct, '#166534')}
          ${bar('Schizophrenia', schizoPct, '#b91c1c')}
        </div>
        <div style="margin-top:16px;font-size:11px;color:var(--dim);line-height:1.5;">
          Decision-support output from the deployed model — not a standalone clinical diagnosis.
        </div>
      </div>`;
  }

  function renderPredictionUnavailable(reason) {
    const el = document.getElementById('ai-prediction-summary');
    if (!el) return;
    el.style.cssText = 'margin-bottom:20px;';
    el.innerHTML = `
      <div style="border:2px dashed var(--border);border-radius:8px;padding:18px 20px;background:var(--off-white);color:var(--dim);font-size:13px;line-height:1.6;">
        <strong style="color:var(--accent);">Model prediction unavailable.</strong> ${reason ? reason : 'The inference service did not respond.'}
        The 59 extracted features below, and the session itself, were still saved.
      </div>`;
  }

  async function saveSessionToDatabase() {
    const statusEl = $('ai-status-text');
    try {
      statusEl.textContent = '💾 Capturing images and saving session...';
      
      // Collect doctor notes and PANSS score from results form
      const resultsPanssInput = $('results-panss-score');
      const resultsNotesInput = $('results-doctor-notes');
      const collectedPanss = resultsPanssInput ? resultsPanssInput.value.trim() : '';
      const collectedNotes = resultsNotesInput ? resultsNotesInput.value.trim() : '';
      const collectedAuthor = window._currentUser || 'unknown';

      // Capture SPEM task images
      let spem_hs4_img = '';
      let spem_ls2_img = '';
      let spem_ls4_img = '';
      try {
        spem_hs4_img = await getPlotlyImage('spem-graph-Horizontal_0.4Hz');
        spem_ls2_img = await getPlotlyImage('spem-graph-Lissajous_0.2Hz');
        spem_ls4_img = await getPlotlyImage('spem-graph-Lissajous_0.4Hz');
      } catch(e) { console.warn("Could not capture SPEM images:", e); }

      // Capture fixation task canvas images
      let fix_pure_img = '';
      let fix_dist_img = '';
      try {
        const fixPureCanvas = document.getElementById('cFP');
        const fixDistCanvas = document.getElementById('cFD');
        if (fixPureCanvas) fix_pure_img = fixPureCanvas.toDataURL('image/png');
        if (fixDistCanvas) fix_dist_img = fixDistCanvas.toDataURL('image/png');
      } catch(e) { console.warn("Could not capture fixation images:", e); }

      const response = await fetch(`${API_BASE}/save_results`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', ...apiHeaders()},
          credentials: 'include',
          body: JSON.stringify({
              subject_id: subjectId,
              patient_name: patientName || subjectId,
              patient_age: patientAge || 'N/A',
              patient_gender: patientSex || 'N/A',
              screen_size: `${screenDiagonalInches}"`,
            panss_score: collectedPanss ? parseFloat(collectedPanss) : null,  // ← null instead of 0,
              notes: collectedNotes,
              notes_author: collectedAuthor,
              calibration_error: EyeTracker.getCalibrationError(),
              // FIX BC-MATH-6/11: record what this session actually used/
              // achieved, instead of leaving it to be reverse-engineered
              // from raw timestamp gaps after the fact (which is how the
              // ~20/30/60 Hz session-to-session spread was originally
              // discovered — this makes it explicit going forward).
              px_per_deg_used: pxPerDeg,
              tracker_performance: (typeof EyeTracker.getPerformanceStats === 'function')
                ? EyeTracker.getPerformanceStats() : null,
              data_quality: _lastDataQuality,
              features: _lastFeatures,
              fv_gaze: _lastFvRaw,
              spem_gaze: buildSpemRowsForExtractor(),
              sz_gaze: buildSzRowsForExtractor(),
              image_spem_hs4: spem_hs4_img,
              image_spem_ls2: spem_ls2_img,
              image_spem_ls4: spem_ls4_img,
              image_fix_pure: fix_pure_img,
              image_fix_dist: fix_dist_img
          })
      });

      const result = await response.json().catch(() => ({}));
      if (response.ok && result.success) {
        _lastResult = result;
        _lastPrediction = result.prediction || _lastPrediction;
        let pdfBase64 = result.pdf_base64 || '';
        if (!pdfBase64 && result.report_url) {
          try {
            const pdfResponse = await fetch(`${API_BASE}${result.report_url}`, {
              headers: apiHeaders(),
              credentials: 'include'
            });
            if (pdfResponse.ok) {
              const pdfBlob = await pdfResponse.blob();
              pdfBase64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(pdfBlob);
              });
            }
          } catch (pdfError) {
            console.warn('[BatteryController] Could not fetch generated PDF:', pdfError);
          }
        }
        const completionPayload = {
          type: 'OCULOMOTOR_ASSESSMENT_COMPLETE',
          status: 'success',
          sessionId: result.session_id,
          subjectId: result.subject_id || subjectId,
          prediction: result.prediction,
          features: result.features,
          featureOrder: result.feature_order,
          reportUrl: `${API_BASE}${result.report_url}`,
          pdfBase64
        };
        if (window.parent !== window) window.parent.postMessage(completionPayload, '*');
        if (window.opener && window.opener !== window) window.opener.postMessage(completionPayload, '*');
        statusEl.textContent = '✓ Session saved to database successfully!';
        // Disable the save button after successful save
        const saveBtn = document.getElementById('btn-save-session');
        if (saveBtn) {
          saveBtn.disabled = true;
          saveBtn.textContent = '✓ Saved';
          saveBtn.style.opacity = '0.6';
        }
        const statusLabel = document.getElementById('save-status-label');
        if (statusLabel) { statusLabel.textContent = '✓ Saved'; statusLabel.style.color = '#1A7A4A'; }
        // Show return to dashboard
        const returnWrap = document.getElementById('return-to-dashboard-wrap');
        if (returnWrap) returnWrap.style.display = 'block';
      } else {
        const message = `HTTP ${response.status}: ${result.error || response.statusText || 'Save failed'}`;
        statusEl.textContent = `⚠ ${message}`;
        if (typeof window.reportClientError === 'function') window.reportClientError('save_results request', new Error(message), `API: ${API_BASE}/save_results`);
      }
    } catch(err) {
      statusEl.textContent = `⚠ Database save failed: ${err.message}`;
      if (typeof window.reportClientError === 'function') window.reportClientError('save_results request', err, `API: ${API_BASE}/save_results`);
      console.error('Save error:', err);
    }
  }

    return { start, startVideoCal, startClickCal, onCalibrationComplete, downloadFVCSV, downloadSPEMCSV, downloadSZCSV, downloadAllCSV, downloadSPEMPlots, downloadPDFReport, saveSessionToDatabase };
  })();
