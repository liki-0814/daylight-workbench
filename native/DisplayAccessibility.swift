import AppKit
import WebKit

/// One-way bridge from the macOS "Reduce transparency" setting to the page.
///
/// WKWebView on macOS 13 (Safari 16) has no `prefers-reduced-transparency`, so the page cannot ask for it.
/// The shell therefore reads `NSWorkspace.accessibilityDisplayShouldReduceTransparency` and mirrors it as the
/// `data-reduce-transparency` attribute on `<html>` (present = reduced) plus a `daylight-display-accessibility`
/// window event for pages that need to react without reloading.
/// No script message handler is registered: the page cannot call back into the app through this bridge.
final class DisplayAccessibility {
    static let attribute = "data-reduce-transparency"
    static let event = "daylight-display-accessibility"
    private let read: () -> Bool
    private weak var controller: WKUserContentController?
    private weak var web: WKWebView?
    private var observer: NSObjectProtocol?
    private(set) var reduceTransparency = false

    init(read: @escaping () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency }) { self.read = read }

    /// Idempotent script: sets or clears the attribute and announces a change only when the value changed.
    static func script(reduceTransparency: Bool) -> String {
        #"""
        (function (reduce) {
          var root = document.documentElement; if (!root) return;
          var changed = root.hasAttribute('data-reduce-transparency') !== reduce;
          if (reduce) root.setAttribute('data-reduce-transparency', ''); else root.removeAttribute('data-reduce-transparency');
          if (changed) window.dispatchEvent(new CustomEvent('daylight-display-accessibility', { detail: { reduceTransparency: reduce } }));
        })(\#(reduceTransparency ? "true" : "false"));
        """#
    }

    /// Call before the first navigation so every main-frame load starts with the right attribute.
    /// The controller must carry no other user scripts: a change replaces them all.
    func install(into controller: WKUserContentController) {
        self.controller = controller
        reduceTransparency = read()
        addScript()
    }

    /// Start following system changes and keep the already-loaded page in sync.
    func attach(_ web: WKWebView) {
        self.web = web
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in self?.refresh() }
    }

    func refresh() {
        let next = read()
        guard next != reduceTransparency else { return }
        reduceTransparency = next
        controller?.removeAllUserScripts(); addScript()
        web?.evaluateJavaScript(DisplayAccessibility.script(reduceTransparency: next))
    }

    func stop() {
        if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        observer = nil; controller?.removeAllUserScripts(); web = nil
    }

    private func addScript() {
        controller?.addUserScript(WKUserScript(source: DisplayAccessibility.script(reduceTransparency: reduceTransparency), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
}
