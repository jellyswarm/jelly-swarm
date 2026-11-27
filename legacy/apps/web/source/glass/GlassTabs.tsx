import {useEffect, useRef, useState, type KeyboardEvent, type PointerEvent} from 'react';
import {GLASS, MOTION, SHAPE} from './config';
import {GlassRenderer} from './renderer';
import {buildLayout, drawScene, FONT_FAMILY, measureLabels, unitWidth, type Layout} from './scene';

type Props = {
  items: string[];
  value: number;
  onChange: (index: number) => void;
  /** Track height cap in CSS px; it shrinks below this to fit narrow screens. */
  maxHeight?: number;
  minHeight?: number;
};

/** Lens state in track-heights (so a resize needs no conversion). */
type Sim = {
  x: number;
  vx: number;
  w: number;
  vw: number;
  lift: number;
  vlift: number;
  spin: number;
  glow: number;
  ready: boolean;
};

type Drag = {id: number; startX: number; grab: number; px: number; moved: boolean};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const css = (c: readonly number[]) => `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`;

function spring(x: number, v: number, target: number, k: number, zeta: number, dt: number): [number, number] {
  const c = 2 * zeta * Math.sqrt(k);
  v += (-k * (x - target) - c * v) * dt;
  return [x + v * dt, v];
}

/** Slot width blended by position, so a dragged lens reshapes as it crosses labels. */
function widthAt(L: Layout, x: number) {
  const S = L.slots;
  if (x <= S[0].center) return S[0].width;
  for (let i = 0; i < S.length - 1; i++) {
    if (x <= S[i + 1].center) {
      const t = (x - S[i].center) / (S[i + 1].center - S[i].center);
      return S[i].width + (S[i + 1].width - S[i].width) * t;
    }
  }
  return S[S.length - 1].width;
}

