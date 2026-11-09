/** Static assessment page. Same-window redirect rules for ?mode=test live in index.html's inline script. */
export const TEST_PAGE_URL = '/battery.html?mode=test';

/**
 * Open the assessment in a new tab, like the original window.open(... '?mode=test', '_blank').
 * Deliberately NOT noopener: the page posts OCULOMOTOR_ASSESSMENT_COMPLETE to window.opener and closes itself afterwards.
 */
export function launchTest(): void {
  window.open(TEST_PAGE_URL, '_blank');
}
