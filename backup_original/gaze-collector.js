/**
 * Collects gaze samples for each image in the Free Viewing task.
 * Subscribes to EyeTracker events and exposes session data and sampling metrics.
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

  /** Record a gaze sample for the current image when recording is active. */
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

  /** Begin collecting gaze samples for the current image. */
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

  /** Stop collecting samples and return the current image's gaze data. */
  function stopRecording() {
    isRecording = false;
    if (_gazeHandler && typeof EyeTracker !== 'undefined' && typeof EyeTracker.offGaze === 'function') {
      EyeTracker.offGaze(_gazeHandler);
    }
    _gazeHandler = null;
    return currentImageGazeData;
  }

  /** Save the current image's samples and advance the image index. */
  function saveImageData(imageName) {
    const durSec = Math.max((performance.now() - imageStartTime) / 1000, 1e-6);
    const actualSamplingFps = sampledFrames > 0 ? sampledFrames / durSec : 0;

    allImageData.push({
      imageIndex: currentImageIndex,
      imageName: imageName,
      gazeData: [...currentImageGazeData],
      sampleCount: currentImageGazeData.length,
      avgSamplingFps: actualSamplingFps.toFixed(2),
      droppedFrames: 0,
      effectiveFrames: sampledFrames,
    });
    currentImageIndex++;
  }

  /** Return gaze data saved for all images in this session. */
  function getAllImageData() {
    return allImageData;
  }

  /** Clear recording state and all collected image data. */
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

  /** Return the number of samples collected for the current image. */
  function getCurrentSampleCount() {
    return currentImageGazeData.length;
  }

  /** Return collector and EyeTracker throughput statistics. */
  function getPerformanceStats() {
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
