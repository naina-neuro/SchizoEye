# SchizoEye / NAINA — calibration + data-capture + save fixes

Three files ship here:

| File | What to do |
|---|---|
| `eye-tracker.js` | Replace the existing file outright |
| `camera-check.js` | New file, drop next to the others |
| `INTEGRATION.md` | The edits below, applied to `index.html`, `battery-controller.js`, `app.py` |

---

## What was actually broken

**1. Lighting check showed words, not numbers.**
`initFaceAlignment()` in `index.html` never started a detection loop. It wrote the
literal strings `Ready` and `Check lighting` into the two metric cards and enabled
the button. `computeLightingScore()`, `computeAlignmentScore()` and `onResults()`
were dead code — nothing called them. That is precisely your screenshot.

**2. The camera opened twice and a second calibration screen appeared.**
There were two separate preview surfaces and up to two `getUserMedia` calls:
`BatteryController.start()` opened a stream for `#camera-check-screen`, and then
`EyeTracker.recalibrate()` called `showAlignmentScreen()`, which built its own
"Eye Tracker Ready" screen with its own camera preview before the grid. v13 deletes
`showAlignmentScreen()` entirely; the camera-check screen now previews EyeTracker's
own `<video>`, so there is one stream, one detector, one preview, start to finish.

**3. `FV:0 SPEM:0 SZ:0` — the most important one.**
All three tasks feed from `EyeTracker.onGaze`. Zero rows in all three means
`processGazeSample()` never ran once during the whole battery. Two causes, both fixed:

- The frame loop was driven by `requestVideoFrameCallback` on a `<video>` parked at
  `left:-9999px` and moved between three parents during startup. Chromium throttles
  and can stop rVFC for videos it treats as non-rendered — when it stops, inference
  stops silently and nothing downstream notices until the results screen. v13 drives
  the loop from `requestAnimationFrame` (60 Hz, comfortably above the 33–50 FPS
  MediaPipe ceiling) plus a 2-second stall watchdog that clears a stuck
  `_detectorBusy` flag and restarts the loop.
- Camera selection preferred infrared sensors. The matcher was
  `label.toLowerCase().includes('ir')`, which matches `Wireless`, `Virtual`, `Direct`
  and, on most laptops, `IR Camera` (Windows Hello). An IR sensor gives a dark
  red/greyscale image — which is what your preview shows — and FaceMesh cannot land
  478 landmarks on it, so no landmarks, no gaze, no rows. v13 uses word-boundary
  matching, *demotes* IR/depth devices, detects a colourless frame and says so, and
  gives the operator a camera dropdown.

There is now also a guard so this can never silently reach the results screen again:
`EyeTracker.isEmitting()` is checked before each task starts, and each task checks
its own row count when it ends.

**4. `Failed to fetch` on `/save_results`.**
`TypeError: Failed to fetch` means no HTTP response arrived at all — not a 401, not a
500. The battery takes ~15 minutes, Render's free tier sleeps after 15 minutes idle,
and `/save_results` is the first backend call of the whole session. The CORS preflight
hits a sleeping instance and the browser reports a network error. Contributing factors:
the payload carries three raw gaze arrays plus five base64 PNGs (several MB), and the
server then runs matplotlib + WeasyPrint inside 512 MB.

Fixes below: a keep-alive ping during the battery, an explicit warm-up + retry before
the save, JPEG instead of PNG for the embedded plots, a local JSON backup download if
the save still fails, and error text that distinguishes asleep / unauthorised /
too-large instead of "Failed to fetch".

---

## 1. `index.html` — one line

Find the script block at the bottom and add `camera-check.js`:

```html
  <script src="eye-tracker.js"></script>
  <script src="camera-check.js"></script>   <!-- NEW: must come after the inline camera block -->
  <script src="gaze-collector.js"></script>
  <script src="battery-controller.js"></script>
```

`camera-check.js` deliberately overwrites `window._initFaceAlignment` and
`window._stopCameraPreview`, so the old inline IIFE becomes inert. You can delete
that inline block later; leaving it in place is harmless.

---

## 2. `battery-controller.js`

### 2a. Replace `start()`

