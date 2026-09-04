// Tiny inline SVG icons (currentColor) — no emoji.
const svg = (inner, cls) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', '16');
  el.setAttribute('height', '16');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '2');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  if (cls) el.setAttribute('class', cls);
  el.innerHTML = inner;
  return el;
};

// Pushpin outline; parent sets `fill: currentColor` on .is-on to show it filled/yellow.
export const pinIcon = () => svg('<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z"/><path d="M12 14v7"/>', 'ytx-ico ytx-ico-pin');
export const trashIcon = () => svg('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>', 'ytx-ico ytx-ico-trash');
export const chevronDown = () => svg('<path d="M6 9l6 6 6-6"/>', 'ytx-ico ytx-ico-chevron-down');
export const chevronLeft = () => svg('<path d="M15 5l-7 7 7 7"/>', 'ytx-ico ytx-ico-chevron');
export const globeIcon = () => svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>', 'ytx-ico ytx-ico-globe');
export const eyeIcon = () => svg('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>', 'ytx-ico ytx-ico-eye');
