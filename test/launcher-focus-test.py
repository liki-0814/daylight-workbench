"""Exercise launcher focus without registering global hotkeys or starting services."""
import functools
import http.server
import pathlib
import subprocess
import tempfile
import threading

root = pathlib.Path(__file__).resolve().parent.parent

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def translate_path(self, path):
        if path.split('?')[0] in ('/core/ai-backends.js', '/core/ai-images.js'):
            return str(root / path.lstrip('/'))
        return super().translate_path(path)

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root / 'public')))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='daylight-launcher-focus-') as tmp:
        folder = pathlib.Path(tmp)
        (folder / 'main.swift').write_text(r'''
import AppKit
import WebKit

final class WorkbenchServer { let endpoint = CommandLine.arguments[1] }
func expect(_ condition: Bool, _ message: String) {
    if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
func webView(in view: NSView) -> WKWebView? {
    if let web = view as? WKWebView { return web }
    return view.subviews.compactMap { webView(in: $0) }.first
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let mainWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 500), styleMask: [.titled, .closable], backing: .buffered, defer: false)
mainWindow.title = "Daylight focus regression"
let launcher = Launcher(server: WorkbenchServer())
var timer: Timer!
var phase = 0
var deadline = Date().addingTimeInterval(20)
var frontmost: pid_t = 0
var panel: NSWindow!
var web: WKWebView!

DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
    frontmost = NSWorkspace.shared.frontmostApplication!.processIdentifier
    expect(frontmost != ProcessInfo.processInfo.processIdentifier && !app.isActive, "test starts in background")
    launcher.toggle()
    timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
        expect(Date() < deadline, "launcher focus test timed out")
        if phase == 0 {
            guard let found = NSApp.windows.first(where: { $0 is LauncherPanel }), let content = found.contentView, let view = webView(in: content), !view.isLoading else { return }
            panel = found; web = view; phase = 1
            web.evaluateJavaScript("typeof quickReset === 'function'") { value, _ in
                guard value as? Bool == true else { phase = 0; return }
                expect(panel.isVisible && panel.isKeyWindow, "palette receives keyboard focus")
                expect(!mainWindow.isVisible, "closed workbench stays closed")
                expect(NSWorkspace.shared.frontmostApplication?.processIdentifier == frontmost, "palette preserves frontmost app")
                app.sendEvent(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber, context: nil, characters: "\u{f703}", charactersIgnoringModifiers: "\u{f703}", isARepeat: false, keyCode: 124)!)
                web.evaluateJavaScript("document.querySelector('[data-segment-value=search]').getAttribute('aria-checked')") { value, error in
                    expect(error == nil && value as? String == "true", "Right switches empty input to Google")
                    // Deliver native key events through AppKit/WebKit, not DOM dispatch.
                    for (characters, code) in [("a", UInt16(0)), ("b", UInt16(11))] {
                        app.sendEvent(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber, context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code)!)
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                        web.evaluateJavaScript("document.querySelector('#quick-input').value") { value, error in
                            expect(error == nil && value as? String == "ab", "native typing reaches palette input (value=\(value ?? "nil"), responder=\(String(describing: panel.firstResponder)))")
                            phase = 2
                            // Debounce interval must have elapsed before toggling again.
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { launcher.toggle(); phase = 3 }
                        }
                    }
                }
            }
        } else if phase == 3 && !panel.isVisible {
            expect(NSWorkspace.shared.frontmostApplication?.processIdentifier == frontmost && !mainWindow.isVisible, "toggle dismissal preserves background workbench")
            phase = 4
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { launcher.toggle(); phase = 5 }
        } else if phase == 5 && panel.isVisible {
            phase = 6
            web.evaluateJavaScript("document.querySelector('#quick-input').value") { value, error in
                expect(error == nil && value as? String == "", "reopening clears query")
                app.sendEvent(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!)
                phase = 7
            }
        } else if phase == 7 && !panel.isVisible {
            expect(NSWorkspace.shared.frontmostApplication?.processIdentifier == frontmost && !mainWindow.isVisible, "Escape preserves background workbench")
            print("PASS: palette preserves frontmost app; native typing, mode switch, toggle, reset and Escape work")
            timer.invalidate(); launcher.stop(); app.terminate(nil)
        }
    }
}
app.run()
''')
        executable = folder / 'launcher-focus-check'
        subprocess.run(['swiftc', '-target', 'arm64-apple-macos13.0', str(root / 'native/Launcher.swift'), str(folder / 'main.swift'), '-o', str(executable)], check=True)
        subprocess.run([str(executable), f'http://127.0.0.1:{server.server_port}'], check=True, timeout=30)
finally:
    server.shutdown()
    server.server_close()
