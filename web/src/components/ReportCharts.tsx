import ReactECharts from 'echarts-for-react';
import type { ReportResponse, SeriesResponse } from '../../../shared/api.ts';
import { axisLabel, dataColors, theme, tooltipStyle } from '../theme.ts';

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const TYPES: { type: number; name: string; color: string }[] = [
  { type: 0, name: 'Vegetation fire (kept)', color: dataColors.harmonized },
  { type: 2, name: 'Static source (industry)', color: theme.bone },
  { type: 1, name: 'Volcano', color: dataColors.location },
  { type: 3, name: 'Offshore', color: dataColors.viirs },
];

function base(years: string[], name: string) {
  return {
    backgroundColor: 'transparent',
    animation: false,
    textStyle: { fontFamily: theme.fontSans },
    tooltip: { trigger: 'axis', ...tooltipStyle, valueFormatter: (v: number | null) => (v == null ? 'n/a' : nf.format(v)) },
    legend: { top: 4, itemGap: 22, itemWidth: 14, itemHeight: 8, textStyle: { color: theme.bone, fontFamily: theme.fontSans, fontSize: 13 } },
    toolbox: {
      right: 4,
      top: 2,
      iconStyle: { borderColor: theme.redDim },
      feature: { saveAsImage: { title: 'PNG', name, backgroundColor: theme.panel, pixelRatio: 2 } },
    },
    grid: { left: 64, right: 20, top: 56, bottom: 32 },
    xAxis: { type: 'category', data: years, axisLine: { lineStyle: { color: theme.grid } }, axisTick: { show: false }, axisLabel },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: theme.grid } }, axisLabel: { ...axisLabel, formatter: (v: number) => nf.format(v) } },
  };
}

