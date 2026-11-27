import {SHAPE} from './config';

export const FONT_FAMILY = '"Inter Variable", system-ui, sans-serif';

export type Slot = {left: number; width: number; center: number};

/** Everything in CSS px, relative to the track's top-left corner. */
export type Layout = {
  H: number;
  trackW: number;
  lensH: number;
  margin: number;
  fontPx: number;
  dpr: number;
  slots: Slot[];
};

const font = (px: number) => `${SHAPE.weight} ${px}px ${FONT_FAMILY}`;

/** Label widths at a 100 px font, measured once fonts are ready. */
export function measureLabels(items: string[]): number[] {
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = font(100);
  return items.map((s) => ctx.measureText(s).width);
}

/** Track width in track-heights, so we can pick the largest height that fits. */
export function unitWidth(widths100: number[]): number {
  const text = widths100.reduce((a, w) => a + (w * SHAPE.font) / 100, 0);
  return text + widths100.length * 2 * SHAPE.pad + 2 * SHAPE.inset;
}

export function buildLayout(widths100: number[], H: number, dpr: number): Layout {
  let cursor = SHAPE.inset * H;
  const slots = widths100.map((w100) => {
    const width = (w100 * SHAPE.font * H) / 100 + 2 * SHAPE.pad * H;
    const slot = {left: cursor, width, center: cursor + width / 2};
    cursor += width;
    return slot;
  });
  return {
    H,
    trackW: cursor + SHAPE.inset * H,
    lensH: H * (1 - 2 * SHAPE.inset),
    margin: Math.ceil(SHAPE.margin * H),
    fontPx: SHAPE.font * H,
    dpr,
    slots,
  };
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = h / 2;
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + r, r, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.closePath();
}

/**
 * Paints the two layers the lens refracts: the recessed track (colour) and the
 * labels (alpha only, so the shader can ink them grey outside and dark inside).
 */
export function drawScene(L: Layout, items: string[], track: HTMLCanvasElement, text: HTMLCanvasElement) {
  const s = L.dpr;
  const cw = Math.round((L.trackW + 2 * L.margin) * s);
  const ch = Math.round((L.H + 2 * L.margin) * s);
  for (const c of [track, text]) {
    c.width = cw;
    c.height = ch;
  }

  const x = L.margin * s;
  const y = L.margin * s;
  const w = L.trackW * s;
  const h = L.H * s;

  const t = track.getContext('2d')!;
  t.clearRect(0, 0, cw, ch);

  // Recess: a whisper darker than the stage.
  t.beginPath();
  pill(t, x, y, w, h);
  t.fillStyle = 'rgba(0, 0, 0, 0.022)';
  t.fill();

  // Inner shadow from the top lip: shade a ring around the track, clipped inside it.
  t.save();
  t.beginPath();
  pill(t, x, y, w, h);
  t.clip();
  t.beginPath();
  t.rect(x - h, y - h, w + 2 * h, h * 3);
  pill(t, x, y, w, h);
  t.shadowColor = 'rgba(0, 0, 0, 0.15)';
  t.shadowBlur = h * 0.13;
  t.shadowOffsetY = h * 0.04;
  t.fillStyle = '#000';
  t.fill('evenodd');
  t.restore();

  // Lit lower lip and a faint upper edge.
  const lip = t.createLinearGradient(0, y, 0, y + h);
  lip.addColorStop(0, 'rgba(255, 255, 255, 0.05)');
  lip.addColorStop(0.55, 'rgba(255, 255, 255, 0.12)');
  lip.addColorStop(1, 'rgba(255, 255, 255, 0.75)');
  t.beginPath();
  pill(t, x - 0.5 * s, y - 0.5 * s, w + s, h + s);
  t.strokeStyle = lip;
  t.lineWidth = 1.25 * s;
  t.stroke();

  // Labels, centred on cap height.
  const g = text.getContext('2d')!;
  g.clearRect(0, 0, cw, ch);
  g.font = font(L.fontPx * s);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#000';
  const baseline = y + h / 2 + 0.362 * L.fontPx * s;
  L.slots.forEach((slot, i) => {
    g.fillText(items[i], x + slot.center * s, baseline);
  });
}
