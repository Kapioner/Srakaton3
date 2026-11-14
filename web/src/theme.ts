// Visual tokens shared by CSS-in-JS consumers (ECharts). Keep in sync with :root in index.css.
// Style: one signal red on near-black, uppercase grotesk + mono labels (control-room / surveillance look).

export const theme = {
  red: '#f91133',
  // Secondary text: solid, lighter red (about 6:1 on the panel) so small labels stay readable.
  redDim: '#ff5c70',
  redFaint: 'rgba(249, 17, 51, 0.18)',
  panel: '#100e0f',
  panel2: '#171314',
  ink: '#f91133',
  bone: '#efe9ea',
  fontSans: "'Space Grotesk', system-ui, sans-serif",
  fontMono: "'Space Mono', ui-monospace, monospace",
  /**
   * Sequential single-hue ramp, black -> red -> pale pink. Lightness rises monotonically,
   * so the order stays readable for colour-blind viewers and in greyscale.
   */
  ramp: ['#1d1718', '#3d0c14', '#6e0d1d', '#a80f28', '#f91133', '#ff6b7d', '#ffc4cc'],
};

/** Base ECharts tooltip in the house style. */
export const tooltipStyle = {
  backgroundColor: theme.panel,
  borderColor: theme.red,
  borderWidth: 1,
  padding: [8, 10],
  textStyle: { color: theme.bone, fontFamily: theme.fontMono, fontSize: 13 },
  extraCssText: 'border-radius:0;box-shadow:none;',
};
