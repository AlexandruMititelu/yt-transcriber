// One-click prompts shown above the chat composer while the chat is empty. Edit freely.
export const PROMPTS = [
  { label: 'Summarize', text: 'Summarize this video in a few short paragraphs. Cite timestamps for each main point.' },
  { label: 'Key takeaways', text: 'List the key takeaways as bullets, each with the timestamp where it is discussed.' },
  { label: 'Action items', text: 'Extract concrete action items, tools, or resources mentioned, with timestamps.' },
  { label: 'ELI5', text: 'Explain the main idea of this video like I am five, then once more for an expert.' },
  { label: 'Chapters', text: 'Split the video into chapters: give a timestamp and a one-line title for each.' },
];

// Settings stores presets as [{label, text}] (Settings has a row per preset: shortcut + what it sends).
// undefined (never edited) → the defaults above; [] → no presets. Legacy: text, one `Label: prompt` per line.
export const promptsToText = (list) => list.map((p) => `${p.label}: ${p.text}`).join('\n');
export function parsePrompts(text) {
  if (text == null) return PROMPTS;
  if (Array.isArray(text)) {
    return text.filter((p) => p && String(p.label ?? '').trim() && String(p.text ?? '').trim())
      .map((p) => ({ label: String(p.label).trim().slice(0, 40), text: String(p.text) }));
  }
  return String(text).split('\n').map((l) => {
    const m = /^\s*([^:]{1,40}):\s*(.+?)\s*$/.exec(l);
    return m ? { label: m[1].trim(), text: m[2] } : null;
  }).filter(Boolean);
}
