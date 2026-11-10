import { ApiService } from './api-service.js';

/** Function 1: Convert a Plotly graph to a PNG data URL for PDF inclusion. */
export async function getPlotlyImage(divId) {
  const element = document.getElementById(divId);
  if (!element) return '';
  try {
    return await Plotly.toImage(divId, { format: 'png', width: 900, height: 350 });
  } catch (error) {
    console.warn(`[ReportManager] Could not capture Plotly graph "${divId}".`, error);
    return '';
  }
}

/**
 * Function 2: Capture and download reports without owning assessment state.
 * The controller supplies a snapshot so report rendering cannot mutate task state.
 */
export function createReportManager(getSessionSnapshot) {
  /** Function 3: Build the unchanged report payload and download Flask's PDF response. */
  async function downloadPDFReport() {
    const button = document.getElementById('btn-dl-pdf');
    if (!button) throw new Error('PDF download button is missing from the assessment page.');
    const oldText = button.textContent;
    button.textContent = '⏳ Generating PDF...';
    button.disabled = true;

    try {
      const session = getSessionSnapshot();
      const fixPureCanvas = document.getElementById('cFP');
      const fixDistCanvas = document.getElementById('cFD');
      const [hs4Image, ls2Image, ls4Image] = await Promise.all([
        getPlotlyImage('spem-graph-Horizontal_0.4Hz'),
        getPlotlyImage('spem-graph-Lissajous_0.2Hz'),
        getPlotlyImage('spem-graph-Lissajous_0.4Hz'),
      ]);
      const resultPanss = document.getElementById('results-panss-score');
      const enteredPanss = resultPanss ? resultPanss.value.trim() : '';
      const payload = {
        patient: {
          id: session.subjectId,
          name: session.patientName || session.subjectId,
          age_sex: [session.patientAge, session.patientSex].filter(Boolean).join(' / ') || 'Unknown',
          date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
        },
        panss_score: enteredPanss ? parseFloat(enteredPanss) : (session.panssScore ? parseFloat(session.panssScore) : null),
        metrics: session.features,
        prediction: session.prediction,
        images: {
          heatmap: '',
          spem_hs4: hs4Image,
          spem_ls2: ls2Image,
          spem_ls4: ls4Image,
          fix_pure: fixPureCanvas ? fixPureCanvas.toDataURL('image/png') : '',
          fix_dist: fixDistCanvas ? fixDistCanvas.toDataURL('image/png') : '',
        },
        fv_gaze: session.freeViewingGaze,
      };

      const response = await ApiService.generateReport(payload);
      if (!response.ok) throw new Error(`PDF generation failed (HTTP ${response.status}).`);
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `Oculomotor_Report_${session.subjectId}.pdf`;
      document.body.appendChild(link);
      link.click();
      window.URL.revokeObjectURL(objectUrl);
      link.remove();
    } catch (error) {
      window.alert(`Failed to generate PDF report: ${error.message}`);
    } finally {
      button.textContent = oldText;
      button.disabled = false;
    }
  }

  return { downloadPDFReport };
}
