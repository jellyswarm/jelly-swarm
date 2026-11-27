import { useEffect, useMemo, useRef } from 'react'
import presets from './presets'
import './OrbitGallery.css'

const f = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d
const TAU = Math.PI * 2

/* A stable 0..1 per (index, salt), so a card's lean, size and nudge never
   change between renders but still look hand-placed. */
const hash = (i, salt) => {
  const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return s - Math.floor(s)
}

const RATIOS = [0.75, 1, 0.667, 0.75, 1.333, 1, 0.667, 0.75]
const isVideo = (src = '') => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src)

/**
 * Default rings, inside out. `radius` and `size` are fractions of the
 * component's shorter side (so the orbits stay round in any frame);
 * `period` is seconds per turn and `direction` 1 is clockwise.
 */
export const defaultRings = [
  { count: 4, radius: 0.282, size: 0.112, period: 85, direction: 1 },
  { count: 8, radius: 0.462, size: 0.106, period: 140, direction: -1 },
  { count: 12, radius: 0.66, size: 0.13, period: 200, direction: 1 },
]

export default function OrbitGallery({
  items = [],
  rings = defaultRings,
  preset = 'paper',
  theme,
  label = 'Orbiting gallery',

  /* --- centre copy -------------------------------------------------------- */
  eyebrow = '',
  title = '',
  subtitle = '',
  /* Max width of the copy column, fraction of the shorter side. */
  copyWidth = 0.62,

  /* --- cards -------------------------------------------------------------- */
  /* Degrees of random lean either way when an item does not set its own. */
  lean = 30,
  /* Size spread between cards on one ring: 0.15 is ±15%. */
  sizeJitter = 0.15,
  /* Degrees each card may drift off even spacing. */
  angleJitter = 6,
  radius = 10,
  /* Hover grows a card by this much and lifts its shadow. */
  hoverScale = 1.07,

  /* --- motion ------------------------------------------------------------- */
  /* Multiplies every ring's speed. 0 holds them still. */
  speed = 1,
  /* Rings ease to a stop while the pointer is over the gallery. */
  pauseOnHover = false,
  /* Drag spins all rings together; they coast and ease back to cruising. */
  draggable = true,

  /* --- backdrop ----------------------------------------------------------- */
  /* Where the edge fade starts, as a fraction of the half-diagonal. 1 is off. */
  edgeFade = 0.76,
  grain = 0.06,
  /* Width over height of the component. */
  aspect = 1.556,

  className = '',
  style,
  ...rest
}) {
  const colours = { ...(presets[preset] || presets.paper), ...theme }

  /* Hand items out ring by ring, inside out, cycling if there are fewer
     items than seats. Each seat gets its own stable angle, size and lean. */
  const seats = useMemo(() => {
    const list = items.filter(Boolean).map((it) => (typeof it === 'string' ? { src: it } : it))
    if (!list.length) return []
    const out = []
    let k = 0
    rings.forEach((ring, r) => {
      const count = Math.max(1, Math.round(ring.count || 1))
      for (let j = 0; j < count; j++, k++) {
        const it = list[k % list.length]
        const angle = (j / count) * 360 + (hash(k, 1) - 0.5) * 2 * angleJitter + r * 17
        out.push({
          key: `${r}-${j}`,
          ring: r,
          item: it,
          angle,
          ratio: it.ratio ?? RATIOS[k % RATIOS.length],
          lean: it.lean ?? Math.round((hash(k, 2) - 0.5) * 2 * lean),
          size: (ring.size ?? 0.11) * (1 + (hash(k, 3) - 0.5) * 2 * sizeJitter),
        })
      }
    })
    return out
  }, [items, rings, lean, sizeJitter, angleJitter])

  const rootRef = useRef(null)
  const seatRefs = useRef([])

  const props = useRef(null)
  props.current = { rings, speed, pauseOnHover, draggable, seats }

  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    /* Ring angles live outside React; the spin is shared, so a drag turns
       every ring by the same amount, each still carrying its own cruise. */
    const s = { angles: [], spin: 0, spinVel: 0, throttle: 1, hover: false, visible: true }

    let drag = null
    const centre = () => {
      const r = root.getBoundingClientRect()
      return [r.left + r.width / 2, r.top + r.height / 2]
    }
    const onDown = (e) => {
      if (!props.current.draggable || (e.button !== 0 && e.pointerType === 'mouse')) return
      const [cx, cy] = centre()
      drag = { id: e.pointerId, cx, cy, x: e.clientX, y: e.clientY, a: Math.atan2(e.clientY - cy, e.clientX - cx), moved: false, hist: [] }
    }
    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return
        drag.moved = true
        root.setPointerCapture?.(e.pointerId)
        root.classList.add('is-dragging')
      }
      const a = Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx)
      let d = a - drag.a
      if (d > Math.PI) d -= TAU
      if (d < -Math.PI) d += TAU
      drag.a = a
      s.spin += d
      const t = performance.now() / 1000
      drag.hist.push([t, s.spin])
      while (drag.hist.length > 2 && t - drag.hist[0][0] > 0.1) drag.hist.shift()
    }
    const onUp = (e) => {
      if (!drag || e.pointerId !== drag.id) return
      root.classList.remove('is-dragging')
      if (drag.moved) {
        const h = drag.hist
        const dt = h.length > 1 ? h[h.length - 1][0] - h[0][0] : 0
        s.spinVel = dt > 0.005 ? Math.max(-6, Math.min(6, (h[h.length - 1][1] - h[0][1]) / dt)) : 0
        /* A drag that ends on a linked card must not also open it. */
        const stop = (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
        }
        root.addEventListener('click', stop, { capture: true, once: true })
        setTimeout(() => root.removeEventListener('click', stop, { capture: true }), 0)
      }
      drag = null
    }
    const onEnter = () => (s.hover = true)
    const onLeave = () => (s.hover = false)
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const direction = e.key === 'ArrowRight' ? 1 : -1
      if (reduce.matches) s.spin += direction * 0.16
      else s.spinVel = Math.max(-3, Math.min(3, s.spinVel + direction * 1.3))
    }

    /* Videos only play while the gallery is on screen. */
    const io = new IntersectionObserver(([entry]) => {
      s.visible = entry.isIntersecting
      root.querySelectorAll('video').forEach((v) => {
        if (s.visible && !reduce.matches) v.play?.().catch(() => {})
        else v.pause?.()
      })
    })
    io.observe(root)

    let raf = 0
    let last = performance.now()
    const frame = (t) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(1 / 30, (t - last) / 1000)
      last = t
      if (!s.visible) return
      const p = props.current

      /* Hover eases the cruise down rather than freezing it mid-step. */
      const want = reduce.matches || (p.pauseOnHover && s.hover) || drag ? 0 : 1
      s.throttle += (want - s.throttle) * (1 - Math.exp(-dt * 4))
      if (!drag) {
        s.spin += s.spinVel * dt
        s.spinVel *= Math.exp(-dt * 1.6)
      }

      for (let r = 0; r < p.rings.length; r++) {
        const ring = p.rings[r]
        const w = ring.period > 0 ? (TAU / ring.period) * (ring.direction < 0 ? -1 : 1) : 0
        s.angles[r] = ((s.angles[r] || 0) + w * p.speed * s.throttle * dt) % TAU
      }

      const seats = p.seats
      for (let i = 0; i < seats.length; i++) {
        const el = seatRefs.current[i]
        if (!el) continue
        const seat = seats[i]
        const ring = p.rings[seat.ring]
        if (!ring) continue
        const a = (seat.angle * Math.PI) / 180 + s.angles[seat.ring] + s.spin
        const x = Math.cos(a) * ring.radius * 100
        const y = Math.sin(a) * ring.radius * 100
        el.style.transform = `translate(-50%, -50%) translate(${f(x, 3)}cqmin, ${f(y, 3)}cqmin)`
      }
    }
    raf = requestAnimationFrame(frame)

    root.addEventListener('keydown', onKey)
    root.addEventListener('pointerdown', onDown)
    root.addEventListener('pointermove', onMove)
    root.addEventListener('pointerup', onUp)
    root.addEventListener('pointercancel', onUp)
    root.addEventListener('pointerenter', onEnter)
    root.addEventListener('pointerleave', onLeave)
    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      root.removeEventListener('keydown', onKey)
      root.removeEventListener('pointerdown', onDown)
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerup', onUp)
      root.removeEventListener('pointercancel', onUp)
      root.removeEventListener('pointerenter', onEnter)
      root.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  const vars = {
    '--og-aspect': aspect,
    '--og-bg': colours.background,
    '--og-card': colours.card,
    '--og-eyebrow': colours.eyebrow,
    '--og-title': colours.title,
    '--og-subtitle': colours.subtitle,
    '--og-shadow': colours.shadow,
    '--og-radius': `${radius}px`,
    '--og-hover-scale': hoverScale,
    '--og-copy': copyWidth * 100,
    '--og-fade': `${Math.min(1, edgeFade) * 100}%`,
    '--og-grain': grain,
    ...style,
  }

  return (
    <div
      ref={rootRef}
      className={`og ${className}`.trim()}
      style={vars}
      role="region"
      aria-label={label}
      {...rest}
    >
      <div className="og__field">
        {seats.map((seat, i) => {
          const { item } = seat
          const media = isVideo(item.src) || item.type === 'video' ? (
            <video className="og__media" src={item.src} poster={item.poster} muted loop playsInline preload="metadata" />
          ) : (
            <img className="og__media" src={item.src} alt={item.alt ?? ''} loading="lazy" decoding="async" draggable={false} />
          )
          const Plate = item.href ? 'a' : 'div'
          return (
            <div
              key={seat.key}
              ref={(el) => (seatRefs.current[i] = el)}
              className="og__seat"
              style={{
                width: `${f(seat.size * 100, 3)}cqmin`,
                aspectRatio: seat.ratio,
                zIndex: seat.ring + 1,
              }}
            >
              <Plate
                className="og__plate"
                style={{ '--og-lean': `${seat.lean}deg` }}
                {...(item.href
                  ? { href: item.href, target: item.target, rel: item.target === '_blank' ? 'noopener noreferrer' : undefined, 'aria-label': item.alt || 'Open' }
                  : {})}
              >
                {media}
              </Plate>
            </div>
          )
        })}
      </div>

      {edgeFade < 1 && <div className="og__fade" aria-hidden="true" />}
      {grain > 0 && <div className="og__grain" aria-hidden="true" />}

      {(eyebrow || title || subtitle) && (
        <div className="og__copy">
          <div className="og__column">
            {eyebrow && <p className="og__eyebrow">{eyebrow}</p>}
            {title && <h2 className="og__title">{title}</h2>}
            {subtitle && <p className="og__subtitle">{subtitle}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
