import { BatteryController } from './battery-controller.js';
import { EyeTracker } from './eye-tracker.js';
import { RawGazeCollector } from './assessment-tasks.js';

const clientDiagnostics = [];

/** Function 1: Record an error in the on-page diagnostics panel and browser console. */
function reportClientError(stage, error, details) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
  const line = `[${new Date().toISOString()}] ${stage}: ${message}${details ? `\n${details}` : ''}${stack}`;
  clientDiagnostics.push(line);
  const panel = document.getElementById('client-debug-panel');
  const log = document.getElementById('client-debug-log');
  if (log) log.textContent = clientDiagnostics.join('\n\n');
  if (panel) panel.style.display = 'block';
  console.error(line);
}

/** Function 2: Copy diagnostics for a user to share during troubleshooting. */
async function copyClientDiagnostics() {
  const text = clientDiagnostics.join('\n\n') || 'No client errors recorded.';
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    console.warn('[diagnostics] Clipboard access failed; showing the manual-copy dialog.', error);
    window.prompt('Copy diagnostics:', text);
  }
}

/** Function 3: Write a timestamped trace for camera and assessment debugging. */
function testDiag(message, extra) {
  const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
  if (extra !== undefined) console.log(`[TestDiag ${timestamp}] ${message}`, extra);
  else console.log(`[TestDiag ${timestamp}] ${message}`);
}

/** Function 4: Forward uncaught browser errors to the visible diagnostics panel. */
function onWindowError(event) {
  reportClientError('window error', event.error || event.message, `${event.filename || ''}:${event.lineno || ''}`);
}

/** Function 5: Record rejected promises without hiding their original reason. */
function onUnhandledRejection(event) {
  const reason = event.reason;
  const message = reason && reason.message ? reason.message : String(reason);
  testDiag(`unhandled promise rejection: ${message}`, reason);
  reportClientError('unhandled promise', reason);
}

/** Function 6: Route standalone visits to React and start embedded assessment visits. */
function initializeBattery() {
  const urlParams = new URLSearchParams(window.location.search);
  const testToken = urlParams.get('token');
  const externalTestMode = urlParams.get('mode') === 'test' || Boolean(testToken) || window.parent !== window;
  if (!externalTestMode) {
    window.location.replace('/');
    return;
  }
  document.body.classList.add('headless-mode');
  showBatteryIntro();
}

/** Function 7: Return to the React dashboard after an assessment. */
function showRoleDashboard() {
  window.location.href = '/';
}

/** Function 8: Show the assessment introduction screen. */
function showBatteryIntro() {
  const intro = document.getElementById('battery-intro');
  if (!intro) return;
  intro.classList.remove('protocol-started');
  intro.style.display = 'block';
}

/** Function 9: Leave results and return to the dashboard or embedded-test tab. */
function returnToDashboard() {
  const results = document.getElementById('results-screen');
  const returnWrap = document.getElementById('return-to-dashboard-wrap');
  if (results) results.style.display = 'none';
  if (returnWrap) returnWrap.style.display = 'none';

  const saveButton = document.getElementById('btn-save-session');
  if (saveButton) {
    saveButton.disabled = false;
    saveButton.textContent = '💾 Save Session to Database';
    saveButton.style.opacity = '1';
  }

  if (new URLSearchParams(window.location.search).get('mode') === 'test') {
    if (window.confirm('Return to the dashboard tab? This tab will close.')) {
      window.close();
    } else {
      showBatteryIntro();
    }
    return;
  }
  showRoleDashboard();
}

/** Function 10: Update the notes-author label when the host supplies a user name. */
function updateNotesAuthor() {
  const label = document.getElementById('notes-author-label');
  if (label && window._currentUser) {
    label.textContent = `— author: ${window._currentUser}`;
    return;
  }
  window.setTimeout(updateNotesAuthor, 500);
}

window.BatteryController = BatteryController;
window.EyeTracker = EyeTracker;
window.RawGazeCollector = RawGazeCollector;
window.reportClientError = reportClientError;
window.copyClientDiagnostics = copyClientDiagnostics;
window.TestDiag = testDiag;
window.showRoleDashboard = showRoleDashboard;
window.showBatteryIntro = showBatteryIntro;
window.returnToDashboard = returnToDashboard;

window.addEventListener('error', onWindowError);
window.addEventListener('unhandledrejection', onUnhandledRejection);
window.addEventListener('DOMContentLoaded', initializeBattery);
window.addEventListener('DOMContentLoaded', updateNotesAuthor);