```js
  // Computed after fullscreen settles: window.innerHeight changes when the
  // browser enters fullscreen, and every degree-based feature is scaled by this.
  function computePxPerDeg() {
    const diagInput = $('global-screen-diagonal');
    screenDiagonalInches = diagInput ? parseFloat(diagInput.value) || 15.6 : 15.6;
    const screenDiagPx = Math.hypot(window.innerWidth, window.innerHeight);
    const pxPerInch    = screenDiagPx / screenDiagonalInches;
    const inchesPerDeg = 2 * 60 * Math.tan(0.5 * Math.PI / 180) / 2.54;  // ~0.412 in/deg at 60 cm
    pxPerDeg = pxPerInch * inchesPerDeg;
    console.log(`[Calibration] pxPerDeg = ${pxPerDeg.toFixed(2)} (diagonal: ${screenDiagonalInches}", ${screenDiagPx.toFixed(0)}px)`);
  }

  function start() {
    if (typeof window.TestDiag === 'function') window.TestDiag('BatteryController.start begin');
    if (typeof EyeTracker !== 'undefined' && typeof EyeTracker.stop === 'function') EyeTracker.stop();

    subjectId   = $('global-subject-id').value.trim() || 'Subject_01';
    patientName = $('global-patient-name').value.trim();
    patientAge  = $('global-patient-age').value.trim();
    patientSex  = $('global-patient-sex').value.trim();
    panssScore  = $('global-panss-score').value.trim() || '';
    computePxPerDeg();

    startBackendKeepAlive();

    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.warn('[BatteryController] Fullscreen rejected, continuing windowed:', err);
      });
    }

    $('battery-intro').classList.add('protocol-started');
    $('battery-intro').style.display = 'none';
    $('camera-check-screen').style.display = 'flex';
    $('camera-check-screen').classList.remove('hidden');

    const proceedBtn = $('cam-proceed-btn');
    if (proceedBtn) { proceedBtn.disabled = true; proceedBtn.onclick = startVideoCal; }

    // camera-check.js owns the preview; it previews EyeTracker's own stream,
    // so no second getUserMedia and no handoff dance.
    if (window.CameraCheck) {
      window.CameraCheck.start();
    } else if (typeof window._initFaceAlignment === 'function') {
      window._initFaceAlignment();
    }
  }
```

### 2b. Replace `startVideoCal()` and `startClickCal()`

```js
  function startVideoCal() {
    if (window.CameraCheck) window.CameraCheck.pause();
    $('camera-check-screen').style.display = 'none';
    $('video-cal-screen').style.display = 'flex';
  }

  async function startClickCal() {
    $('video-cal-screen').style.display = 'none';
    $('camera-check-screen').style.display = 'none';
    $('battery-intro').classList.add('protocol-started');
    if (window.CameraCheck) window.CameraCheck.pause();

    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      try { await document.documentElement.requestFullscreen(); } catch (_) {}
      await wait(300);            // let the viewport settle before measuring it
    }
    computePxPerDeg();            // fullscreen changed innerHeight

    try {
      await EyeTracker.calibrate();   // grid + validation + summary, no second preview
    } catch (err) {
      console.error('[BatteryController] calibration failed:', err);
      if (typeof window.reportClientError === 'function') window.reportClientError('calibration', err);
      $('video-cal-screen').style.display = 'flex';
      const h = $('video-cal-screen').querySelector('h1');
      if (h) h.textContent = 'Calibration failed: ' + err.message;
    }
  }
```

The old `startClickCal()` called `_stopCameraPreview()` twice, toggled six element
classes and then `recalibrate()`. None of that is needed now.

### 2c. Gate every task on a live tracker

Add these helpers next to the other small utilities:

```js
  function trackerReady() {
    if (typeof EyeTracker === 'undefined' || !EyeTracker.isCalibrated()) {
      alert('The eye tracker is not calibrated yet. Run calibration before starting a task.');
      return false;
    }
    if (typeof EyeTracker.isEmitting === 'function' && !EyeTracker.isEmitting()) {
      const s = EyeTracker.getPerformanceStats();
      const ago = s.lastEmitAgoMs == null ? 'never' : s.lastEmitAgoMs + ' ms ago';
      const go = confirm(
        'The tracker is calibrated but is not producing gaze samples right now (last sample: ' + ago + ').\n\n' +
        'Usually the face has left the camera view, or the wrong camera is selected.\n\n' +
        'OK — recalibrate now.  Cancel — start the task anyway.');
      if (go) { EyeTracker.recalibrate(); return false; }
    }
    return true;
  }

  function taskDataCheck(label, count, redoFn) {
    if (count >= 10) return true;
    const again = confirm(
      label + ' recorded only ' + count + ' gaze samples, so no features can be extracted from it.\n\n' +
      'OK — repeat this task now.  Cancel — continue without it.');
    if (again) { redoFn(); return false; }
    return true;
  }
