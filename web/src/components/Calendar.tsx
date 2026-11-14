import ReactECharts from 'echarts-for-react';
import type { CalendarResponse } from '../../../shared/api.ts';
import { theme, tooltipStyle } from '../theme.ts';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

type Datum = [
  month: number,
  yearIndex: number,
  value: number | null,
  anomaly: number | null,
  rank: number | null,
  logValue: number | null,
];

// Colour on log10(1 + value): one record month would otherwise turn every other cell black.
const toLog = (v: number) => Math.log10(1 + v);
const fromLog = (l: number) => 10 ** l - 1;

const axisLabel = { color: theme.redDim, fontFamily: theme.fontMono, fontSize: 13 };

/** Year x month heatmap of harmonized fire activity. */
export function Calendar({ data }: { data: CalendarResponse }) {
  const years = [...new Set(data.cells.map((c) => c.year))].sort((a, b) => a - b);
  const maxLog = Math.max(1, ...data.cells.map((c) => toLog(c.value ?? 0)));

  const option = {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: theme.fontSans },
    tooltip: {
      ...tooltipStyle,
      formatter: (p: { data: Datum }) => {
        const [m, y, value, anomaly, rank] = p.data;
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
      feature: { saveAsImage: { title: 'PNG', name: 'burning-calendar', backgroundColor: theme.panel, pixelRatio: 2 } },
    },
    grid: { left: 60, right: 12, top: 38, bottom: 74 },
    xAxis: {
      type: 'category',
      data: MONTHS,
      position: 'top',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel,
    },
    yAxis: {
      type: 'category',
      data: years,
      inverse: true,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel,
    },
    visualMap: {
      dimension: 5,
      min: 0,
      max: maxLog,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 10,
      itemWidth: 12,
      itemHeight: 260,
      textStyle: { color: theme.redDim, fontFamily: theme.fontMono, fontSize: 13 },
      handleStyle: { color: theme.red, borderColor: theme.panel },
      formatter: (v: number) => Math.round(fromLog(v)).toString(),
      inRange: { color: theme.ramp },
    },
    series: [
      {
        type: 'heatmap',
        data: data.cells.map((c): Datum => [
          c.month - 1,
          years.indexOf(c.year),
          c.value,
          c.anomaly,
          c.rank,
          c.value === null ? null : toLog(c.value),
        ]),
        itemStyle: { borderColor: theme.panel, borderWidth: 2 },
        emphasis: { itemStyle: { borderColor: theme.bone, borderWidth: 1 } },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: Math.max(380, years.length * 24 + 120) }} notMerge />;
}
