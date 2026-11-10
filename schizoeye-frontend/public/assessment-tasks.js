import { EyeTracker } from './eye-tracker.js';

/**
 * Collects time-relative gaze samples during each free-viewing image.
 * The controller owns task timing; this module owns only the samples and counters.
 */
export const RawGazeCollector = (() => {
  let isRecording = false;
  let currentImageGazeData = [];
  let imageStartTime = 0;
  let allImageData = [];
  let currentImageIndex = 0;
  let frameCount = 0;
  let sampledFrames = 0;
  let gazeHandler = null;

  /** Function 1: Store one valid gaze event while the current image is recording. */
  function onGazeSample(data) {
    if (!isRecording || !data || data.isBlink) return;
    const relativeTime = performance.now() - imageStartTime;
    currentImageGazeData.push({
      x: data.x,
      y: data.y,
      timestamp: relativeTime,
      velocity: data.velocity || 0,
      isBlink: data.isBlink || false,
      confidence: data.confidence || 0,
      frameNumber: frameCount,
    });
    frameCount += 1;
    sampledFrames += 1;
    const sampleLabel = document.getElementById('exp-samples');
    if (sampleLabel) sampleLabel.textContent = `Samples: ${currentImageGazeData.length}`;
  }

  /** Function 2: Start a fresh per-image recording and subscribe to EyeTracker. */
  function startRecording() {
    currentImageGazeData = [];
    frameCount = 0;
    sampledFrames = 0;
    imageStartTime = performance.now();
    isRecording = true;
    gazeHandler = onGazeSample;
    EyeTracker.onGaze(gazeHandler);
  }

  /** Function 3: Unsubscribe safely and return the samples for the current image. */
  function stopRecording() {
    isRecording = false;
    if (gazeHandler) EyeTracker.offGaze(gazeHandler);
    gazeHandler = null;
    return currentImageGazeData;
  }

  /** Function 4: Save the current image record and advance its stable image index. */
  function saveImageData(imageName) {
    const durationSeconds = Math.max((performance.now() - imageStartTime) / 1000, 1e-6);
    const samplingFps = sampledFrames > 0 ? sampledFrames / durationSeconds : 0;
    allImageData.push({
      imageIndex: currentImageIndex,
      imageName,
      gazeData: [...currentImageGazeData],
      sampleCount: currentImageGazeData.length,
      avgSamplingFps: samplingFps.toFixed(2),
      droppedFrames: 0,
      effectiveFrames: sampledFrames,
    });
    currentImageIndex += 1;
  }

  /** Function 5: Return the records saved for all viewed images. */
  function getAllImageData() {
    return allImageData;
  }

  /** Function 6: Remove the gaze listener and reset all session-level counters. */
  function reset() {
    isRecording = false;
    if (gazeHandler) EyeTracker.offGaze(gazeHandler);
    gazeHandler = null;
    currentImageGazeData = [];
    imageStartTime = 0;
    allImageData = [];
    currentImageIndex = 0;
    frameCount = 0;
    sampledFrames = 0;
  }

  /** Function 7: Report the current image's sample count to task controls. */
  function getCurrentSampleCount() {
    return currentImageGazeData.length;
  }

  /** Function 8: Combine collector counters with EyeTracker throughput diagnostics. */
  function getPerformanceStats() {
    let trackerStats = null;
    try {
      trackerStats = EyeTracker.getPerformanceStats();
    } catch (error) {
      console.warn('[RawGazeCollector] Could not read EyeTracker performance statistics.', error);
    }
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

// Inline task handlers and older embedding pages still access this name on window.
window.RawGazeCollector = RawGazeCollector;
