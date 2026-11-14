import ReactECharts from 'echarts-for-react';
import type { CalendarResponse } from '../../../shared/api.ts';
import { anomalyRamp, axisLabel, fireRamp, theme, tooltipStyle } from '../theme.ts';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export type CalendarMode = 'count' | 'anomaly';

type Datum = [
  month: number,
  yearIndex: number,
  value: number | null,
  anomaly: number | null,
  rank: number | null,
  colourKey: number | null,
];

// Count mode colours on log10(1 + value): one record month would otherwise turn every other cell black.
const toLog = (v: number) => Math.log10(1 + v);
const fromLog = (l: number) => 10 ** l - 1;
// Anomaly mode colours on log2(ratio): 0.5x and 2x sit symmetrically around "normal".
const ANOMALY_LIMIT = 3; // +-3 = 1/8x .. 8x
const toLog2 = (r: number) => Math.max(-ANOMALY_LIMIT, Math.min(ANOMALY_LIMIT, Math.log2(Math.max(r, 1 / 2 ** ANOMALY_LIMIT))));

/** Year x month heatmap of harmonized fire activity: absolute counts or the anomaly against the long-term mean. */
interface Props {
  data: CalendarResponse;
  mode?: CalendarMode;
  /** Months overlapping this period get a light outline (the selected period, compared with the rest). */
  highlight?: { from: string | null; to: string | null } | null;
}

export function Calendar({ data, mode = 'count', highlight = null }: Props) {
  const years = [...new Set(data.cells.map((c) => c.year))].sort((a, b) => a - b);
  const maxLog = Math.max(1, ...data.cells.map((c) => toLog(c.value ?? 0)));

  const ym = (d: string | null, fallback: string) => (d ?? fallback).slice(0, 7);
  const inHighlight = (y: number, m: number) => {
    if (!highlight) return false;
    const key = `${y}-${String(m).padStart(2, '0')}`;
    return key >= ym(highlight.from, '0000-00') && key <= ym(highlight.to, '9999-99');
  };

  const colourKey = (value: number | null, anomaly: number | null) => {
    if (mode === 'anomaly') return anomaly === null ? null : toLog2(anomaly);
    return value === null ? null : toLog(value);
  };

  const visualMap =
    mode === 'count'
      ? {
          min: 0,
          max: maxLog,
          inRange: { color: fireRamp },
          formatter: (v: number) => Math.round(fromLog(v)).toString(),
        }
      : {
          min: -ANOMALY_LIMIT,
          max: ANOMALY_LIMIT,
          inRange: { color: anomalyRamp },
          formatter: (v: number) => {
            const r = 2 ** v;
            return r >= 1 ? `${r.toFixed(r >= 2 ? 0 : 1)}x` : `1/${(1 / r).toFixed(0)}x`;
          },
        };

  const option = {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: theme.fontSans },
    tooltip: {
      ...tooltipStyle,
      formatter: (p: { value: Datum }) => {
        const [m, y, value, anomaly, rank] = p.value;
        const head = `<span style="color:${theme.red}">${MONTHS[m]} ${years[y]}</span>`;
        if (value === null) return `${head}<br/>NO DATA FOR THIS METRIC`;
        const ratio = anomaly === null ? 'n/a' : `${anomaly.toFixed(1)}x long-term mean`;
        const place = rank === null ? '' : `<br/>rank ${rank}/${years.length} for ${MONTHS[m]}`;
        return `${head}<br/>${value.toFixed(0)} ${data.unit}<br/>${ratio}${place}`;
      },
    },
    toolbox: {
      right: 4,
      top: 0,
      iconStyle: { borderColor: theme.redDim },
      emphasis: { iconStyle: { borderColor: theme.red } },
      feature: { saveAsImage: { title: 'PNG', name: `burning-calendar-${mode}`, backgroundColor: theme.panel, pixelRatio: 2 } },
    },
    grid: { left: 60, right: 12, top: 38, bottom: 74 },
    xAxis: { type: 'category', data: MONTHS, position: 'top', axisLine: { show: false }, axisTick: { show: false }, axisLabel },
    yAxis: { type: 'category', data: years, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel },
    visualMap: {
      ...visualMap,
      dimension: 5,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 10,
      itemWidth: 12,
      itemHeight: 260,
      textStyle: { color: theme.redDim, fontFamily: theme.fontMono, fontSize: 13 },
      handleStyle: { color: theme.bone, borderColor: theme.panel },
    },
    series: [
      {
        type: 'heatmap',
        data: data.cells.map((c) => {
          const value: Datum = [c.month - 1, years.indexOf(c.year), c.value, c.anomaly, c.rank, colourKey(c.value, c.anomaly)];
          return inHighlight(c.year, c.month) ? { value, itemStyle: { borderColor: theme.bone, borderWidth: 2 } } : { value };
        }),
        itemStyle: { borderColor: theme.panel, borderWidth: 2 },
        emphasis: { itemStyle: { borderColor: theme.bone, borderWidth: 1 } },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: Math.max(380, years.length * 24 + 120) }} notMerge />;
}