```

In `showTaskTransition()`, wrap the begin handler:

```js
    beginBtn.onclick = () => {
      if (!trackerReady()) return;
      tt.style.display = 'none';
      if (taskIdx === 0) startSPEM();
      else if (taskIdx === 1) startSZ();
      else if (taskIdx === 2) startFreeViewing();
    };
```

Then add the end-of-task checks:

```js
  // finishSPEM(), inside the setTimeout, replacing `showTaskTransition(1);`
      ot.style.display = 'none'; $('spem-test-canvas').style.display = 'none';
      if (!taskDataCheck('SPEM', spemDataLog.length, () => { $('spem-test-canvas').style.display = 'block'; startSPEM(); })) return;
      showTaskTransition(1);

  // startSZ(), replacing the final `cv.style.display = 'none'; showTaskTransition(2);`
    cv.style.display = 'none';
    if (!taskDataCheck('SchizoEye', szCsv.length, () => startSZ())) return;
    showTaskTransition(2);

  // finishFreeViewing()
  function finishFreeViewing() {
    $('fv-experiment-screen').style.display = 'none';
    const total = RawGazeCollector.getAllImageData().reduce((s, i) => s + i.sampleCount, 0);
    if (!taskDataCheck('Free viewing', total, () => startFreeViewing())) return;
    showAllResults();
  }
