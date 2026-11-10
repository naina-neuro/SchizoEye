const API_BASE = typeof window.getApiBase === 'function'
  ? window.getApiBase()
  : (window.SCHIZOEYE_API_BASE || 'https://schizoeyeclassification.onrender.com')
    .replace(/\/$/, '');
const NORMALIZED_API_BASE = API_BASE.replace(/\/$/, '');
const TEST_TOKEN = new URLSearchParams(window.location.search).get('token');

/** Function 1: Add the assessment's optional integration token without changing cookie auth. */
function requestHeaders(includeJsonContentType) {
  const headers = {};
  if (includeJsonContentType) headers['Content-Type'] = 'application/json';
  if (TEST_TOKEN) headers['X-Test-Token'] = TEST_TOKEN;
  return headers;
}

/** Function 2: Send the existing 59-feature classification request to Flask. */
async function classifyFeatures(features) {
  return fetch(`${NORMALIZED_API_BASE}/classify`, {
    method: 'POST',
    headers: requestHeaders(true),
    credentials: 'include',
    body: JSON.stringify({ features }),
  });
}

/** Function 3: Persist the existing assessment payload at the unchanged save endpoint. */
async function saveResults(payload) {
  return fetch(`${NORMALIZED_API_BASE}/save_results`, {
    method: 'POST',
    headers: requestHeaders(true),
    credentials: 'include',
    body: JSON.stringify(payload),
  });
}

/** Function 4: Request a generated PDF using the existing report contract. */
async function generateReport(payload) {
  return fetch(`${NORMALIZED_API_BASE}/generate-report`, {
    method: 'POST',
    headers: requestHeaders(true),
    credentials: 'include',
    body: JSON.stringify(payload),
  });
}

/** Function 5: Retrieve a saved report while retaining credentials and the test token. */
async function getPdf(reportPath) {
  return fetch(`${NORMALIZED_API_BASE}${reportPath}`, {
    headers: requestHeaders(false),
    credentials: 'include',
  });
}

export const ApiService = Object.freeze({
  baseUrl: NORMALIZED_API_BASE,
  classifyFeatures,
  saveResults,
  generateReport,
  getPdf,
});
