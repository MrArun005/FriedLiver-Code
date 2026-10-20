// OKLCH -> sRGB hex, for palette.json entries written as "oklch(L C H)" or "oklch(L C H / A)".
// Design System v2 picks every colour in OKLCH (perceptually even lightness, as Linear's LCH
// generator does); VS Code themes need hex, so the generator converts here. Out-of-gamut colours
// keep their lightness and hue and lose chroma until they fit (CSS Color 4 gamut mapping, simplified).

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** OKLab -> linear sRGB (Björn Ottosson's matrices). */
function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** sRGB [0..1] channels for an OKLCH colour, chroma reduced until it is in gamut. */
export function oklchToRgb(L, C, H) {
  const at = (c) => oklabToLinear(L, c * Math.cos((H * Math.PI) / 180), c * Math.sin((H * Math.PI) / 180));
  const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let rgb = at(C);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    rgb = at(lo);
  }
  return rgb.map((v) => fromLinear(Math.min(1, Math.max(0, v))));
}

/** "oklch(0.62 0.16 45)" or "oklch(0.62 0.16 45 / 0.5)" (L may be a %) -> "#rrggbb" / "#rrggbbaa". Other strings pass through. */
export function hexOf(value) {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(value);
  if (!m) return value;
  const L = Number(m[1]) / (m[2] ? 100 : 1);
  const alpha = m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1);
  const byte = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  const hex = '#' + oklchToRgb(L, Number(m[3]), Number(m[4])).map(byte).join('');
  return alpha < 1 ? hex + byte(alpha) : hex;
}

/** WCAG 2.x contrast of two opaque "#rrggbb" colours. */
export function contrast(x, y) {
  const lum = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(h.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** Converts every "oklch(…)" string in a JSON-like value to hex, deeply. */
export function hexAll(value) {
  if (typeof value === 'string') return hexOf(value);
  if (Array.isArray(value)) return value.map(hexAll);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hexAll(v)]));
  return value;
}
