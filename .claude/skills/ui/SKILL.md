---
name: ui
description: Apple-style UI rules for this extension (YouTube side panel + library page). Use for any change to content/yt.css, page/app.css, src/ui/*.css, src/ui/*.js that renders UI, or UI code in page/app.js / content/yt.js.
---

# UI work in this repo

## When to use
Any edit to: `content/yt.css`, `page/app.css`, `src/ui/*.css`, `src/ui/*.js` (rendering UI), UI code paths in `page/app.js`, UI code paths in `content/yt.js`.

## Hard rules (non-negotiable)

- **Icons**: minimal monoline inline SVG only, matching `src/ui/icons.js` (24 viewBox, `stroke="currentColor"`, `stroke-width="2"`, round caps/joins, `fill="none"`). NEVER emojis, never Unicode pictographs as icons, never icon fonts. Plain `✓` / `✕` glyphs are tolerated only as check/close marks, nothing else. (Repo currently has drift — `content/yt.js` uses `⟳`, `⧉`, `💬` as button labels. Do not add more of this; replace with `icons.js` SVGs when you touch that code, don't leave new instances.)
- Every clickable element: visible change on **hover** (bg tint, colour, or border) AND on `:focus-visible`; `cursor: pointer`; **disabled** state visibly dimmed; **pressed/active** state where one exists — toggles use an `is-on`/`on` class with accent tint, not a separate ad-hoc style.
- Use design tokens only: `--accent`, `--accent-soft`, `--surface`, `--surface-2`, `--border`, `--muted`, `--text`, `--radius`, `--radius-sm`, `--green`, `--green-soft`, `--font-ui`, `--font-mono`. Never hard-code colours except the shared yellow highlight `#f5d442` and destructive red `#ff453a`.
- Space is scarce in the panel: content aligns to the segmented tab control's edges (8px inset). No double padding, no decorative chrome.
- Motion: 150–250ms, ease-out, slide/fade like iOS navigation. Honour `prefers-reduced-motion` (tokens.css already has a global reduce-motion rule — don't fight it with `!important` transitions).
- Accessibility: `aria-label` on icon-only buttons, `role="tablist"/"tab"/"tabpanel"` for tabs, `aria-pressed` for toggles, `role="status"` for toasts, minimum 12px text, contrast ≥ 4.5:1 for text.
- Keyboard: hotkeys live in `config/hotkeys.js` only — don't wire raw `keydown` shortcuts elsewhere. Text fields stop propagation of non-Alt keys so page/panel hotkeys don't fire while typing.

## HIG distilled for this UI

Core values: **hierarchy & clarity** (size/weight/color separate primary from secondary, not decoration), **deference** (content first, chrome quiet — one prominent action per view, not a wall of colored buttons), **consistency** (same stroke weight, same spacing unit, same token everywhere), **feedback** (every interactive element visibly responds — "without a press state, a button can feel unresponsive").

- **Segmented controls** (tabs): mutually exclusive, equal-width segments, single clear selected state, keep to as few segments as the panel needs (we have 3: transcript/chat/notes). Not for navigation stacks.
- **Pop-up buttons/menus** (track picker, model picker): label + chevron; chevron rotates 180° when the menu is open; menu shows a check column against the selected item; menu closes immediately on choice or outside click/Esc.
- **Toolbars**: prefer icon-only buttons for common actions, text only where an icon would be ambiguous (e.g. "Retry"); group by function with a small gap between groups, not a border; keep the header row thin.
- **Search fields**: rounded pill shape, search icon inside the field, clear affordance, clears on Esc, placeholder states intent ("Search transcript…").
- **Text fields**: no heavy focus ring on the input itself — the container/border tints with `--accent` on focus instead (this repo's global `:focus-visible` outline is for buttons/tabs, not text inputs — see tokens.css).
- **Destructive actions**: red (`#ff453a`), never the primary/most-prominent button in a view; confirm inline (e.g. a second "confirm delete" state on the same control) rather than a modal, to stay compact.
- **Back navigation**: chevron-left + label, rendered in `--accent`, not a boxed button.
- **Toasts**: `role="status"`, auto-dismiss, no blocking modal chrome.

## Pre-finish checklist

- [ ] Hover state on every clickable element?
- [ ] `:focus-visible` state present and visible?
- [ ] Icons are `src/ui/icons.js`-style inline SVG, not emoji/glyphs?
- [ ] Only design tokens used for colour (plus the two allowed hex constants)?
- [ ] Content aligned to the tab control's 8px inset, no extra padding layer?
- [ ] Looks right in both light and dark (`prefers-color-scheme` and `data-theme` override) on both hosts (YouTube panel + library page)?
- [ ] Respects `prefers-reduced-motion`?
- [ ] No emojis anywhere in UI strings/icons?

## Repo pointers

- Shared components: `src/ui/*.js` (icons, chat, chatbar, markdown, notes, picker, toast) + matching `src/ui/*.css`, all built on tokens from `src/ui/tokens.css`.
- `content/yt.js` injects those `src/ui/*.css` files into the YouTube page at runtime (see the `fetch(url('src/ui/${name}.css'))` loader); `content/yt.css` re-declares token *values* under `#ytx-panel` because content-script CSS can't `@import` extension URLs — keep both in sync when a token changes.
- The panel's button reset (`content/yt.css`, `#ytx-panel button:not(:where(...))`) explicitly excludes `ytx-picker`, `ytx-chatbar`, `ytx-confirm`, `ytx-notes`, `ytx-qn`, `ytx-nt`, `ytx-ed`, `ytx-chat`, `ytx-msg`, `ytx-code`, `ytx-toast`, `ytx-ts` prefixed classes — new shared components need their prefix added there or they'll get reset to unstyled.
- The library page (`page/app.html`/`app.css`/`app.js`) links `src/ui/tokens.css` directly and toggles theme via `<html data-theme="light|dark">`, driven by `matchMedia('(prefers-color-scheme: dark)')` in `page/app.js`.

## Sources

- [Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- [Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
- [Color](https://developer.apple.com/design/human-interface-guidelines/color)
- [Icons](https://developer.apple.com/design/human-interface-guidelines/icons)
- [Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)
- [Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls)
- [Pop-up buttons](https://developer.apple.com/design/human-interface-guidelines/pop-up-buttons)
- [Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields)
- [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields)
