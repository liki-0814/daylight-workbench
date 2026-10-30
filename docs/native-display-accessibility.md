# Native display-accessibility bridge

macOS 13 (Safari 16 / WKWebView) has no `prefers-reduced-transparency`. The native shell mirrors the system
"Reduce transparency" setting to the page:

- `<html data-reduce-transparency>` is present (empty value) while the setting is on, absent otherwise. It is set by a
  main-frame `atDocumentStart` user script, so the first paint already has the right value.
- When the setting changes while the app runs, the attribute is updated in place and `window` receives
  `daylight-display-accessibility` with `detail: { reduceTransparency: boolean }`. No reload is needed.
- One-way only: no script message handler is registered. In a plain browser (no shell) the attribute is never set, so CSS
  should also honour `@media (prefers-reduced-transparency: reduce)` where available.

Both web views follow it: the main window (`native/main.swift`) and the quick-panel palette (`native/Launcher.swift`, which receives the same `DisplayAccessibility` instance and installs the user script before its web view is created). One observer serves all views.

Source: `native/DisplayAccessibility.swift`. Manual check (needs a Mac, not covered by CI; **the Swift here has not been compiled or run**):
System Settings → Accessibility → Display → Reduce transparency, then confirm the toolbar/sticky bar **and the quick panel (Option+Space)** become opaque live.
