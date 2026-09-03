/*
 * ============================================================
 *  gaze-collector.js  —  Oculomotor Battery (Unified push-based sampling)
 * ============================================================
 *
 *  Records raw gaze data during the Free Viewing task (Task 3).
 *
 *  FIX BC-MATH-11 / SAMPLING-RATE UNIFICATION (this revision):
 *  ─────────────────────────────────────────────────────────
 *  The previous version polled EyeTracker.getGaze() inside a
 *  requestAnimationFrame loop, self-throttled to `cameraFps * 0.8`
 *  (see updateTargetSamplingRate() in the old file) via
 *  EyeTracker.getActualFPS() — which reflects the CAMERA's negotiated
 *  capture framerate (from getUserMedia's negotiated track settings),
 *  not the tracker's actual gaze-emission rate (which is separately
 *  bounded by MediaPipe FaceMesh inference cost — see eye-tracker.js's
 *  own header comment: "~20-30ms/frame on consumer hardware -> hard
 *  ceiling of 33-50 FPS regardless of architecture"). Whenever the
 *  negotiated camera FPS was LOWER than what the tracker could actually
 *  deliver, this self-throttle capped free-viewing below its true achievable
 *  rate — which is exactly what we found: FV recorded at a clean 20 Hz
 *  (50ms tick) in one real session, well under the ~30-60 Hz the SAME
 *  camera achieved on the SPEM/SZ tasks in sibling recordings.
 *
 *  This version instead subscribes directly to EyeTracker.onGaze(fn) —
 *  a push callback that already fires exactly once per genuinely NEW
 *  gaze estimate the tracker actually produced (see eye-tracker.js:
 *  `_latestGaze` is mutated in place once per processed camera frame,
 *  and onGaze listeners are invoked at that same point). There is no
 *  separate poll/throttle/dedup layer on top of it, because none is
 *  needed: a push event already IS one genuinely new sample. This is
 *  the same pattern SpemAdapter already used, and that SzTracker (in
 *  battery-controller.js) has now been switched to as well — so all
 *  three tasks are bounded by the same real ceiling (this machine's
 *  actual camera+MediaPipe throughput) instead of three different,
 *  inconsistently-derived polling rates.
 *
 *  DATA STRUCTURE
 *  ──────────────
 *  allImageData[i] = {
 *    imageIndex  : number,
 *    imageName   : string,   // e.g. "5.jpg"
 *    gazeData    : GazePoint[],
 *    sampleCount : number,
 *    avgSamplingFps : number,   // measured from actual samples received
 *    droppedFrames : number     // always 0 now — kept for API compatibility;
 *                                // see getPerformanceStats() for the
 *                                // tracker's own drop/throughput numbers
 *  }
 *
 *  Dependencies:  EyeTracker global (eye-tracker.js)
 *  Exposes:       global const RawGazeCollector
 *
 *  Public API (unchanged from the previous revision)
 *  ──────────
 *  RawGazeCollector.startRecording()         begin recording for current image
 *  RawGazeCollector.stopRecording()          stop recording, return gazeData[]
 *  RawGazeCollector.saveImageData(name)      commit image data, advance index
 *  RawGazeCollector.getAllImageData()         full session dataset
 *  RawGazeCollector.reset()                  clear all state
 *  RawGazeCollector.getCurrentSampleCount()  samples so far for current image
 *  RawGazeCollector.getPerformanceStats()    sampling FPS and frame metrics
 * ============================================================
 */
const RawGazeCollector = (() => {
  let isRecording = false;
  let currentImageGazeData = [];
  let imageStartTime = 0;
  let allImageData = [];
  let currentImageIndex = 0;
  let frameCount = 0;
  let sampledFrames = 0;
  let _gazeHandler = null;

  function onGazeSample(d) {
    if (!isRecording || !d || d.isBlink) return;
    const relativeTime = performance.now() - imageStartTime;
    currentImageGazeData.push({
      x: d.x,
      y: d.y,
      timestamp: relativeTime,
      velocity: d.velocity || 0,
      isBlink: d.isBlink || false,
      confidence: d.confidence || 0,
      frameNumber: frameCount,
    });
    frameCount += 1;
    sampledFrames += 1;
    const el = document.getElementById('exp-samples');
    if (el) el.textContent = `Samples: ${currentImageGazeData.length}`;
  }

  function startRecording() {
    currentImageGazeData = [];
    frameCount = 0;
    sampledFrames = 0;
    imageStartTime = performance.now();
    isRecording = true;
    if (typeof EyeTracker !== 'undefined' && typeof EyeTracker.onGaze === 'function') {
      _gazeHandler = onGazeSample;
      EyeTracker.onGaze(_gazeHandler);
    } else {
      console.warn('[RawGazeCollector] EyeTracker.onGaze unavailable — no samples will be recorded.');
    }
  }

  function stopRecording() {
    isRecording = false;
    if (_gazeHandler && typeof EyeTracker !== 'undefined' && typeof EyeTracker.offGaze === 'function') {
      EyeTracker.offGaze(_gazeHandler);
    }
    _gazeHandler = null;
    return currentImageGazeData;
  }

  function saveImageData(imageName) {
    const durSec = Math.max((performance.now() - imageStartTime) / 1000, 1e-6);
    const actualSamplingFps = sampledFrames > 0 ? sampledFrames / durSec : 0;

    allImageData.push({
      imageIndex: currentImageIndex,
      imageName: imageName,
      gazeData: [...currentImageGazeData],
      sampleCount: currentImageGazeData.length,
      avgSamplingFps: actualSamplingFps.toFixed(2),
      droppedFrames: 0,          // push-based: no local poll drops (see class comment)
      effectiveFrames: sampledFrames,
    });
    currentImageIndex++;
  }

  function getAllImageData() {
    return allImageData;
  }

  function reset() {
    isRecording = false;
    if (_gazeHandler && typeof EyeTracker !== 'undefined' && typeof EyeTracker.offGaze === 'function') {
      EyeTracker.offGaze(_gazeHandler);
    }
    _gazeHandler = null;
    currentImageGazeData = [];
    imageStartTime = 0;
    allImageData = [];
    currentImageIndex = 0;
    frameCount = 0;
    sampledFrames = 0;
  }

  function getCurrentSampleCount() {
    return currentImageGazeData.length;
  }

  function getPerformanceStats() {
    // Surface the tracker's own throughput numbers where available —
    // these are the real ceiling this collector is bounded by, since
    // sampling is now a direct push subscription rather than an
    // independently-throttled poll.
    let trackerStats = null;
    try {
      if (typeof EyeTracker !== 'undefined' && typeof EyeTracker.getPerformanceStats === 'function') {
        trackerStats = EyeTracker.getPerformanceStats();
      }
    } catch (_) {}
    return {
      sampledFrames,
      effectiveDropRate: 'N/A (push-based; see tracker.dropRate for real camera/MediaPipe drops)',
      tracker: trackerStats,
    };
  }

  return {
    startRecording,
    stopRecording,
    saveImageData,
    getAllImageData,
    reset,
    getCurrentSampleCount,
    getPerformanceStats,
  };
})();