/** The ETL report ("npm run etl:report") as live charts for the selected region. */
export function ReportCharts({ report, series }: { report: ReportResponse; series: SeriesResponse | null }) {
  const years = [...new Set([...report.rawBySatellite.map((r) => r.year), ...report.byType.map((r) => r.year)])].sort((a, b) => a - b);
  const labels = years.map(String);
  const sum = <T extends { year: number; n: number }>(rows: T[], y: number, pick: (r: T) => boolean) =>
    rows.filter((r) => r.year === y && pick(r)).reduce((a, r) => a + r.n, 0);

  // 1. Before: raw detections per satellite (stacked)
  const satellites = [...new Set(report.rawBySatellite.map((r) => r.satellite))];
  const rawOption = {
    ...base(labels, 'raw-by-satellite'),
    series: satellites.map((s) => ({
      name: s,
      type: 'bar',
      stack: 'raw',
      barMaxWidth: 22,
      itemStyle: { color: dataColors.satellites[s] ?? dataColors.raw, borderColor: theme.panel, borderWidth: 1 },
      data: years.map((y) => sum(report.rawBySatellite, y, (r) => r.satellite === s)),
    })),
  };

  // 2. What the type filter removes
  const typeOption = {
    ...base(labels, 'type-filter'),
    series: TYPES.filter((t) => report.byType.some((r) => r.type === t.type)).map((t) => ({
      name: t.name,
      type: 'bar',
      stack: 'type',
      barMaxWidth: 22,
      itemStyle: { color: t.color, borderColor: theme.panel, borderWidth: 1 },
      data: years.map((y) => sum(report.byType, y, (r) => r.type === t.type)),
    })),
  };

  // 3. Before / after: index, mean of the years before VIIRS = 100
  let indexOption: object | null = null;
  if (series?.points.length) {
    const firstViirs = Math.min(...series.points.filter((p) => p.hViirs !== null).map((p) => p.year), 9999);
    const baseYears = series.points.filter((p) => p.year < firstViirs);
    const ref = baseYears.length ? baseYears : series.points;
    const mean = (key: (p: (typeof ref)[number]) => number) => ref.reduce((a, p) => a + key(p), 0) / ref.length;
    const rawOf = (p: (typeof ref)[number]) => p.nModis + p.nViirs;
    const mRaw = mean(rawOf);
    const mH = mean((p) => p.h);
    const idxLabels = series.points.map((p) => String(p.year));
    indexOption = {
      ...base(idxLabels, 'before-after-index'),
      tooltip: { trigger: 'axis', ...tooltipStyle, valueFormatter: (v: number | null) => (v == null ? 'n/a' : v.toFixed(0)) },
      series: [
        {
          name: 'Raw detections',
          type: 'line',
          symbol: 'none',
          lineStyle: { color: dataColors.raw, width: 2, type: 'dashed' },
          itemStyle: { color: dataColors.raw },
          data: series.points.map((p) => (mRaw ? Math.round((100 * rawOf(p)) / mRaw) : null)),
        },
        {
          name: 'Harmonized',
          type: 'line',
          symbol: 'none',
          lineStyle: { color: dataColors.harmonized, width: 3 },
          itemStyle: { color: dataColors.harmonized },
          data: series.points.map((p) => (mH ? Math.round((100 * p.h) / mH) : null)),
        },
      ],
      markLine: undefined,
    };
  }

  // Calibration table: satellite x FRP class
  const edges = report.frpEdges;
  const classLabels = [`< ${edges[0]}`, ...edges.map((e, i) => (i + 1 < edges.length ? `${e}–${edges[i + 1]}` : `≥ ${e}`))];
  const ORDER = ['Terra', 'Aqua', 'S-NPP', 'NOAA-20', 'NOAA-21'];
  const calSats = [...new Set(report.calibration.map((r) => r.satellite))].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));

  const total = report.byType.reduce((a, r) => a + r.n, 0);
  const dropped = report.byType.filter((r) => r.type !== 0).reduce((a, r) => a + r.n, 0);

  return (
    <div className="report">
      <div className="report-kpis">
        <div className="stat">
          <span className="label dim">All detections</span>
          <b className="mono" style={{ color: dataColors.raw }}>
            {nf.format(total)}
          </b>
        </div>
        <div className="stat">
          <span className="label dim">Removed by type filter</span>
          <b className="mono">{total ? `${((100 * dropped) / total).toFixed(1)}%` : '--'}</b>
        </div>
        <div className="stat">
          <span className="label dim">Satellites</span>
          <b className="mono">{satellites.length}</b>
        </div>
      </div>

      <h3 className="report-title">Before: raw detections per satellite</h3>
      <p className="section-note">Every new satellite (S-NPP in 2012, NOAA-20 in 2018) raises the counts, although fires do not increase.</p>
      <div className="chart-box">
        <ReactECharts option={rawOption} style={{ height: 300 }} notMerge />
      </div>

      <h3 className="report-title">What the type filter removes</h3>
      <p className="section-note">Only vegetation fires (type 0) reach the calendar. Static sources such as refineries and steel works, volcanoes and offshore flares are dropped.</p>
      <div className="chart-box">
        <ReactECharts option={typeOption} style={{ height: 300 }} notMerge />
      </div>

      {indexOption && (
        <>
          <h3 className="report-title">Before and after harmonization</h3>
          <p className="section-note">Index: mean of the years before VIIRS = 100. The raw series jumps with each new satellite; the harmonized one stays comparable.</p>
          <div className="chart-box">
            <ReactECharts option={indexOption} style={{ height: 300 }} notMerge />
          </div>
        </>
      )}

      {calSats.length > 0 && (
        <>
          <h3 className="report-title">Calibration factors k</h3>
          <p className="section-note">
            Fire cell-days a satellite sees per cell-day of MODIS {report.reference}, by fire size (summed FRP in the cell, MW). Small fires are
            seen almost only by VIIRS, so k is large there.
          </p>
          <div className="table-wrap">
            <table className="k-table">
              <thead>
                <tr>
                  <th>Satellite</th>
                  {classLabels.map((c) => (
                    <th key={c}>{c} MW</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {calSats.map((s) => (
                  <tr key={s}>
                    <td>
                      <span className="layer-swatch" style={{ background: dataColors.satellites[s] ?? dataColors.raw }} /> {s}
                    </td>
                    {classLabels.map((_, c) => {
                      const r = report.calibration.find((x) => x.satellite === s && x.cls === c);
                      return <td key={c}>{r ? r.k.toFixed(2) : '–'}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
