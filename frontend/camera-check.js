/*
 * ============================================================
 *  camera-check.js  —  Step 1: framing + lighting check
 * ============================================================
 *
 *  Replaces the inline camera-check IIFE in index.html.
 *
 *  Why it exists
 *  ─────────────
 *  The inline version defined computeLightingScore() / computeAlignmentScore()
 *  / onResults() but never called any of them: initFaceAlignment() just wrote
 *  the literal strings "Ready" and "Check lighting" into the two metric cards
 *  and enabled the Proceed button. That is exactly what the screen showed.
 *
 *  It also opened its own getUserMedia stream, which EyeTracker then had to
 *  inherit through a window._handoffMediaStream dance — and if the handoff
 *  missed, the camera was opened a second time.
 *
 *  This version has no camera of its own. It previews EyeTracker's video
 *  element (EyeTracker.startPreview) and scores:
 *
 *    LIGHTING  0-100   measured from the pixels: face-region brightness,
 *                      local contrast, and a backlight penalty when the
 *                      background is much brighter than the face.
 *    FRAMING   0-100%  measured from the FaceMesh landmarks EyeTracker is
 *                      already computing: face size in frame + how frontal
 *                      the head is + offset from the oval guide.
 *
 *  It also detects infrared / Windows-Hello cameras (nearly colourless or
 *  red-dominant frames) and offers a camera picker, because an IR sensor is
 *  a common default on laptops and FaceMesh cannot land iris landmarks on it.
 *
 *  Load this AFTER the inline block in index.html and BEFORE eye-tracker.js
 *  is used — it deliberately overwrites window._initFaceAlignment and
 *  window._stopCameraPreview so the old inline code becomes inert.
 * ============================================================
 */
