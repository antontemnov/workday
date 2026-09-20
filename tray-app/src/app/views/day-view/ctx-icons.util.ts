// Menu icon set — one 1.2 stroke on a 12px box, inline SVG (crisp on
// fractional DPI; stroke="currentColor" follows the item states).

const svg = (body: string): string =>
  `<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const CTX_ICON = {
  x: svg('<path d="M3 3l6 6M9 3l-6 6"/>'),
  check: svg('<path d="M2.4 6.4l2.4 2.4 4.8-5.4"/>'),
  edit: svg('<path d="M2.2 9.8l.5-2.4 5.5-5.5 1.9 1.9-5.5 5.5z"/>'),
  star: svg('<path d="M6 1.5l1.4 2.85 3.1.45-2.25 2.2.53 3.1L6 8.62 3.22 10.1l.53-3.1L1.5 4.8l3.1-.45z"/>'),
  copy: svg('<rect x="4.2" y="4.2" width="6" height="6" rx="1.2"/><path d="M7.8 2.5a.9.9 0 0 0-.9-.9H2.6a.9.9 0 0 0-.9.9v4.3a.9.9 0 0 0 .9.9"/>'),
  pause: svg('<rect x="2.6" y="2" width="2.5" height="8" rx=".8" fill="currentColor" stroke="none"/><rect x="6.9" y="2" width="2.5" height="8" rx=".8" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="2.5" y="2.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none"/>'),
  play: svg('<path d="M3.2 1.9l6.6 4.1-6.6 4.1z" fill="currentColor" stroke="none"/>'),
  add: svg('<circle cx="6" cy="6" r="4.5"/><path d="M6 3.8v4.4M3.8 6h4.4"/>'),
  globe: svg('<circle cx="6" cy="6" r="4.6"/><ellipse cx="6" cy="6" rx="2.1" ry="4.6"/><line x1="1.4" y1="6" x2="10.6" y2="6"/>'),
  mode: svg('<path d="M3.03 9.47 A4.2 4.2 0 1 1 8.97 9.47"/><line x1="6" y1="6.5" x2="8.4" y2="3.9"/><circle cx="6" cy="6.5" r="0.9" fill="currentColor" stroke="none"/>'),
  back: svg('<path d="M7.4 2.6L3.9 6l3.5 3.4"/>'),
  // Empty box — keeps the icon gutter so a ✓ sibling stays aligned.
  none: svg(''),
} as const;
