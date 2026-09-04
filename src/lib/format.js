// Pure formatting helpers.

export function fmtTime(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function clampText(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

export function chunkText(str, size) {
  const chunks = [];
  let rest = str;
  while (rest.length > 0) {
    if (rest.length <= size) {
      if (rest.trim()) chunks.push(rest);
      break;
    }
    let cut = size;
    const slice = rest.slice(0, size + 1);
    if (!/\s/.test(slice[size])) {
      const lastWs = slice.slice(0, size).search(/\s\S*$/);
      if (lastWs > 0) cut = lastWs;
    }
    const chunk = rest.slice(0, cut);
    if (chunk.trim()) chunks.push(chunk);
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  return chunks;
}