```

### 2d. Network layer — add above `runAIClassification()`

```js
  // ── Backend access ──────────────────────────────────────────────────────
  // Render's free tier sleeps after ~15 minutes idle and the battery runs for
  // ~15 minutes, so /save_results was routinely the first request to hit a
  // sleeping instance: the CORS preflight never got a reply and the browser
  // reported "TypeError: Failed to fetch".
  let _backendWarm = false;
  let _keepAliveTimer = null;

  function startBackendKeepAlive() {
    if (_keepAliveTimer) return;
    const ping = () => {
      fetch(`${API_BASE}/health`, { method: 'GET', cache: 'no-store' })
        .then(() => { _backendWarm = true; })
        .catch(() => { _backendWarm = false; });
    };
    ping();
    _keepAliveTimer = setInterval(ping, 4 * 60 * 1000);
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, { ...options, signal: ctrl.signal })
      .finally(() => clearTimeout(timer));
  }

  async function warmBackend(statusEl) {
    if (_backendWarm) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (statusEl) statusEl.textContent = `⏳ Waking the server (attempt ${attempt + 1}/3)…`;
      try {
        const r = await fetchWithTimeout(`${API_BASE}/health`, { cache: 'no-store' }, 30000);
        if (r.ok) { _backendWarm = true; return true; }
      } catch (_) { /* still asleep */ }
      await wait(2000);
    }
    return false;
  }

  function describeNetworkError(err, path) {
    if (!err) return new Error('Request failed');
    if (err.name === 'AbortError') {
      return new Error(`The server did not answer ${path} in time. It may still be starting up — wait a minute and press save again.`);
    }
    if (err.name === 'TypeError') {
      return new Error(`Could not reach ${API_BASE}${path} at all. The server is asleep, down, or blocked by CORS. Open ${API_BASE}/health in a browser tab to check it is up.`);
    }
    if (err.status === 401) {
      return new Error('The server rejected the request as unauthenticated. Sign in again, or open the test through a ?token= link from /integration/test-sessions.');
    }
    if (err.status === 413) {
      return new Error('The session payload was too large for the server to accept.');
    }
    return err;
  }

  async function apiPost(path, body, opts) {
    const { timeoutMs = 150000, retries = 1, statusEl = null } = opts || {};
    await warmBackend(statusEl);
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchWithTimeout(`${API_BASE}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiHeaders() },
          credentials: 'include',
          body: JSON.stringify(body),
        }, timeoutMs);
        const text = await res.text();
        let json = {};
        try { json = text ? JSON.parse(text) : {}; }
        catch (_) { json = { error: text.slice(0, 300) }; }
        if (!res.ok) {
          const err = new Error(json.error || `HTTP ${res.status} ${res.statusText}`);
          err.status = res.status;
          if (res.status >= 500 && attempt < retries) { lastErr = err; await wait(3000); continue; }
          throw err;
        }
        return json;
      } catch (e) {
        lastErr = e;
        if ((e.name === 'AbortError' || e.name === 'TypeError') && attempt < retries) {
          _backendWarm = false;
          if (statusEl) statusEl.textContent = '⏳ No response — retrying…';
          await wait(3000);
          continue;
        }
        break;
      }
    }
    throw describeNetworkError(lastErr, path);
  }
```

### 2e. `runAIClassification()` — two edits

Replace the insufficient-data branch:

```js
      if (fvRaw.length < 10 || spRaw.length < 10 || szRaw.length < 10) {
        const empty = [
          fvRaw.length < 10 ? 'free viewing' : null,
          spRaw.length < 10 ? 'SPEM' : null,
          szRaw.length < 10 ? 'SchizoEye' : null,
        ].filter(Boolean).join(', ');
        const stats = (typeof EyeTracker.getPerformanceStats === 'function') ? EyeTracker.getPerformanceStats() : {};
        const message = `No gaze data from: ${empty} (FV:${fvRaw.length} SPEM:${spRaw.length} SZ:${szRaw.length}). ` +
          `Tracker emitted ${stats.emittedSamples || 0} samples in total on camera "${stats.cameraLabel || 'unknown'}".`;
        statusEl.textContent = `⚠ ${message} Recalibrate and repeat the affected task.`;
        if (typeof window.reportClientError === 'function') window.reportClientError('feature extraction', new Error(message));
        return;
      }
```

And replace the `fetch(...'/classify')` block:

```js
      statusEl.textContent = '⏳ Sending the 59 features to the inference API…';
      const classifyData = await apiPost('/classify', { features: finalFeatures },
                                         { timeoutMs: 90000, retries: 1, statusEl });
      if (!classifyData.success) throw new Error(classifyData.error || 'Inference failed');
      _lastPrediction = classifyData.prediction;
```

### 2f. Replace `saveSessionToDatabase()`

```js
  function _localBackup(payload) {
    try {
      const slim = { ...payload };
      delete slim.image_spem_hs4; delete slim.image_spem_ls2; delete slim.image_spem_ls4;
      delete slim.image_fix_pure; delete slim.image_fix_dist;
      dlBlob(JSON.stringify(slim), `session_backup_${subjectId}_${Date.now()}.json`);
      return true;
    } catch (_) { return false; }
  }

  async function saveSessionToDatabase() {
    const statusEl = $('ai-status-text');
    const saveBtn = document.getElementById('btn-save-session');
    if (saveBtn) saveBtn.disabled = true;

    if (!_lastFeatures || Object.keys(_lastFeatures).length !== 59) {
      statusEl.textContent = '⚠ Nothing to save — feature extraction did not complete.';
      if (saveBtn) saveBtn.disabled = false;
      return;
    }

    try {
      statusEl.textContent = '📸 Capturing figures…';
      const resultsPanssInput = $('results-panss-score');
      const resultsNotesInput = $('results-doctor-notes');

      // JPEG instead of PNG: the five embedded figures were the bulk of a
      // multi-megabyte JSON body, and a lossy plot is fine for a report.
      const jpeg = async (divId) => {
        try { return await Plotly.toImage(divId, { format: 'jpeg', width: 800, height: 320 }); }
        catch (_) { return ''; }
      };
      const canvasJpeg = (id) => {
        const el = document.getElementById(id);
        try { return el ? el.toDataURL('image/jpeg', 0.75) : ''; } catch (_) { return ''; }
      };

      const payload = {
        subject_id: subjectId,
        patient_name: patientName || subjectId,
        patient_age: patientAge || 'N/A',
        patient_gender: patientSex || 'N/A',
        screen_size: `${screenDiagonalInches}"`,
        panss_score: (resultsPanssInput && resultsPanssInput.value.trim())
          ? parseFloat(resultsPanssInput.value.trim()) : null,
        notes: resultsNotesInput ? resultsNotesInput.value.trim() : '',
        notes_author: window._currentUser || 'unknown',
        calibration_error: EyeTracker.getCalibrationError(),
        px_per_deg_used: pxPerDeg,
        tracker_performance: (typeof EyeTracker.getPerformanceStats === 'function')
          ? EyeTracker.getPerformanceStats() : null,
        data_quality: _lastDataQuality,
        features: _lastFeatures,
        fv_gaze: _lastFvRaw,
        spem_gaze: buildSpemRowsForExtractor(),
        sz_gaze: buildSzRowsForExtractor(),
        image_spem_hs4: await jpeg('spem-graph-Horizontal_0.4Hz'),
        image_spem_ls2: await jpeg('spem-graph-Lissajous_0.2Hz'),
        image_spem_ls4: await jpeg('spem-graph-Lissajous_0.4Hz'),
        image_fix_pure: canvasJpeg('cFP'),
        image_fix_dist: canvasJpeg('cFD'),
      };

      const sizeMb = (JSON.stringify(payload).length / 1048576).toFixed(1);
      statusEl.textContent = `💾 Saving session (${sizeMb} MB)…`;

      const result = await apiPost('/save_results', payload,
                                   { timeoutMs: 180000, retries: 1, statusEl });

      _lastResult = result;
      _lastPrediction = result.prediction || _lastPrediction;
      statusEl.textContent = '✓ Session saved to database.';

      if (saveBtn) { saveBtn.textContent = '✓ Saved'; saveBtn.style.opacity = '0.6'; }
      const statusLabel = document.getElementById('save-status-label');
      if (statusLabel) { statusLabel.textContent = '✓ Saved'; statusLabel.style.color = '#1A7A4A'; }
      const returnWrap = document.getElementById('return-to-dashboard-wrap');
      if (returnWrap) returnWrap.style.display = 'block';

      const completionPayload = {
        type: 'OCULOMOTOR_ASSESSMENT_COMPLETE',
        status: 'success',
        sessionId: result.session_id,
        subjectId: result.subject_id || subjectId,
        prediction: result.prediction,
        features: result.features,
        featureOrder: result.feature_order,
        reportUrl: `${API_BASE}${result.report_url}`,
        pdfBase64: result.pdf_base64 || '',
      };
      if (window.parent !== window) window.parent.postMessage(completionPayload, '*');
      if (window.opener && window.opener !== window) window.opener.postMessage(completionPayload, '*');

    } catch (err) {
      statusEl.textContent = '⚠ ' + err.message;
      if (typeof window.reportClientError === 'function') {
        window.reportClientError('save_results request', err, `API: ${API_BASE}/save_results`);
      }
      if (confirm(err.message + '\n\nDownload a local JSON backup of this session so nothing is lost?')) {
        _localBackup({
          subject_id: subjectId, features: _lastFeatures, data_quality: _lastDataQuality,
          fv_gaze: _lastFvRaw, spem_gaze: buildSpemRowsForExtractor(), sz_gaze: buildSzRowsForExtractor(),
          px_per_deg_used: pxPerDeg, calibration_error: EyeTracker.getCalibrationError(),
        });
      }
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Retry save'; }
    }
  }
