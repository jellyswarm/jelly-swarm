/**
 * Colour presets for <OrbitGallery />.
 *
 * `background` doubles as the edge-fade colour, so the outer ring always
 * dissolves into whatever the gallery sits on. `card` shows behind media
 * while it loads.
 */
export const presets = {
  paper: {
    background: '#ffffff',
    card: '#e8e3da',
    eyebrow: '#7a6e5c',
    title: '#141210',
    subtitle: '#6b6154',
    shadow: 'rgba(24, 20, 16, 0.12)',
  },

  ink: {
    background: '#0b0b0d',
    card: '#1d1d22',
    eyebrow: '#9a9aa6',
    title: '#f5f5f7',
    subtitle: '#a3a3ad',
    shadow: 'rgba(0, 0, 0, 0.5)',
  },

  linen: {
    background: '#f2ece2',
    card: '#e2d8c8',
    eyebrow: '#8c6b4a',
    title: '#2c2116',
    subtitle: '#7a6550',
    shadow: 'rgba(70, 48, 24, 0.14)',
  },

  dusk: {
    background: '#1a1630',
    card: '#2a2546',
    eyebrow: '#b7a9ff',
    title: '#f4f1ff',
    subtitle: '#b3abd6',
    shadow: 'rgba(6, 4, 20, 0.5)',
  },
}

export default presets
