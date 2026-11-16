// Every length here is a fraction of the track height, so the switch scales as one piece.
export const SHAPE = {
  /** Gap between the track edge and the resting lens. */
  inset: 0.075,
  /** Horizontal padding either side of a label; slot width = label + 2 × pad. */
  pad: 0.5,
  /** Label font size. */
  font: 0.2,
  weight: 500,
  /** Width of the lens's rounded rim, as a fraction of the lens height. */
  bevel: 0.2,
  /** Canvas overhang around the track, room for the lens's shadow and lift. */
  margin: 0.45,
};

// Springs are in track-heights and seconds. zeta < 1 overshoots.
export const MOTION = {
  /** Lens centre: quick, with a small overshoot. */
  moveK: 340,
  moveZeta: 0.72,
  /** Lens width: loose, so it wobbles after landing. */
  widthK: 360,
  widthZeta: 0.3,
  /** In flight the lens narrows by up to this fraction... */
  squeeze: 0.4,
  /** ...reached at this speed (track-heights per second). */
  squeezeSpeed: 9,
  /** Height gives back some of the width change (drop-like volume). */
  heightGive: 0.14,
  /** Lift: the lens rises off the track while dragged or flying. */
  liftK: 200,
  liftZeta: 0.7,
  liftScale: 0.06,
  /** Rim lights orbit at this rate (rad/s), faster while the lens moves. */
  spin: 0.55,
  spinFromVelocity: 0.14,
};

// Colours are sRGB 0-1.
export const GLASS = {
  /** Must match --color-stage in index.css. */
  page: [0xf8 / 255, 0xef / 255, 0xf6 / 255] as const,
  inkIdle: [0x86 / 255, 0x77 / 255, 0x91 / 255] as const,
  inkActive: [0x32 / 255, 0x1e / 255, 0x45 / 255] as const,
  /** The milky body colour of the lens interior. */
  body: [0.98, 0.89, 0.95] as const,
  /** How much of the body colour covers what is refracted (0 clear, 1 opaque). */
  tint: 0.56,
  /** Rim refraction distance, in rim widths. */
  refract: 1.2,
  /** Spread between the red and blue samples; drives the rainbow fringes. */
  dispersion: 0.17,
};