```

---

## 3. `app.py`

### 3a. Cap the request body instead of dying on it

```python
app.config["MAX_CONTENT_LENGTH"] = 48 * 1024 * 1024   # 48 MB
```

### 3b. A failed PDF must not throw the session away

In `/save_results`, the PDF block currently does
`return jsonify({'success': False, 'error': 'PDF generation failed'}), 500` —
so a WeasyPrint hiccup discards a completed 15-minute assessment. Change the
`except` to keep going:

```python
        except Exception as pdf_err:
            print(f"Warning: PDF generation/upload failed: {pdf_err}")
            traceback.print_exc()
            gridfs_refs.pop('report_id', None)
            # Session data is what matters; the report can be regenerated later
            # by GET /sessions/<id>/pdf, which already rebuilds on demand.
```

### 3c. Give gunicorn room to finish

Render start command:

```
gunicorn app:app --workers 1 --threads 4 --timeout 180 --graceful-timeout 30
```

One worker, because matplotlib + WeasyPrint in 512 MB will not survive two.

---

## 4. Before you hand the link to the partner site

`/classify` and `/save_results` both require `_caller_is_authorized()`, which is a
Flask session cookie **or** an `X-Test-Token` header. A visitor arriving by redirect
from someone else's website has neither, and the session cookie is `SameSite=None`
third-party — Chrome is actively phasing that out. The result will be a clean 401 on
every save.

Use the token path that already exists in `app.py`:

1. The partner's server calls `POST /integration/test-sessions` with header
   `X-Integration-Key: <INTEGRATION_API_KEY>`.
2. It gets back `test_url` — `…/index.html?mode=test&token=…`.
3. It redirects the patient to that URL.

`battery-controller.js` already reads `?token=` into `TEST_TOKEN` and sends it as
`X-Test-Token`, so nothing else changes. Set `INTEGRATION_API_KEY` and
`TEST_FRONTEND_URL` in Render, and add the partner's origin to `CORS_ORIGINS`.

---

## 5. What the flow looks like now

```
Begin protocol
  └ details form          pxPerDeg computed, backend keep-alive ping starts
