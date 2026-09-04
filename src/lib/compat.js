// Chromium has no `browser` global; alias the promise-based chrome.* namespace (MV3).
if (typeof browser === 'undefined') globalThis.browser = chrome;
