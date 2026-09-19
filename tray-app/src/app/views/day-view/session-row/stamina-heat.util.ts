// Stamina heat ramp — the session's temperature. A white-hot maximum cools
// through peach and quartz and lands exactly on the frozen badge's own frost
// (#a9c9f2, its dendrites): the end of the scale IS the ice chip. No red (that
// colour belongs to the pause action alone) and no green (it never read as
// "hot" — the ramp's brightest point has to be its maximum).
//
// Stops are interpolated in OKLab; a plain sRGB lerp muddies the middle of
// every warm→cold pair.

interface HeatStop {
  readonly v: number;
  readonly rgb: readonly [number, number, number];
}

const STOPS: readonly HeatStop[] = [
  { v: 0.0, rgb: [169, 201, 242] },
  { v: 0.09, rgb: [143, 176, 230] },
  { v: 0.2, rgb: [163, 164, 222] },
  { v: 0.33, rgb: [227, 173, 192] },
  { v: 0.52, rgb: [250, 179, 135] },
  { v: 0.78, rgb: [249, 226, 175] },
  { v: 1.0, rgb: [253, 240, 208] },
];

type Lab = readonly [number, number, number];

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(channel: number): number {
  const c = channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

function toOklab(rgb: readonly [number, number, number]): Lab {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab(lab: Lab): readonly [number, number, number] {
  const l = Math.pow(lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2], 3);
  const m = Math.pow(lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2], 3);
  const s = Math.pow(lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2], 3);
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function heatRgb(score: number): readonly [number, number, number] {
  const v = Math.max(0, Math.min(1, score));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const from = STOPS[i];
    const to = STOPS[i + 1];
    if (v <= to.v) {
      const t = (v - from.v) / (to.v - from.v);
      const a = toOklab(from.rgb);
      const b = toOklab(to.rgb);
      return fromOklab([
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ]);
    }
  }
  return STOPS[STOPS.length - 1].rgb;
}

/** Temperature at this stamina level, as the "R G B" triplet the glass vars take. */
export function staminaHeat(score: number): string {
  return heatRgb(score).join(' ');
}

/** Lightened twin of the temperature — the exit caustic (--ci). */
export function staminaHeatLite(score: number): string {
  const lab = toOklab(heatRgb(score));
  return fromOklab([Math.min(1, lab[0] + 0.13), lab[1] * 0.75, lab[2] * 0.75]).join(' ');
}