Step 1 — camera check     live FRAMING % and LIGHTING /100 from real pixels
  │                       camera dropdown, infrared-sensor warning
  └ Continue enabled once both are good for 1.2 s (override after 18 s)
Step 2 — calibration guide
Step 3 — calibration      20 points, automatic, retries weak points
  └ 5 held-out check points → "mean gaze error N px" → Start the tasks / Recalibrate
Task 1 SPEM  ─┐
Task 2 SZ     ├ each gated on EyeTracker.isEmitting(), each checks its own row count
Task 3 FV    ─┘
Results → classify → save (warm-up, retry, local backup on failure)
```

The gaze cursor is now hidden during the tasks. A dot that follows the participant's
own gaze is a closed feedback loop and contaminates pursuit and antisaccade data;
call `EyeTracker.setCursorVisible(true)` if you want it back while debugging.

---

## 6. Two-minute smoke test

1. Load the page, open the console, start the protocol.
2. Camera-check screen: the two cards must show a percentage and a number that move
   when you lean out of frame or dim the lights. If the preview is red or grey, the
   IR warning should appear — switch camera in the dropdown.
3. Calibration: exactly one camera preview in the whole run, no SPACE prompts.
4. After the summary, run `EyeTracker.getPerformanceStats()` in the console.
   `emitting: true` and a rising `emittedSamples` is the go/no-go signal.
5. Skip through a task and watch `Samples:` on the free-viewing HUD increment.
6. `curl https://schizoeyeclassification.onrender.com/health` before saving — if that
   is slow the first time, the keep-alive is doing its job during the real run.

---

## 7. Post-mortem: the 955 px run (blank calibration screen)

Your console shows eye-tracker v13 running, but the *old* `battery-controller.js`
and the *old* inline camera block from `index.html` — `_stopCameraPreview begin`,
`preview tracks stopped; waiting 300ms for OS camera lock`, `face_detection_solution`
WebGL contexts. So sections 1 and 2 above had not been applied. That matters twice
over: the camera still opens twice, and the lighting card still shows words.

The blank screen and the 955 px error were one bug, and it was mine:

- `calUI()` set `#cal-screen` to `z-index: 2600`.
- The target was the page's own `#cal-dot`, which `index.html` styles at `z-index: 1002`.
- 1002 < 2600, so the target rendered **behind** the calibration backdrop. The bottom
  panel had no `z-index` at all, so it was hidden too.

The participant stared at an empty dark rectangle for 20 points. The ridge fit
therefore learned nothing, collapsed toward predicting screen centre, and validation
measured ~half a screen width of error. `198 samples from 20 points` is a healthy
capture rate — the sampling was fine, there was simply nothing to look at.

### What changed in `eye-tracker.js`

- **One owned stacking context.** Calibration now builds `#nt-cal-root` at
  `z-index: 2147483000` containing its own backdrop, target, hint line, progress bar
  and counter. `#cal-screen` and `#cal-dot` are explicitly hidden. Nothing about the
  calibration surface depends on `styles.css` any more, so no page stylesheet can
  bury it again.
- **A real fixation target.** White disc with a dark core, moved with `transform`,
  plus a ring that contracts over the capture window so the participant can see
  exactly when they are being measured.
- **Protocol around the points.** Face pre-flight with specific feedback (too far,
  turned away, not found), a written instruction card, a 3–2–1 countdown, then the
  20 points, then 5 held-out check points. Esc cancels.
- **Head-translation gate.** Samples are dropped while the face centre moves more
  than 3.5% of frame width/height, or the face size changes by more than 12%, since
  the 12-D features encode absolute iris position and a head shift fakes a gaze shift.
- **Per-point outlier rejection.** Median + MAD in feature space, cutoff at 3·MAD.
  One blink out of ten samples used to drag a point noticeably.
- **A degeneracy test instead of a mystery number.** After fitting, per-point mean
  predictions are regressed against the true targets. If R² < 0.35 the run is
  discarded with: *the eye features barely changed as the target moved.* That is the
  exact signature of a target nobody could see — you would have got that message
  instead of `955 px`. The bad model is no longer kept.
- **A poor result now asks before proceeding** rather than offering "Start the tasks"
  as the obvious green button.

Nothing in the public API changed, so this is still a straight file swap.
