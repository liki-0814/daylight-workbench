import AppKit
import WebKit
import Carbon.HIToolbox

/// 快速搜索：⌥Space 全局唤出无边框毛玻璃面板，输入内容后交给 Chrome 打开。
final class LauncherPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

private func launcherHotKeyHandler(_ call: EventHandlerCallRef?, _ event: EventRef?, _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    guard let event, let userData else { return OSStatus(eventNotHandledErr) }
    var identifier = EventHotKeyID()
    guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &identifier) == noErr else { return OSStatus(eventNotHandledErr) }
    let launcher = Unmanaged<Launcher>.fromOpaque(userData).takeUnretainedValue()
    DispatchQueue.main.async { launcher.toggle() }
    return noErr
}

final class Launcher: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private let server: WorkbenchServer
    private var panel: LauncherPanel?
    private var web: WKWebView?
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var lastToggle = Date.distantPast

    init(server: WorkbenchServer) { self.server = server; super.init() }

    /// 注册全局快捷键；被其他应用占用时保持静默，菜单里的入口仍然可用。
    func install() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(GetApplicationEventTarget(), launcherHotKeyHandler, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &handlerRef)
        guard installed == noErr else { return }
        let identifier = EventHotKeyID(signature: OSType(0x44514C54), id: 1) // 'DQLT'
        if RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), identifier, GetApplicationEventTarget(), 0, &hotKeyRef) != noErr {
            if let handlerRef { RemoveEventHandler(handlerRef) }
            handlerRef = nil
        }
    }

    func stop() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef); self.hotKeyRef = nil }
        if let handlerRef { RemoveEventHandler(handlerRef); self.handlerRef = nil }
        panel?.orderOut(nil)
    }

    func toggle() {
        // 菜单项与全局快捷键可能同时触发，忽略紧随其后的重复调用。
        let now = Date()
        if now.timeIntervalSince(lastToggle) < 0.35 { return }
        lastToggle = now
        if panel?.isVisible == true { panel?.orderOut(nil); return }
        present()
    }

    private func present() {
        let panel = build()
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main {
            let area = screen.visibleFrame, size = panel.frame.size
            panel.setFrameOrigin(NSPoint(x: (area.midX - size.width / 2).rounded(), y: (area.maxY - area.height * 0.28 - size.height).rounded()))
        }
        panel.makeKeyAndOrderFront(nil)
        if !panel.isKeyWindow { NSApp.activate(ignoringOtherApps: true); panel.makeKey() }
        web?.evaluateJavaScript("window.quickReset && window.quickReset()")
    }

    private func build() -> LauncherPanel {
        if let panel { return panel }
        let bounds = NSRect(x: 0, y: 0, width: 600, height: 104)
        let surface = NSView(frame: bounds)
        surface.wantsLayer = true
        surface.layer?.backgroundColor = NSColor.clear.cgColor
        surface.layer?.cornerRadius = 16
        surface.layer?.cornerCurve = .continuous
        surface.layer?.masksToBounds = true

        let background = NSVisualEffectView(frame: bounds)
        background.material = .popover
        background.blendingMode = .behindWindow
        background.state = .active
        background.autoresizingMask = [.width, .height]
        // Mask the native blur as well as the web layer: otherwise the compositor
        // can leave a rectangular rim outside the rounded panel.
        background.maskImage = NSImage(size: bounds.size, flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: 16, yRadius: 16).fill()
            return true
        }
        surface.addSubview(background)

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "quick")
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        // WebKit exposes this through KVC, not a public setDrawsBackground:
        // selector. Testing that selector skipped transparency and left white corners.
        web.setValue(false, forKey: "drawsBackground")
        web.underPageBackgroundColor = .clear
        web.translatesAutoresizingMaskIntoConstraints = false
        surface.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: surface.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: surface.trailingAnchor),
            web.topAnchor.constraint(equalTo: surface.topAnchor),
            web.bottomAnchor.constraint(equalTo: surface.bottomAnchor),
        ])
        web.load(URLRequest(url: URL(string: server.endpoint + "/quick.html?embed=1")!))

        let panel = LauncherPanel(contentRect: bounds, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        // Keep the palette's light material and web color scheme in agreement,
        // just like the main Daylight window, including on a dark desktop.
        panel.appearance = NSAppearance(named: .aqua)
        panel.contentView = surface
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .utilityWindow
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        NotificationCenter.default.addObserver(self, selector: #selector(panelDidResignKey(_:)), name: NSWindow.didResignKeyNotification, object: panel)
        self.panel = panel; self.web = web
        return panel
    }

    @objc private func panelDidResignKey(_ notification: Notification) { (notification.object as? NSWindow)?.orderOut(nil) }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "quick", let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "close" { panel?.orderOut(nil); return }
        guard type == "open", let text = body["url"] as? String, let url = URL(string: text) else { return }
        panel?.orderOut(nil)
        if let application = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") {
            NSWorkspace.shared.open([url], withApplicationAt: application, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url { NSWorkspace.shared.open(url); decisionHandler(.cancel); return }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }
}
