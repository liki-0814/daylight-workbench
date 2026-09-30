"""Render the actual Launcher in an isolated AppKit app, with no task data or hotkey registration.
Screenshots (when permission is already available) go to the supplied temporary directory.
Usage: python3 test/quick-appearance-test.py /tmp/daylight-quick-review
"""
import functools
import http.server
import pathlib
import subprocess
import sys
import tempfile
import threading

root = pathlib.Path(__file__).resolve().parent.parent
output = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(tempfile.mkdtemp(prefix='daylight-quick-review-'))
output.mkdir(parents=True, exist_ok=True)

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root / 'public')))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='daylight-appearance-build-') as tmp:
        folder = pathlib.Path(tmp)
        (folder / 'main.swift').write_text(r'''
import AppKit
import WebKit

// Only the endpoint is used by Launcher; never initialize the real task/proxy service.
final class WorkbenchServer { let endpoint = CommandLine.arguments[1] }
func expect(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
func webView(in view: NSView) -> WKWebView? {
    if let web = view as? WKWebView { return web }
    return view.subviews.compactMap { webView(in: $0) }.first
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// Deliberately simulate a dark desktop: the palette must remain light and legible.
app.appearance = NSAppearance(named: .darkAqua)
let launcher = Launcher(server: WorkbenchServer())
var backdrop: NSWindow!
var timer: Timer!
var checked = false
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let canCapture = CGPreflightScreenCaptureAccess()

func capture(_ panel: NSWindow, _ name: String) {
    guard canCapture else { return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-l", String(panel.windowNumber), output.appendingPathComponent(name + ".png").path]
    try! process.run(); process.waitUntilExit()
    expect(process.terminationStatus == 0, "window screenshot")
}

DispatchQueue.main.async {
    launcher.toggle()
    let panel = NSApp.windows.first { $0 is LauncherPanel }!
    let rect = panel.frame.insetBy(dx: -60, dy: -60)
    backdrop = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
    backdrop.backgroundColor = NSColor(calibratedRed: 0.78, green: 0.84, blue: 0.94, alpha: 1)
    backdrop.orderFront(nil)
    let web = webView(in: panel.contentView!)!
    timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
        guard !checked, !web.isLoading else { return }
        checked = true
        web.evaluateJavaScript("typeof window.quickReset === 'function'") { value, _ in
            guard value as? Bool == true else { checked = false; return }
            timer.invalidate()
            expect(panel.frame.size == NSSize(width: 600, height: 104), "compact panel size")
            expect(!panel.isOpaque && panel.backgroundColor.alphaComponent == 0, "clear window")
            expect(panel.appearance?.name == .aqua, "light material on dark desktop")
            expect(web.value(forKey: "drawsBackground") as? Bool == false, "transparent WebKit backing")
            expect(web.underPageBackgroundColor.alphaComponent == 0, "clear under-page background")
            expect(panel.contentView?.layer?.masksToBounds == true, "clipped window corners")
            let effect = panel.contentView!.subviews.first { $0 is NSVisualEffectView } as! NSVisualEffectView
            expect(effect.material == .popover && effect.maskImage != nil, "masked popover material")
            let script = """
            (() => {
              quickReset();
              const input = document.querySelector('#quick-input');
              const style = getComputedStyle(input);
              return { embedded: document.documentElement.classList.contains('embedded'),
                scheme: getComputedStyle(document.documentElement).colorScheme,
                weight: style.fontWeight, size: style.fontSize,
                focused: document.activeElement === input,
                fits: document.documentElement.scrollHeight === innerHeight };
            })()
            """
            web.evaluateJavaScript(script) { value, error in
                expect(error == nil, "palette loaded")
                let state = value as! [String: Any]
                expect(state["scheme"] as? String == "light", "web/native appearance agrees")
                expect(state["weight"] as? String == "400" && state["size"] as? String == "20px", "system type hierarchy")
                expect(state["fits"] as? Bool == true && state["embedded"] as? Bool == true, "no panel overflow")
                expect(state["focused"] as? Bool == true, "input focused")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    capture(panel, "empty")
                    web.evaluateJavaScript("document.querySelector('#quick-input').value = 'github.com'; document.querySelector('#quick-input').dispatchEvent(new Event('input')); document.querySelector('#quick-action').textContent") { value, error in
                        expect(error == nil && value as? String == "打开网址", "URL action preserved")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                            capture(panel, "url")
                            web.evaluateJavaScript("document.querySelector('#quick-input').value = '如何在 macOS 中快速搜索 Google '.repeat(8); document.querySelector('#quick-input').dispatchEvent(new Event('input')); document.querySelector('#quick-action').textContent") { value, error in
                                expect(error == nil && value as? String == "用 Google 搜索", "search action preserved")
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                                    capture(panel, "long-query")
                                    web.evaluateJavaScript("document.querySelector('#quick-close').click()") { _, _ in
                                        expect(!panel.isVisible, "close button")
                                        print("PASS: native material, transparent backing, clipped corners, layout, focus and URL/search states")
                                        print(canCapture ? "Window captures: \(output.path)" : "SKIP screenshots: screen capture permission not granted; did not request permission")
                                        launcher.stop(); app.terminate(nil)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { expect(false, "appearance test timed out") }
app.run()
''')
        executable = folder / 'appearance-check'
        subprocess.run(['swiftc', '-target', 'arm64-apple-macos13.0', str(root / 'native/Launcher.swift'), str(folder / 'main.swift'), '-o', str(executable)], check=True)
        subprocess.run([str(executable), f'http://127.0.0.1:{server.server_port}', str(output.resolve())], check=True, timeout=30)
finally:
    server.shutdown()
    server.server_close()
