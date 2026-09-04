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
export const cameraIcon = () => svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', 'ytx-ico ytx-ico-camera');
export const searchIcon = () => svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>', 'ytx-ico ytx-ico-search');
export const plusIcon = () => svg('<path d="M12 5v14M5 12h14"/>', 'ytx-ico ytx-ico-plus');
export const copyIcon = () => svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>', 'ytx-ico ytx-ico-copy');
export const chatIcon = () => svg('<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8z"/>', 'ytx-ico ytx-ico-chat');
export const refreshIcon = () => svg('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>', 'ytx-ico ytx-ico-refresh');
export const libraryIcon = () => svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M9 20V10"/>', 'ytx-ico ytx-ico-library');
export const gearIcon = () => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', 'ytx-ico ytx-ico-gear');
export const checkIcon = () => svg('<path d="M5 12l5 5L20 7"/>', 'ytx-ico ytx-ico-check');
export const arrowUpIcon = () => svg('<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>', 'ytx-ico ytx-ico-arrow-up');
export const stopIcon = () => svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', 'ytx-ico ytx-ico-stop');
export const tagIcon = () => svg('<path d="M3 12V4h8l9 9-8 8-9-9z"/><circle cx="7.5" cy="8.5" r="1.5"/>', 'ytx-ico ytx-ico-tag');
export const archiveIcon = () => svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8"/><path d="M10 12h4"/>', 'ytx-ico ytx-ico-archive');
export const expandIcon = () => svg('<path d="M4 9V4h5"/><path d="M20 15v5h-5"/><path d="M4 4l6 6"/><path d="M20 20l-6-6"/>', 'ytx-ico ytx-ico-expand');
