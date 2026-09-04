// One-click prompts shown above the chat composer while the chat is empty. Edit freely.
export const PROMPTS = [
  { label: 'Summarize', text: 'Summarize this video in a few short paragraphs. Cite timestamps for each main point.' },
  { label: 'Key takeaways', text: 'List the key takeaways as bullets, each with the timestamp where it is discussed.' },
  { label: 'Action items', text: 'Extract concrete action items, tools, or resources mentioned, with timestamps.' },
  { label: 'ELI5', text: 'Explain the main idea of this video like I am five, then once more for an expert.' },
  { label: 'Chapters', text: 'Split the video into chapters: give a timestamp and a one-line title for each.' },
];

// Settings stores presets as text, one per line: `Label: prompt text`. Blank/invalid lines are skipped;
// undefined (never edited) → the defaults above; an empty string → no presets.
export const promptsToText = (list) => list.map((p) => `${p.label}: ${p.text}`).join('\n');
export function parsePrompts(text) {
  if (text == null) return PROMPTS;
  return String(text).split('\n').map((l) => {
    const m = /^\s*([^:]{1,40}):\s*(.+?)\s*$/.exec(l);
    return m ? { label: m[1].trim(), text: m[2] } : null;
  }).filter(Boolean);
}
