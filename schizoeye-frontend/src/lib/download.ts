import { sessionPdfUrl } from '../api/sessions.ts';

/** Same technique as the original downloadSessionPDF(): a temporary <a download> click; Flask sets Content-Disposition. */
export function downloadSessionPdf(sessionId: string): void {
  const a = document.createElement('a');
  a.href = sessionPdfUrl(sessionId);
  a.download = `report_${sessionId}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
