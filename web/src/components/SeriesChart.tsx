import ReactECharts from 'echarts-for-react';
import type { SeriesResponse } from '../../../shared/api.ts';
import { axisLabel, dataColors, theme, tooltipStyle } from '../theme.ts';

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * "Does the sensor still matter?" Harmonized total per year next to the MODIS-only and VIIRS-only estimates
 * of the same quantity, with raw detections (not comparable across years) on their own axis.
 */
export function SeriesChart({ data }: { data: SeriesResponse }) {
  const years = data.points.map((p) => String(p.year));
  const line = (name: string, values: (number | null)[], color: string, type: 'solid' | 'dashed' | 'dotted', width = 2) => ({
    name,
    type: 'line',
    data: values,
    yAxisIndex: 0,
    symbol: 'circle',
    symbolSize: 5,
    connectNulls: false,
    lineStyle: { color, width, type },
    itemStyle: { color },
  });

  const option = {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: theme.fontSans },
    tooltip: { trigger: 'axis', ...tooltipStyle, valueFormatter: (v: number | null) => (v == null ? 'n/a' : nf.format(v)) },
    legend: {
      top: 4,
      itemGap: 24,
      itemWidth: 16,
      itemHeight: 8,
      textStyle: { color: theme.bone, fontFamily: theme.fontSans, fontSize: 13 },
    },
    toolbox: {
      right: 4,
      top: 2,
      iconStyle: { borderColor: theme.redDim },
      feature: { saveAsImage: { title: 'PNG', name: 'harmonized-vs-raw', backgroundColor: theme.panel, pixelRatio: 2 } },
    },
    grid: { left: 64, right: 72, top: 64, bottom: 36 },
    xAxis: {
      type: 'category',
      data: years,
      axisLine: { lineStyle: { color: theme.grid } },
      axisTick: { show: false },
      axisLabel,
    },
    yAxis: [
      {
        type: 'value',
        name: data.unit.toUpperCase(),
        nameTextStyle: { ...axisLabel, align: 'left', fontSize: 11 },
        splitLine: { lineStyle: { color: theme.grid } },
        axisLabel: { ...axisLabel, formatter: (v: number) => nf.format(v) },
      },
      {
        type: 'value',
        name: 'RAW DETECTIONS',
        nameTextStyle: { ...axisLabel, color: dataColors.raw, align: 'right', fontSize: 11 },
        splitLine: { show: false },
        axisLabel: { ...axisLabel, color: dataColors.raw, formatter: (v: number) => nf.format(v) },
      },
    ],
    series: [
      {
        name: 'Raw detections',
        type: 'bar',
        yAxisIndex: 1,
        data: data.points.map((p) => p.nModis + p.nViirs),
        barMaxWidth: 18,
        itemStyle: { color: 'rgba(163, 154, 156, 0.22)', borderColor: dataColors.raw, borderWidth: 1, borderType: 'dashed' },
      },
      line('MODIS only', data.points.map((p) => p.hModis), dataColors.modis, 'solid'),
      line('VIIRS only', data.points.map((p) => p.hViirs), dataColors.viirs, 'dashed'),
      line('Harmonized', data.points.map((p) => p.h), dataColors.harmonized, 'solid', 3),
    ],
  };

  return <ReactECharts option={option} style={{ height: 340 }} notMerge />;
}
