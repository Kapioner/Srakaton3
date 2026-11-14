import ReactECharts from 'echarts-for-react';
import type { CalendarResponse } from '../../../shared/api.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Datum = [month: number, yearIndex: number, value: number | null, anomaly: number | null, rank: number | null];

/** Year x month heatmap of harmonized fire activity. */
export function Calendar({ data }: { data: CalendarResponse }) {
  const years = [...new Set(data.cells.map((c) => c.year))].sort((a, b) => a - b);
  const max = Math.max(1, ...data.cells.map((c) => c.value ?? 0));

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      formatter: (p: { data: Datum }) => {
        const [m, y, value, anomaly, rank] = p.data;
        if (value === null) return `<b>${MONTHS[m]} ${years[y]}</b><br/>no data for this metric`;
        const ratio = anomaly === null ? 'n/a' : `${anomaly.toFixed(1)}x the long-term mean`;
        const place = rank === null ? '' : `<br/>rank ${rank} of ${years.length} for ${MONTHS[m]}`;
        return `<b>${MONTHS[m]} ${years[y]}</b><br/>${value.toFixed(0)} ${data.unit}<br/>${ratio}${place}`;
      },
    },
    toolbox: { feature: { saveAsImage: { title: 'Save PNG', name: 'burning-calendar', backgroundColor: '#171c22' } } },
    grid: { left: 48, right: 16, top: 36, bottom: 64 },
    xAxis: { type: 'category', data: MONTHS, splitArea: { show: true }, axisLabel: { color: '#8b96a5' } },
    yAxis: { type: 'category', data: years, inverse: true, axisLabel: { color: '#8b96a5' } },
    visualMap: {
      // Colour by `value`; without this ECharts uses the last data dimension (rank).
      dimension: 2,
      min: 0,
      max,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 8,
      textStyle: { color: '#8b96a5' },
      // YlOrRd: sequential and colorblind-safe.
      inRange: { color: ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#b10026'] },
    },
    series: [
      {
        type: 'heatmap',
        data: data.cells.map((c): Datum => [c.month - 1, years.indexOf(c.year), c.value, c.anomaly, c.rank]),
        itemStyle: { borderColor: '#171c22', borderWidth: 1 },
        emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1 } },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: Math.max(360, years.length * 22 + 110) }} notMerge />;
}
