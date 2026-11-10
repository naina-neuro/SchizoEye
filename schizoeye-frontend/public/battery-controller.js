/**
 * Coordinates the eye-tracking tasks, results, feature extraction, and exports.
 * Uses EyeTracker and RawGazeCollector for gaze data and the backend for reports and inference.
 */
import { EyeTracker } from './eye-tracker.js';
import { RawGazeCollector } from './assessment-tasks.js';
import { ApiService } from './api-service.js';
import { createReportManager, getPlotlyImage } from './report-manager.js';
import { FEATURE_ORDER, createFeatureExtractor } from './feature-extractor.js';

export const BatteryController = (() => {
  const API_BASE = ApiService.baseUrl;
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
  const FV_IMAGE_FOLDER = 'public/stimuli/';
  const FV_IMAGE_DISPLAY_DURATION = 8000;
  const FV_CROSSHAIR_DURATION = 1000;
  let fvCurrentImageIndex = 0;
  let fvExperimentTimeout = null, fvTimerInterval = null;

  // SPEM state
  const SPEM_TASK_DURATION_MS = 20000;
  const SPEM_FIXATION_DELAY_MS = 2000;
  const SPEM_REST_DELAY_MS = 2000;
  // Formula: pixel threshold = angular speed × pixels per degree.
  // Approximate 100°/s pursuit cutoff at the 37 px/degree default.
  // Unused directly — renderSPEMResults() recomputes this per-session from
  // the actual pxPerDeg (see spemSaccadeThrPx) so it's correct on other screens.
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
  // Normative thresholds use degrees for spatial measures and milliseconds for latency.
  const szN = { rms: 0.95, ratio: 1.8, err: 0.25, lat: 300 };  // rms in °, lat in ms
  let szFixT = [], szAntiT = [], szCsv = [], szTaskStartTime = 0;

  // Adapts EyeTracker callbacks to the SPEM task.
  let _spemGazeHandler = null, _spemPollTimer = null;
  const SpemAdapter = {
    /** Invoke the callback once eye-tracker calibration is ready. */
    waitForReady(cb) { _spemPollTimer = setInterval(() => { if (EyeTracker.isCalibrated()) { clearInterval(_spemPollTimer); cb(); } }, 300); },
    /** Subscribe to non-blink gaze coordinates. */
    subscribe(fn) { _spemGazeHandler = (d) => { if (!d.isBlink) fn({ x: d.x, y: d.y }); }; EyeTracker.onGaze(_spemGazeHandler); },
    /** Remove the SPEM gaze callback. */
    unsubscribe() { if (_spemGazeHandler) { EyeTracker.offGaze(_spemGazeHandler); _spemGazeHandler = null; } },
    /** Return the calibration error formatted for display. */
    getCalError() { const e = EyeTracker.getCalibrationError(); return e ? e.toFixed(1) + ' px' : '—'; }
  };

  // Adapts EyeTracker callbacks to the SchizoEye task.
  let _szGazeHandler = null;
  const SzTracker = {
    /** Report whether gaze calibration has completed. */
    isCalibrated() { return EyeTracker.isCalibrated(); },
    /** Subscribe to non-blink gaze coordinates. */
    subscribe(fn) {
      this.unsubscribe();
      _szGazeHandler = (d) => { if (!d.isBlink) fn({ x: d.x, y: d.y }); };
      EyeTracker.onGaze(_szGazeHandler);
    },
    /** Remove the SchizoEye gaze callback. */
    unsubscribe() {
      if (_szGazeHandler) { EyeTracker.offGaze(_szGazeHandler); _szGazeHandler = null; }
    },
  };

  const $ = id => document.getElementById(id);
  /** Wait for the next browser animation frame. */
  const frame = () => new Promise(r => requestAnimationFrame(r));
  /** Wait for a non-negative duration using a timer. */
  const wait = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
  /** Run a timed callback loop, using timers while the tab is hidden. */
  const timedLoop = (durationMs, cb) => new Promise(resolve => {
    const start = performance.now();
    const end   = start + durationMs;
    /** Run one iteration and schedule the next until the duration expires. */
    function tick() {
      const now = performance.now();
      if (now >= end) { resolve(); return; }
      try { cb(now); } catch(e) { console.warn('[timedLoop] cb error:', e); }
      if (document.hidden) {
        const remaining = end - performance.now();
        if (remaining > 0) setTimeout(tick, Math.min(16, remaining));
        else resolve();
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  });
  /** Convert degrees to pixels: pixels = degrees × pixelsPerDegree. */
  const d2p = d => d * pxPerDeg;
  /** Calculate the arithmetic mean, x̄ = Σx / n, or zero for an empty array. */
  const mean = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0;
  /** Calculate RMS 2D displacement: sqrt(mean(dx² + dy²)). */
  const rms  = pts => pts.length ? Math.sqrt(pts.reduce((s,p)=>s+p.dx*p.dx+p.dy*p.dy,0)/pts.length) : 0;
  /** Calculate population SD: sqrt(mean((x - mean(x))²)). */
  const sd   = a => { const m=mean(a); return Math.sqrt(mean(a.map(v=>(v-m)**2))); };
  /** Map a metric value to its display severity class. */
  const cls  = (v,t1,t2) => v < t1 ? 'ok' : v < t2 ? 'warn' : 'alert';

  // ── Battery startup ───────────────────────────────────────────────────────
  /** Read participant details, calculate screen scale, and open camera setup. */
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
    const diagInput = $('global-screen-diagonal');
    screenDiagonalInches = diagInput ? parseFloat(diagInput.value) || 15.6 : 15.6;

    // Pythagorean theorem: diagonalPx = sqrt(widthPx² + heightPx²).
    // Visual-angle formula: px/degree = (diagonal pixels / diagonal inches)
    // times (2 × viewing distance × tan(0.5°) / 2.54).
    const screenDiagPx = Math.hypot(window.innerWidth, window.innerHeight);
    const pxPerInch = screenDiagPx / screenDiagonalInches;
    const inchesPerDeg = 2 * 60 * Math.tan(0.5 * Math.PI / 180) / 2.54;
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

    // Open a camera stream for alignment preview; EyeTracker opens its own stream later.
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
        // Hide the camera initialization overlay.
        const startScreen = document.getElementById('cam-start-screen');
        if (startScreen) startScreen.style.display = 'none';
        // Initialize face alignment using the live preview video.
        if (typeof window._initFaceAlignment === 'function') {
          window._initFaceAlignment();
        }
        const proceedBtn = document.getElementById('cam-proceed-btn');
        if (proceedBtn) {
          proceedBtn.textContent = 'Lighting Good — Proceed to Calibration';
          proceedBtn.onclick = startVideoCal;
        }
        // Release the alignment stream when calibration begins.
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
        // Require an available preview stream before offering calibration.
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

  /** Dismiss the camera check and show the video-calibration instructions. */
  async function startVideoCal() {
    try {
      if (typeof window.TestDiag === 'function') window.TestDiag('startVideoCal: stopping preview');
      // Release the preview before starting EyeTracker.
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

  /** Start eye-tracker calibration after stopping the alignment preview. */
  async function startClickCal() {
    if (typeof window.TestDiag === 'function') window.TestDiag('startClickCal begin');
    $('battery-intro').classList.add('protocol-started');
    $('video-cal-screen').style.display = 'none';
    $('camera-check-screen').style.display = 'none';
    // EyeTracker owns the calibration interface; avoid showing legacy elements here.
    if (typeof window.TestDiag === 'function') window.TestDiag('calibration surfaces reset', {
      viewport: { width: window.innerWidth, height: window.innerHeight }
    });

    // Request fullscreen during the user-initiated click handler.
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        if (typeof window.TestDiag === 'function') window.TestDiag('Fullscreen request rejected during calibration', err);
        console.warn('[TestDiag] Fullscreen request rejected, continuing in windowed mode:', err);
      });
    }

    // Close the camera-check detector before initializing FaceMesh.
    try {
      if (typeof window._stopCameraPreview === 'function') {
        await window._stopCameraPreview({ preserveStream: false });
      }
      if (typeof window.TestDiag === 'function') window.TestDiag('preview teardown complete; starting EyeTracker');
      if (typeof window._startEyeTrackerNow === 'function') {
        await window._startEyeTrackerNow();
        if (typeof window.TestDiag === 'function') window.TestDiag('window._startEyeTrackerNow completed');
      }

      // Prefer the calibration flow that follows camera alignment.
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

  /** Begin the first task after eye-tracker calibration completes. */
  function onCalibrationComplete() {
    showTaskTransition(0);
  }

  // ── Task transitions ──────────────────────────────────────────────────────
  /** Display task instructions and configure the button for the selected task. */
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
  /** Initialize the SPEM practice trial and countdown. */
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

  /** Show the SPEM start countdown before preparing a trial. */
  function spemRunCountdown(n) {
    const ot = $('spem-overlay-text');
    ot.style.display = 'block';
    if (n > 0) { ot.textContent = `Starting in ${n}`; setTimeout(() => spemRunCountdown(n-1), 1000); }
    else { ot.style.display = 'none'; spemPrepareTask(); }
  }

  /** Prepare the next practice or clinical pursuit sequence. */
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

  /** Animate the SPEM target and collect gaze samples for the sequence. */
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

    /** Animate the sinusoidal target: x = cx + Ax·sin(2πft); Lissajous y uses 2f. */
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

  /** End the current SPEM trial and advance to the next phase. */
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

  /** Export the SPEM sample log and transition to the next task. */
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
  /** Run the fixation and antisaccade protocols and collect gaze samples. */
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
  

  /** Draw a filled circle on the SchizoEye task canvas. */
  function szDot(cx, x, y, r, c) { cx.fillStyle=c; cx.beginPath(); cx.arc(x,y,r,0,Math.PI*2); cx.fill(); }

  /** Show task instructions and resume when the participant continues. */
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
  /** Load the free-viewing image set and record unavailable files. */
  function loadFVImages() {
    fvImages = []; fvImageLoadErrors = []; let loadedCount = 0;
    for (let i = 1; i <= FV_NUM_IMAGES; i++) {
      const img = new Image(); const imgSrc = `${FV_IMAGE_FOLDER}${i}.jpg`;
      img.onload = () => { loadedCount++; fvImages[i-1] = { src: imgSrc, name: `${i}.jpg`, loaded: true }; updateFVLoadStatus(loadedCount); };
      img.onerror = () => { loadedCount++; fvImages[i-1] = { src: imgSrc, name: `${i}.jpg`, loaded: false }; fvImageLoadErrors.push(i); updateFVLoadStatus(loadedCount); };
      img.src = imgSrc;
    }
  }
  

  // ── Report state ──────────────────────────────────────────────────────────
  let _lastFeatures = {};
  let _lastDataQuality = {};
  let _lastResult = null;
  let _lastPrediction = null;
  let _lastClassProbabilities = null;
  let _lastFvRaw = [];

  /** Function 1: Provide report state without allowing report code to change controller data. */
  function getReportSnapshot() {
    return {
      subjectId,
      patientName,
      patientAge,
      patientSex,
      panssScore,
      features: _lastFeatures,
      prediction: _buildPredictionForReport(),
      freeViewingGaze: _lastFvRaw,
    };
  }

  const { downloadPDFReport } = createReportManager(getReportSnapshot);

  /** Update image-loading progress and enable the task when enough images load. */
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

  /** Reset the free-viewing collector and begin the image sequence. */
  function startFreeViewing() {
    if (typeof window.TestDiag === 'function') window.TestDiag('Task 3 Free Viewing started');
    $('fv-experiment-screen').style.display = 'flex';
    $('gaze-cursor').style.display = 'none';
    fvCurrentImageIndex = 0;
    RawGazeCollector.reset();
    showNextFVImage();
  }

  /** Show the fixation cross, then present and record the next image. */
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

  /** Stop free-viewing timers and proceed to the combined results screen. */
  function finishFreeViewing() {
    $('fv-experiment-screen').style.display = 'none';
    showAllResults(); // Finishes the battery
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UNIFIED RESULTS
  // ══════════════════════════════════════════════════════════════════════════
  /** Display task results and start feature extraction and classification. */
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

  /** Render per-image and total free-viewing sample counts. */
  function renderFVResults() {
    const allImageData = RawGazeCollector.getAllImageData();
    const totalSamples = allImageData.reduce((sum,img) => sum + img.sampleCount, 0);
    const tbody = $('fv-results-body');
    tbody.innerHTML = allImageData.map(img => `<tr><td>${img.imageName}</td><td>${img.sampleCount}</td></tr>`).join('');
    tbody.innerHTML += `<tr style="border-top:3px solid var(--accent);"><td style="color:var(--accent); font-weight:bold;">TOTAL</td><td style="color:var(--accent); font-weight:bold;">${totalSamples}</td></tr>`;
  }

  /** Plot target and eye position and velocity for each SPEM sequence. */
  function renderSPEMResults() {
    const now = new Date();
    const ts = now.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) + '  ·  ' + now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    $('spem-report-meta').textContent = `Subject: ${subjectId}  ·  ${ts}`;
    const container = $('spem-graphs-container'); container.innerHTML = '';
    // SPEM_SACCADE_THR_PX is a fixed px value derived from the 37 px/deg
    // default. Recompute it from this session's actual pxPerDeg so the
    // saccade markers/threshold line stay correct on other screen sizes.
    // Display-only: the exported HS4/LS2/LS4 features use the degree-based
    // Engbert-Kliegl detector in extractPursuit() and are unaffected.
    const spemSaccadeThrPx = d2p(100);

    // Plot and canvas colors.
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

      /** Apply a centered moving-average smoothing window. */
      function smoothData(data, w) { return data.map((_,i) => { const s=Math.max(0,i-Math.floor(w/2)), e=Math.min(data.length,i+Math.floor(w/2)+1); let sum=0; for(let j=s;j<e;j++) sum+=data[j]; return sum/(e-s); }); }
      const smEyeX = smoothData(eyeX, 7);
      const saccadeT=[], saccadeX=[], timeVel=[], eyeVel=[], targetVel=[], validGains=[];
      const ampX = (Math.max(...targetX)-Math.min(...targetX))/2, omega=2*Math.PI*task.freq;
      for (let i=1;i<smEyeX.length-1;i++) {
        const dt=time[i+1]-time[i-1]; if(dt<=0) continue;
        const vEye=Math.abs((smEyeX[i+1]-smEyeX[i-1])/dt);
        const vTarget=Math.abs(ampX*omega*Math.cos(omega*time[i]));
        timeVel.push(time[i]); eyeVel.push(vEye); targetVel.push(vTarget);
        if(vEye>spemSaccadeThrPx) { if(!saccadeT.length||time[i]-saccadeT[saccadeT.length-1]>0.1) { saccadeT.push(time[i]); saccadeX.push(smEyeX[i]); } }
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
        {x:[timeVel[0],timeVel[timeVel.length-1]],y:[spemSaccadeThrPx,spemSaccadeThrPx],mode:'lines',name:'Threshold',line:{color:P.amber,width:1.2,dash:'dot'},xaxis:'x',yaxis:'y2'},
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

  /** Render SchizoEye gaze plots, metrics, and clinical flags. */
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

  /** Draw gaze samples and eccentricity reference rings on a canvas. */
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

  /** Render the antisaccade trial outcome waterfall. */
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

  /** Summarize gaze stability for fixation trials. */
  function szFix() {
    const pure=szFixT.filter(t=>t.cond==='none').flatMap(t=>t.pts);
    const dist=szFixT.filter(t=>t.cond!=='none').flatMap(t=>t.pts);
    const rP=rms(pure), rD=rms(dist), ratio=rP>0?rD/rP:1;
    return {pure, dist, rP, rD, ratio};
  }

  /** Summarize performance across antisaccade trials. */
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

  /** Render one SchizoEye metric card with its normative range. */
  function szMc(lbl,val,norm,unit,c) {
    const pct=Math.min(100,parseFloat(val)/parseFloat(norm)*100), fc=c==='ok'?'var(--accent)':'var(--dim)';
    return `<div class="mc"><div class="ml">${lbl}</div><div class="mv ${c}">${val}${unit}</div><div class="mn">norm &lt; ${norm}${unit}</div><div class="mb"><div class="mf" style="width:${pct}%;background:${fc}"></div></div></div>`;
  }

  /** Render the SchizoEye summary from fixation and antisaccade metrics. */
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

  /** Render numeric fixation-stability metrics. */
  function szFixMetrics(f) {
    // Convert pixel RMS values to degrees using pxPerDeg factor
    const rPDeg = f.rP / pxPerDeg;
    const rDDeg = f.rD / pxPerDeg;
    
    $('sz-fmet').innerHTML = 
      szMc('Gaze Spread — Pure',rPDeg.toFixed(2),szN.rms,'°',cls(rPDeg,szN.rms,szN.rms*2)) + 
      szMc('Gaze Spread — Distractor',rDDeg.toFixed(2),szN.rms*2,'°',cls(rDDeg,szN.rms,szN.rms*3)) + 
      szMc('Distractibility Ratio',f.ratio.toFixed(2),szN.ratio,'×',cls(f.ratio,szN.ratio,szN.ratio*1.5));
  }

  /** Render numeric antisaccade metrics. */
  function szAntiMetrics(a) {
    // Error Rate    = errs / total trials
    // Self-Corrected = corr (subset of errors where the subject recovered to the correct side)
    // Uncorrected    = unc = errs - corr
    $('sz-amet').innerHTML =
      szMc('Error Rate',(a.rate*100).toFixed(0),25,'%',cls(a.rate,szN.err,0.4)) +
      szMc('Mean Latency (Correct)',a.lat>0?a.lat.toFixed(0):'—',szN.lat,'ms',cls(a.lat,szN.lat,450)) +
      szMc('Self-Corrected Errors',a.corr,2,'/10',cls(a.corr,2,4));
  }

  /** Render clinical interpretation flags from task metrics. */
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

  /** Download the raw free-viewing gaze samples as CSV. */
  function downloadFVCSV() {
    const allImageData = RawGazeCollector.getAllImageData();
    let csv = 'image_index,image_name,x,y,timestamp_ms,velocity,is_blink,confidence,frame_number\n';
    allImageData.forEach(img => img.gazeData.forEach(point => { csv += `${img.imageIndex},${img.imageName},${point.x.toFixed(4)},${point.y.toFixed(4)},${point.timestamp.toFixed(2)},${point.velocity.toFixed(4)},${point.isBlink?1:0},${point.confidence.toFixed(4)},${point.frameNumber}\n`; }));
    dlBlob(csv, `fv_gaze_raw_${Date.now()}.csv`);
  }

  /** Download the SPEM gaze samples as CSV. */
  function downloadSPEMCSV() { dlBlob(spemGlobalCSVContent, `spem_${subjectId.replace(/[^a-z0-9]/gi,'_')}_${Date.now()}.csv`); }

  /** Download the SchizoEye gaze samples as CSV. */
  function downloadSZCSV() {
    const content = 'Timestamp_ms,Phase,Gaze_X,Gaze_Y,Target_X,Target_Y\n' + szCsv.join('\n');
    dlBlob(content, `sz_${subjectId}_${Date.now()}.csv`);
  }

  /** Download all task CSV files with a short delay between downloads. */
  function downloadAllCSV() { 
    downloadFVCSV(); 
    setTimeout(downloadSPEMCSV, 600); 
    setTimeout(downloadSZCSV, 1200); 
  }

  /** Download each available SPEM graph as a PNG image. */
  function downloadSPEMPlots() {
    spemTestSequence.forEach(task => {
      const divId = `spem-graph-${task.id}`;
      if (document.getElementById(divId)) Plotly.downloadImage(divId, {format:'png',width:1400,height:700,filename:`${subjectId}_${task.id}`});
    });
  }

  /** Trigger a browser download from text content. */
  function dlBlob(content, filename) {
    const blob = new Blob([content], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }


  // ════════════════════════════════════════════════════════════════
  // ── Feature extraction ────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════

  // ── In-memory task data builders ─────────────────────────────────────────
  /** Convert collected free-viewing samples into feature-extractor rows. */
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

  /** Convert SPEM samples into feature-extractor rows. */
  function buildSpemRowsForExtractor() {
    return spemDataLog.map(r => ({
      Timestamp:r.time, TaskPhase:r.phase,
      TargetX:r.targetX, TargetY:r.targetY,
      EyeX:r.eyeX, EyeY:r.eyeY,
    }));
  }

  /** Parse SchizoEye CSV lines into feature-extractor rows. */
  function buildSzRowsForExtractor() {
    return szCsv.map(line => {
      const p = line.split(',');
      return { Timestamp_ms:parseFloat(p[0]), Phase:p[1],
        Gaze_X:parseFloat(p[2]), Gaze_Y:parseFloat(p[3]),
        Target_X:parseFloat(p[4]), Target_Y:parseFloat(p[5]) };
    });
  }

  // ── Feature extraction and inference ──────────────────────────────────────
  /** Extract session features, request model inference, then persist results. */
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

      const featureExtractor = createFeatureExtractor(pxPerDeg);
      const { finalFeatures, dataQuality } =
        featureExtractor.extractSessionFeatures(fvRaw, spRaw, szRaw);

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
        const classifyResponse = await ApiService.classifyFeatures(finalFeatures);
        const classifyData = await classifyResponse.json().catch(() => ({}));
        if (!classifyResponse.ok || !classifyData.success) {
          throw new Error(classifyData.error || `Inference HTTP ${classifyResponse.status}`);
        }
        if (!classifyData.prediction) {
          // Normalize the flat response shape to the prediction object used by the UI.
          classifyData.prediction = {
            label: classifyData.predicted_label,
            confidence: classifyData.confidence,
          };
        }
        _lastPrediction = classifyData.prediction;
        _lastClassProbabilities = classifyData.class_probabilities || null;
        statusEl.textContent = `✓ Inference complete — ${classifyData.prediction.label}`;
        renderPrediction(classifyData.prediction, classifyData.class_probabilities);
      } catch (inferenceErr) {
        _lastPrediction = null;
        _lastClassProbabilities = null;
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
      // Preserve extracted features if a later step fails.
      if (featuresReady) {
        try { await saveSessionToDatabase(); } catch (_) {}
      }
    }
  }

  /** Display extracted features and enable PDF download independent of inference. */
  function renderFeaturesOnly(features) {
    const el = document.getElementById('ai-features-summary');
    el.innerHTML = '<div style="columns:3;column-gap:24px;">' +
      FEATURE_ORDER.map(n => `<div style="break-inside:avoid;padding:2px 0"><span style="color:var(--dim)">${n}</span> <span style="color:var(--accent); font-weight:bold; float:right;">${features[n]}</span></div>`).join('') +
      '</div>';
    document.getElementById('ai-results-body').style.display = 'block';
    const pdfBtn = document.getElementById('btn-dl-pdf');
    if (pdfBtn) pdfBtn.style.display = 'inline-block';
  }

  /** Read class probabilities from either supported prediction response shape. */
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

  /** Build the prediction fields included in report and persistence payloads. */
  function _buildPredictionForReport() {
    if (!_lastPrediction) return null;
    const { healthy, schizo } = _extractProbs(_lastPrediction, _lastClassProbabilities);
    return {
      label: _lastPrediction.label,
      confidence: _lastPrediction.confidence,
      healthy_probability: healthy,
      schizophrenia_probability: schizo,
    };
  }

  /** Render the model label, confidence, and class-probability bars. */
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

    /** Build one labeled probability bar for the prediction card. */
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

  /** Explain why inference is unavailable while keeping extracted features visible. */
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

  /** Send task data, extracted features, and report images to the backend. */
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

      const savePayload = {
              subject_id: subjectId,
              patient_name: patientName || subjectId,
              patient_age: patientAge || 'N/A',
              patient_gender: patientSex || 'N/A',
              screen_size: `${screenDiagonalInches}"`,
            panss_score: collectedPanss ? parseFloat(collectedPanss) : null,  // ← null instead of 0,
              notes: collectedNotes,
              notes_author: collectedAuthor,
              calibration_error: EyeTracker.getCalibrationError(),
              // Store the session's visual-angle scale and tracker diagnostics.
              px_per_deg_used: pxPerDeg,
              tracker_performance: (typeof EyeTracker.getPerformanceStats === 'function')
                ? EyeTracker.getPerformanceStats() : null,
              data_quality: _lastDataQuality,
              features: _lastFeatures,
              prediction: _buildPredictionForReport(),
              fv_gaze: _lastFvRaw,
              spem_gaze: buildSpemRowsForExtractor(),
              sz_gaze: buildSzRowsForExtractor(),
              image_spem_hs4: spem_hs4_img,
              image_spem_ls2: spem_ls2_img,
              image_spem_ls4: spem_ls4_img,
              image_fix_pure: fix_pure_img,
              image_fix_dist: fix_dist_img
      };
      const response = await ApiService.saveResults(savePayload);

      const result = await response.json().catch(() => ({}));
      if (response.ok && result.success) {
        _lastResult = result;
        _lastPrediction = result.prediction || _lastPrediction;
        let pdfBase64 = result.pdf_base64 || '';
        if (!pdfBase64 && result.report_url) {
          try {
            const pdfResponse = await ApiService.getPdf(result.report_url);
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

window.BatteryController = BatteryController;
export default BatteryController;
