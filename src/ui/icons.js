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