export default function GlassTabs({items, value, onChange, maxHeight = 92, minHeight = 44}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const renderer = useRef<GlassRenderer | null>(null);

  const [layout, setLayout] = useState<Layout | null>(null);
  const [glFailed, setGlFailed] = useState(false);
  const [cursor, setCursor] = useState<'' | 'grab' | 'grabbing'>('');

  const live = useRef({value, layout});
  live.current = {value, layout};
  const sim = useRef<Sim>({x: 0, vx: 0, w: 0, vw: 0, lift: 0, vlift: 0, spin: 0.6, glow: 0, ready: false});
  const drag = useRef<Drag | null>(null);
  const pointer = useRef({x: 0, y: 0, on: false});
  const suppressClick = useRef(false);

  // Measure labels once the font is in, then take the tallest track that fits.
  useEffect(() => {
    const wrap = wrapRef.current!;
    let widths: number[] | null = null;
    let cancelled = false;
    const fit = () => {
      if (!widths) return;
      const H = clamp(wrap.clientWidth / unitWidth(widths), minHeight, maxHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      setLayout((prev) =>
        prev && Math.abs(prev.H - H) < 0.25 && prev.dpr === dpr ? prev : buildLayout(widths!, H, dpr),
      );
    };
    document.fonts
      .load(`${SHAPE.weight} 40px ${FONT_FAMILY}`)
      .catch(() => [])
      .then(() => {
        if (cancelled) return;
        widths = measureLabels(items);
        fit();
      });
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [items, maxHeight, minHeight]);

  // Repaint the refracted layers whenever the size changes.
  useEffect(() => {
    if (!layout || glFailed) return;
    try {
      renderer.current ??= new GlassRenderer(canvasRef.current!);
    } catch (err) {
      console.warn('[glass-tabs] falling back to CSS:', err);
      setGlFailed(true);
      return;
    }
    const track = document.createElement('canvas');
    const text = document.createElement('canvas');
    drawScene(layout, items, track, text);
    renderer.current.upload(track, text);
  }, [layout, items, glFailed]);

  // Physics + draw, every frame (the rim lights never stop orbiting).
  useEffect(() => {
    const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const t0 = performance.now();
    let last = t0;
    let raf = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 1 / 20);
      last = now;
      const L = live.current.layout;
      const r = renderer.current;
      if (!L || !r) return;

      const s = sim.current;
      const H = L.H;
      const S = L.slots;
      const d = drag.current;
      const reduced = reducedMq.matches;

      let tx: number;
      let rest: number;
      if (d) {
        tx = clamp((d.px - d.grab) / H, S[0].center / H, S[S.length - 1].center / H);
        rest = widthAt(L, tx * H) / H;
      } else {
        const slot = S[clamp(live.current.value, 0, S.length - 1)];
        tx = slot.center / H;
        rest = slot.width / H;
      }
      if (!s.ready) {
        s.x = tx;
        s.w = rest;
        s.ready = true;
      }

      const steps = Math.max(1, Math.ceil(dt * 240));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const speed = Math.abs(s.vx);
        const squeeze = reduced ? 0 : MOTION.squeeze * smooth(0, MOTION.squeezeSpeed, speed);
        [s.x, s.vx] = spring(s.x, s.vx, tx, MOTION.moveK, reduced ? 1 : MOTION.moveZeta, h);
        [s.w, s.vw] = spring(s.w, s.vw, rest * (1 - squeeze), MOTION.widthK, reduced ? 1 : MOTION.widthZeta, h);
        const liftTarget = d ? 1 : 0.55 * smooth(1, 10, speed);
        [s.lift, s.vlift] = spring(s.lift, s.vlift, liftTarget, MOTION.liftK, MOTION.liftZeta, h);
      }
      s.spin += dt * (reduced ? 0.15 : MOTION.spin + s.vx * MOTION.spinFromVelocity);
      s.glow += ((pointer.current.on ? 1 : 0) - s.glow) * Math.min(1, dt * 5);

      // Volume-ish: a squeezed lens stands a little taller, a stretched one a little lower.
      const lift = clamp(s.lift, 0, 1.2);
      const grow = 1 + MOTION.liftScale * lift;
      const hScale = clamp(1 - MOTION.heightGive * (s.w / rest - 1), 0.93, 1.07);
      const lh = L.lensH * hScale * grow;
      // An overshoot at either end squashes the lens against the track wall instead of leaving it.
      const wall = SHAPE.inset * H * 0.4;
      const halfW = Math.max(s.w * H * grow, lh) / 2;
      const left = Math.max(s.x * H - halfW, wall);
      const right = Math.min(s.x * H + halfW, L.trackW - wall);
      const lw = Math.max(right - left, lh);

      const k = L.dpr;
      const cx = (L.margin + (left + right) / 2) * k;
      const cy = (L.margin + H / 2) * k;
      const P = pointer.current;
      const angle = Math.atan2((L.margin + P.y) * k - cy, (L.margin + P.x) * k - cx);

      r.draw({
        center: [cx, cy],
        half: [(lw / 2) * k, (lh / 2) * k],
        bevel: SHAPE.bevel * lh * k,
        lift,
        spin: s.spin,
        time: (now - t0) / 1000,
        pointer: [angle, s.glow],
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const local = (e: PointerEvent) => {
    const r = trackRef.current!.getBoundingClientRect();
    return {x: e.clientX - r.left, y: e.clientY - r.top};
  };

  const overLens = (x: number, y: number) => {
    const L = live.current.layout;
    if (!L) return false;
    const s = sim.current;
    return Math.abs(x - s.x * L.H) <= (s.w * L.H) / 2 && Math.abs(y - L.H / 2) <= L.lensH / 2 + 4;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    const {x, y} = local(e);
    if (!overLens(x, y) || e.button !== 0) return;
    const L = live.current.layout!;
    drag.current = {id: e.pointerId, startX: x, grab: x - sim.current.x * L.H, px: x, moved: false};
    e.currentTarget.setPointerCapture(e.pointerId);
    setCursor('grabbing');
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const {x, y} = local(e);
    pointer.current = {x, y, on: true};
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      d.px = x;
      if (Math.abs(x - d.startX) > 4) d.moved = true;
    } else if (!d) {
      setCursor(overLens(x, y) ? 'grab' : '');
    }
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const L = live.current.layout;
    if (!d || d.id !== e.pointerId || !L) return;
    drag.current = null;
    setCursor('');
    if (!d.moved) return;
    suppressClick.current = true;
    // Land where the lens is heading, so a flick carries on to the next tab.
    const s = sim.current;
    const aim = (s.x + s.vx * 0.09) * L.H;
    let best = 0;
    L.slots.forEach((slot, i) => {
      if (Math.abs(slot.center - aim) < Math.abs(L.slots[best].center - aim)) best = i;
    });
    onChange(best);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const n = items.length;
    const next =
      e.key === 'ArrowRight' ? (value + 1) % n
      : e.key === 'ArrowLeft' ? (value - 1 + n) % n
      : e.key === 'Home' ? 0
      : e.key === 'End' ? n - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(next);
    tabRefs.current[next]?.focus();
  };

  const H = layout?.H ?? maxHeight;
  const m = layout?.margin ?? 0;
  const active = layout?.slots[value];

  return (
    <div ref={wrapRef} className="flex w-full justify-center">
      <div
        ref={trackRef}
        role="tablist"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          pointer.current.on = false;
        }}
        className="relative shrink-0 select-none"
        style={{
          width: layout?.trackW ?? 0,
          height: H,
          touchAction: 'pan-y',
          visibility: layout ? 'visible' : 'hidden',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {!glFailed ? (
          <canvas
            ref={canvasRef}
            aria-hidden
            className="pointer-events-none absolute"
            style={{left: -m, top: -m, width: (layout?.trackW ?? 0) + 2 * m, height: H + 2 * m}}
          />
        ) : (
          <>
            <div
              aria-hidden
              className="absolute inset-0 rounded-full"
              style={{background: 'rgb(0 0 0 / 0.025)', boxShadow: 'inset 0 3px 8px rgb(0 0 0 / 0.12), 0 1px 0 rgb(255 255 255 / 0.7)'}}
            />
            {active && layout && (
              <div
                aria-hidden
                className="absolute rounded-full transition-[left,width] duration-300 ease-[cubic-bezier(.3,1.4,.5,1)]"
                style={{
                  left: active.left,
                  width: active.width,
                  top: (H - layout.lensH) / 2,
                  height: layout.lensH,
                  background: 'rgb(255 255 255 / 0.45)',
                  backdropFilter: 'blur(6px)',
                  boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.8), inset 0 -6px 14px rgb(0 0 0 / 0.08), 0 6px 16px rgb(0 0 0 / 0.12)',
                }}
              />
            )}
          </>
        )}

        {items.map((label, i) => {
          const slot = layout?.slots[i];
          return (
            <button
              key={label}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              aria-selected={i === value}
              tabIndex={i === value ? 0 : -1}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                onChange(i);
              }}
              className="glass-tab absolute top-0 h-full rounded-full whitespace-nowrap"
              style={{
                left: slot?.left,
                width: slot?.width,
                fontSize: layout?.fontPx,
                fontWeight: SHAPE.weight,
                // The canvas draws the labels; these stay for focus, clicks and screen readers.
                color: glFailed ? css(i === value ? GLASS.inkActive : GLASS.inkIdle) : 'transparent',
                cursor: cursor || undefined,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
