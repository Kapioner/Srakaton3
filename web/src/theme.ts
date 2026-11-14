// Visual tokens for code that cannot read CSS variables (ECharts, MapLibre paint).
// Keep in sync with :root in index.css and with the palette in etl/src/report.template.html.
//
// House style: signal red on near-black, uppercase grotesk + mono labels.
// Red is the brand and the "harmonized" series. Everything else that carries data gets its own hue,
// picked to stay apart on a dark background and for the common colour-vision deficiencies
// (red/amber/sky/teal/violet differ in lightness as well as hue, and lines also differ by dash).

export const theme = {
  red: '#f91133',
  /** Secondary text: solid, lighter red (about 6:1 on the panel) so small labels stay readable. */
  redDim: '#ff5c70',
  redFaint: 'rgba(249, 17, 51, 0.18)',
  panel: '#100e0f',
  panel2: '#171314',
  ink: '#f91133',
  bone: '#efe9ea',
  /** Neutral text for long copy and numbers inside data views. */
  fog: '#b8adb0',
  grid: 'rgba(239, 233, 234, 0.08)',
  fontSans: "'Space Grotesk', system-ui, sans-serif",
  fontMono: "'Space Mono', ui-monospace, monospace",
};

/** Categorical data colours. One meaning per colour across the whole app and the ETL report. */
export const dataColors = {
  harmonized: '#f91133', // h: the final series (brand red)
  modis: '#ffb020', // amber: MODIS family
  viirs: '#4cc9f0', // sky: VIIRS family
  raw: '#a39a9c', // warm grey: raw, not comparable counts (always dashed)
  location: '#b18cff', // violet: user watch locations on the map
  ok: '#2ec4a0', // teal: status OK
  warn: '#ffb020', // amber: status warning / fixtures
  satellites: {
    Terra: '#ffb020', // MODIS -> amber shades
    Aqua: '#ffd27a',
    'S-NPP': '#4cc9f0', // VIIRS -> sky/teal shades
    'NOAA-20': '#2ec4a0',
    'NOAA-21': '#9be7ff',
  } as Record<string, string>,
};

/**
 * Sequential "fire" ramp for counts (calendar, map grid): near-black -> wine -> red -> orange -> amber -> pale gold.
 * Lightness rises monotonically like inferno/magma, so it reads in greyscale and for colour-blind viewers,
 * and there are many more distinguishable steps than with a single red hue.
 */
export const fireRamp = ['#1d1718', '#3a1029', '#6b1238', '#a8133a', '#f91133', '#ff6a2b', '#ffb020', '#ffe7a3'];

/** Diverging ramp for anomaly vs long-term mean: below normal (sky) -> normal (dark) -> above normal (red/gold). */
export const anomalyRamp = ['#4cc9f0', '#1f5d70', '#2a2426', '#a8133a', '#f91133', '#ffb020'];

/** Base ECharts tooltip in the house style. */
export const tooltipStyle = {
  backgroundColor: theme.panel,
  borderColor: theme.red,
  borderWidth: 1,
  padding: [8, 10],
  textStyle: { color: theme.bone, fontFamily: theme.fontMono, fontSize: 13 },
  extraCssText: 'border-radius:0;box-shadow:none;',
};

/** Axis label style for ECharts. */
export const axisLabel = { color: theme.redDim, fontFamily: theme.fontMono, fontSize: 13 };
