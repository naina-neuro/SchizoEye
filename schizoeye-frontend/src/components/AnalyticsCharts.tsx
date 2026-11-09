import { useEffect, useRef } from 'react';
import { Chart, registerables } from 'chart.js';
import { AGE_BIN_LABELS, PANSS_BIN_LABELS, ageBins, panssBins } from '../lib/analytics.ts';
import type { AnalyticsData } from '../types/session.ts';

Chart.register(...registerables);

const barOptions = { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } };

/** The four analytics charts (daily sessions, PANSS histogram, gender doughnut, age histogram) — same data/colours as the original. */
export function AnalyticsCharts({ data }: { data: AnalyticsData }) {
  const daily = useRef<HTMLCanvasElement>(null);
  const panss = useRef<HTMLCanvasElement>(null);
  const gender = useRef<HTMLCanvasElement>(null);
  const age = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const charts: Chart[] = [];
    const dailyData = data.daily_counts || [];
    if (dailyData.length && daily.current) {
      charts.push(new Chart(daily.current, {
        type: 'bar',
        data: { labels: dailyData.map((x) => x.date.slice(5)), datasets: [{ label: 'Sessions', data: dailyData.map((x) => x.count), backgroundColor: 'rgba(26,90,148,0.7)', borderColor: '#1A5A94', borderWidth: 1 }] },
        options: barOptions,
      }));
    }
    const panssData = data.panss_distribution || [];
    if (panssData.length && panss.current) {
      charts.push(new Chart(panss.current, {
        type: 'bar',
        data: { labels: PANSS_BIN_LABELS, datasets: [{ label: 'Patients', data: panssBins(panssData), backgroundColor: 'rgba(139,90,168,0.7)', borderColor: '#8b5aa8', borderWidth: 1 }] },
        options: barOptions,
      }));
    }
    const gd = data.gender_distribution || {};
    if (Object.keys(gd).length && gender.current) {
      charts.push(new Chart(gender.current, {
        type: 'doughnut',
        data: { labels: Object.keys(gd), datasets: [{ data: Object.values(gd), backgroundColor: ['rgba(26,90,148,0.8)', 'rgba(231,76,60,0.8)', 'rgba(46,204,113,0.8)', 'rgba(241,196,15,0.8)'] }] },
        options: { responsive: true, plugins: { legend: { position: 'right' } } },
      }));
    }
    const ages = data.age_distribution || [];
    if (ages.length && age.current) {
      charts.push(new Chart(age.current, {
        type: 'bar',
        data: { labels: AGE_BIN_LABELS, datasets: [{ label: 'Patients', data: ageBins(ages), backgroundColor: 'rgba(26,148,100,0.7)', borderColor: '#1a9464', borderWidth: 1 }] },
        options: barOptions,
      }));
    }
    return () => charts.forEach((c) => c.destroy()); // required: StrictMode and re-renders must not leak charts
  }, [data]);

  const card = (title: string, ref: typeof daily, id: string) => (
    <div className="chart-card">
      <div className="chart-title">{title}</div>
      <canvas id={id} ref={ref} height={180} />
    </div>
  );
  return (
    <>
      <div className="chart-grid">
        {card('📅 Sessions Per Day (Last 30 Days)', daily, 'chart-daily')}
        {card('📊 PANSS Score Distribution', panss, 'chart-panss')}
      </div>
      <div className="chart-grid">
        {card('👤 Gender Distribution', gender, 'chart-gender')}
        {card('🎂 Age Distribution', age, 'chart-age')}
      </div>
    </>
  );
}
