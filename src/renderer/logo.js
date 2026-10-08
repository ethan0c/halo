// The Halo mark: a ring with a spark sitting in its gap. The spark doubles as
// a status light (pulses while listening, spins while thinking).
export const LOGO_SVG = `
<svg class="halo-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <defs>
    <linearGradient id="halo-g" x1="3" y1="21" x2="21" y2="3" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#9a9a9f"/>
      <stop offset="1" stop-color="#ffffff"/>
    </linearGradient>
  </defs>
  <circle class="halo-ring" cx="12" cy="12" r="9.2" stroke="url(#halo-g)" stroke-width="2.6" stroke-linecap="round"
    stroke-dasharray="46.6 11.2" stroke-dashoffset="-11.2" transform="rotate(-80 12 12)"/>
  <circle class="halo-spark" cx="18.5" cy="5.5" r="2.1" fill="#f4f4f5"/>
</svg>`;
