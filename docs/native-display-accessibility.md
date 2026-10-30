# Native display-accessibility bridge

macOS 13 (Safari 16 / WKWebView) has no `prefers-reduced-transparency`. The native shell mirrors the system
"Reduce transparency" setting to the page:

- `<html data-reduce-transparency>` is present (empty value) while the setting is on, absent otherwise. It is set by a
  main-frame `atDocumentStart` user script, so the first paint already has the right value.
- When the setting changes while the app runs, the attribute is updated in place and `window` receives
  `daylight-display-accessibility` with `detail: { reduceTransparency: boolean }`. No reload is needed.
- One-way only: no script message handler is registered. In a plain browser (no shell) the attribute is never set, so CSS
  should also honour `@media (prefers-reduced-transparency: reduce)` where available.

Source: `native/DisplayAccessibility.swift`, wired in `native/main.swift`. Manual check (needs a Mac, not covered by CI):
System Settings → Accessibility → Display → Reduce transparency, then confirm the toolbar/sticky bar becomes opaque live.