(function () {
  'use strict';

  const CFG = {
    LIGHT_MIN      : 55,     // out of 100
    FRAMING_MIN    : 0.60,   // 0..1
    HOLD_MS        : 1200,   // both metrics good for this long
    OVERRIDE_MS    : 18000,  // after this, allow proceeding anyway
    SAMPLE_MS      : 120,    // pixel sampling cadence (~8 Hz)
    SILHOUETTE     : 0.60,
  };

  const $ = (id) => document.getElementById(id);

  let sampler = null;
  let running = false;
  let goodSince = 0;
  let startedAt = 0;
  let lastLight = 0;
  let lastFraming = 0;
  let lastFace = false;
  let irWarned = false;

  const buf = document.createElement('canvas');
  const bctx = buf.getContext('2d', { willReadFrequently: true });

  // ── overlay drawing ────────────────────────────────────────
  function stageSize() {
    const stage = $('cam-stage');
    const r = stage ? stage.getBoundingClientRect() : { width: 480, height: 360 };
    return { w: Math.round(r.width) || 480, h: Math.round(r.height) || 360 };
  }

  function sizeCanvases() {
    const { w, h } = stageSize();
    [$('cam-overlay-canvas'), $('cam-debug-canvas')].forEach(c => {
      if (!c) return;
      c.width = w; c.height = h;
    });
  }

  function silhouette(w, h) {
    const cy = h * 0.44;
    const ry = (h * CFG.SILHOUETTE) / 2;
    return { cx: w / 2, cy, rx: ry * 0.72, ry };
  }

  function drawOverlay(state) {
    const c = $('cam-overlay-canvas'); if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    const s = silhouette(w, h);
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.ellipse(s.cx, s.cy, s.rx, s.ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.40)';
    ctx.fill('evenodd');
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(s.cx, s.cy, s.rx, s.ry, 0, 0, Math.PI * 2);
    if (state === 'good')      { ctx.strokeStyle = 'rgba(34,197,94,.95)'; ctx.lineWidth = 3; ctx.setLineDash([]); }
    else if (state === 'close'){ ctx.strokeStyle = 'rgba(245,158,11,.9)'; ctx.lineWidth = 2.5; ctx.setLineDash([12, 7]); }
    else                       { ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 2; ctx.setLineDash([10, 7]); }
    ctx.stroke();
    ctx.restore();
  }

  function drawFaceBox(geom, aligned) {
    const c = $('cam-debug-canvas'); if (!c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (!geom) return;
    // the preview is mirrored with scaleX(-1), so mirror x for the overlay
    const x = (1 - geom.cx - geom.w / 2) * c.width;
    const y = (geom.cy - geom.h / 2) * c.height;
    ctx.save();
    ctx.strokeStyle = aligned ? 'rgba(34,197,94,.75)' : 'rgba(239,68,68,.65)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x, y, geom.w * c.width, geom.h * c.height);
    ctx.restore();
  }

  // ── pixel metrics ──────────────────────────────────────────
  function measurePixels(video, geom) {
    const W = 96, H = 72;
    buf.width = W; buf.height = H;
    try { bctx.drawImage(video, 0, 0, W, H); }
    catch (_) { return null; }

    let data;
    try { data = bctx.getImageData(0, 0, W, H).data; }
    catch (_) { return null; }

    // Face region in buffer coordinates (unmirrored — matches the raw video)
    let fx0 = Math.floor(W * 0.3), fy0 = Math.floor(H * 0.2);
    let fx1 = Math.ceil(W * 0.7),  fy1 = Math.ceil(H * 0.8);
    if (geom) {
      fx0 = Math.max(0, Math.floor((geom.cx - geom.w / 2) * W));
      fx1 = Math.min(W, Math.ceil((geom.cx + geom.w / 2) * W));
      fy0 = Math.max(0, Math.floor((geom.cy - geom.h / 2) * H));
      fy1 = Math.min(H, Math.ceil((geom.cy + geom.h / 2) * H));
    }
    if (fx1 <= fx0 || fy1 <= fy0) return null;

    let frameSum = 0, frameN = 0;
    let faceSum = 0, faceSq = 0, faceN = 0;
    let rSum = 0, gSum = 0, bSum = 0, satSum = 0;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        frameSum += luma; frameN++;
        rSum += r; gSum += g; bSum += b;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        satSum += mx > 0 ? (mx - mn) / mx : 0;
        if (x >= fx0 && x < fx1 && y >= fy0 && y < fy1) {
          faceSum += luma; faceSq += luma * luma; faceN++;
        }
      }
    }
    if (!faceN || !frameN) return null;

    const faceLuma  = faceSum / faceN;
    const frameLuma = frameSum / frameN;
    const faceStd   = Math.sqrt(Math.max(0, faceSq / faceN - faceLuma * faceLuma));

    // brightness: 0 at pitch black, peaks in the 110-190 band, falls off when blown out
    let brightness;
    if (faceLuma < 60)       brightness = (faceLuma / 60) * 68;
    else if (faceLuma > 205) brightness = Math.max(0, 70 - (faceLuma - 205) * 1.6);
    else                     brightness = 68 + ((faceLuma - 60) / 145) * 32;

    const contrast  = Math.min(100, (faceStd / 34) * 100);
    const backlight = frameLuma > 0 ? Math.max(0, 1 - faceLuma / frameLuma) : 0;
    const score = Math.round(Math.max(0, Math.min(100,
      brightness * 0.62 + contrast * 0.38 - backlight * 45)));

    const meanSat = satSum / frameN;
    const rMean = rSum / frameN, gMean = gSum / frameN, bMean = bSum / frameN;
    const looksIR = meanSat < 0.10 || (rMean > gMean * 1.55 && rMean > bMean * 1.55 && gMean < 70);

    return { score, faceLuma, frameLuma, faceStd, backlight, looksIR };
  }

  // ── framing score ──────────────────────────────────────────
  function framingScore(stats) {
    if (!stats || !stats.faceFound || !stats.geometry) return 0;
    const g = stats.geometry;
    // offset from the oval guide (guide centre sits at 0.50 / 0.44)
    const dx = Math.abs(g.cx - 0.50) / 0.22;
    const dy = Math.abs(g.cy - 0.44) / 0.26;
    const placement = Math.max(0, 1 - (dx * 0.5 + dy * 0.5));
    // 55% comes from the tracker's own size + pose quality, which is what
    // actually decides whether calibration will work
    return Math.max(0, Math.min(1, placement * 0.45 + g.quality * 0.55));
  }

  // ── UI ─────────────────────────────────────────────────────
  function colourFor(value, threshold) {
    if (value >= threshold) return '#22c55e';
    if (value >= threshold * 0.65) return '#f59e0b';
    return '#ef4444';
  }

  function setStatus(kind, msg) {
    const banner = $('cam-status-banner'), text = $('cam-status-text');
    if (banner) banner.className = kind;
    if (text) text.textContent = msg;
  }

  function setTips(html) {
    const el = $('cam-tips');
    if (el) el.innerHTML = html;
  }

  function render(framing, light, faceFound, pixels) {
    const alignEl = $('cam-align-score'), alignMeter = $('cam-align-meter');
    const lightEl = $('cam-light-score'), lightMeter = $('cam-light-meter');

    if (alignEl) {
      alignEl.textContent = faceFound ? Math.round(framing * 100) + '%' : '—';
      alignEl.style.color = faceFound ? colourFor(framing, CFG.FRAMING_MIN) : '#8b909e';
    }
    if (alignMeter) {
      alignMeter.style.width = (faceFound ? Math.round(framing * 100) : 0) + '%';
      alignMeter.style.background = colourFor(framing, CFG.FRAMING_MIN);
    }
    if (lightEl) {
      lightEl.textContent = String(light);
      lightEl.style.color = colourFor(light, CFG.LIGHT_MIN);
    }
    if (lightMeter) {
      lightMeter.style.width = light + '%';
      lightMeter.style.background = colourFor(light, CFG.LIGHT_MIN);
    }

    const framed = framing >= CFG.FRAMING_MIN;
    const lit = light >= CFG.LIGHT_MIN;

    if (pixels && pixels.looksIR && !irWarned) {
      irWarned = true;
      setTips('<strong>This camera has no usable colour image.</strong> It is probably an infrared ' +
              '(Windows Hello) sensor. Face landmarks will not be detected. Pick a different camera below.');
    }

    if (!faceFound) {
      setStatus('bad', 'No face detected');
      if (!irWarned) setTips('<strong>No face detected.</strong> Sit so your whole face is inside the oval, and check the camera below is the right one.');
      drawOverlay('neutral');
      drawFaceBox(null, false);
      return { framed, lit };
    }

    drawOverlay(framed && lit ? 'good' : 'close');

    if (!framed) {
      setStatus('bad', 'Adjust your position — framing ' + Math.round(framing * 100) + '%');
      setTips('Centre your face in the oval. Move closer if your face looks small, back off if it fills the frame, and look straight at the screen.');
    } else if (!lit) {
      const why = pixels && pixels.backlight > 0.25
        ? 'There is a bright light or window behind you — turn around or close the blind.'
        : (pixels && pixels.faceLuma < 60
            ? 'Your face is too dark. Add a lamp in front of you or face a window.'
            : 'Lighting is uneven. Even, front-facing light works best.');
      setStatus('warning', 'Lighting ' + light + '/100 — needs ' + CFG.LIGHT_MIN);
      setTips(why);
    } else {
      setStatus('good', 'Framing and lighting look good');
      setTips('<strong>Ready.</strong> Hold this position and continue to the calibration guide.');
    }
    return { framed, lit };
  }

  function setProceed(enabled, label) {
    const btn = $('cam-proceed-btn');
    if (!btn) return;
    btn.disabled = !enabled;
    if (label) btn.textContent = label;
  }

  // ── camera picker ──────────────────────────────────────────
  async function buildCameraPicker() {
    const header = $('cam-check-header');
    if (!header || !header.parentNode) return;

    let row = $('cam-device-row');
    if (!row) {
      row = document.createElement('div');
      row.id = 'cam-device-row';
      row.style.cssText = 'width:480px;max-width:100%;display:flex;gap:10px;align-items:center;';
      row.innerHTML =
        '<label for="cam-device-select" style="font-size:13px;color:#8b909e;white-space:nowrap;">Camera</label>' +
        '<select id="cam-device-select" style="flex:1;padding:9px 10px;border-radius:8px;' +
          'background:#181b22;color:#e8eaf0;border:1px solid rgba(255,255,255,.1);font-size:13px;"></select>';
      header.parentNode.insertBefore(row, header.nextSibling);
    }

    const select = $('cam-device-select');
    const cams = await EyeTracker.listCameras();
    const current = EyeTracker.getPerformanceStats().cameraLabel;
    select.innerHTML = cams.map(c =>
      '<option value="' + c.deviceId + '"' + (c.label === current ? ' selected' : '') + '>' +
      (c.label + (c.isIR ? '  (infrared — not usable)' : '')) + '</option>'
    ).join('');

    select.onchange = async () => {
      setStatus('idle', 'Switching camera…');
      setProceed(false);
      irWarned = false;
      try { await EyeTracker.switchCamera(select.value); }
      catch (err) { setStatus('bad', 'Could not open that camera: ' + err.message); }
    };
  }

  // ── main loop ──────────────────────────────────────────────
  let latestStats = { faceFound: false, geometry: null, quality: 0 };

  function tick() {
    if (!running) return;
    const video = EyeTracker.getVideoElement();
    const geom = latestStats.geometry;
    const pixels = video ? measurePixels(video, geom) : null;

    lastLight   = pixels ? pixels.score : 0;
    lastFraming = framingScore(latestStats);
    lastFace    = !!latestStats.faceFound;

    drawFaceBox(geom, lastFraming >= CFG.FRAMING_MIN);
    const { framed, lit } = render(lastFraming, lastLight, lastFace, pixels);

    const ok = lastFace && framed && lit;
    if (ok) {
      if (!goodSince) goodSince = performance.now();
      if (performance.now() - goodSince >= CFG.HOLD_MS) {
        setProceed(true, 'Continue to calibration');
      }
    } else {
      goodSince = 0;
      const elapsed = performance.now() - startedAt;
      if (elapsed > CFG.OVERRIDE_MS) {
        setProceed(true, 'Continue anyway');
      } else {
        setProceed(false, 'Checking camera…');
      }
    }
  }

  async function start() {
    const stage = $('cam-stage');
    const startScreen = $('cam-start-screen');
    const permError = $('cam-perm-error');

    startedAt = performance.now();
    goodSince = 0;
    irWarned = false;
    sizeCanvases();
    drawOverlay('neutral');
    setStatus('idle', 'Starting camera…');
    setTips('Waiting for the camera…');
    setProceed(false, 'Checking camera…');
    if (permError) permError.style.display = 'none';

    try {
      await EyeTracker.startPreview(stage, (stats) => { latestStats = stats; });
    } catch (err) {
      if (startScreen) startScreen.style.display = 'none';
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      const busy = err && err.name === 'NotReadableError';
      if (permError) {
        permError.style.display = 'block';
        permError.textContent = denied
          ? 'Camera permission was denied. Allow camera access for this site in your browser settings, then reload.'
          : busy
            ? 'The camera is already in use. Close Zoom, Teams, Meet, or any other tab using the webcam, then reload.'
            : 'Camera could not be started: ' + (err && err.message ? err.message : String(err));
      }
      setStatus('bad', 'Camera unavailable');
      setProceed(false, 'Camera unavailable');
      if (typeof window.reportClientError === 'function') window.reportClientError('camera preview', err);
      return;
    }

    if (startScreen) startScreen.style.display = 'none';
    sizeCanvases();
    await buildCameraPicker();

    running = true;
    if (sampler) clearInterval(sampler);
    sampler = setInterval(tick, CFG.SAMPLE_MS);
  }

  function pause() {
    running = false;
    if (sampler) { clearInterval(sampler); sampler = null; }
  }

  window.addEventListener('resize', () => { if (running) sizeCanvases(); });

  window.CameraCheck = { start, pause, get lastScores() { return { light: lastLight, framing: lastFraming, face: lastFace }; } };

  // Overwrite the inline hooks from index.html so the old dead code is inert.
  window._initFaceAlignment = function () { return start(); };
  window._stopCameraPreview = async function () {
    // The stream belongs to EyeTracker now; only the analysis loop stops here.
    pause();
    return true;
  };
})();
