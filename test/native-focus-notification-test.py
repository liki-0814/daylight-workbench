"""Exercise the native durable notification boundary; injected delivery never calls the OS."""
import json
import pathlib
import subprocess
import tempfile

root = pathlib.Path(__file__).resolve().parent.parent
core = root / 'dist/native/Daylight.app/Contents/Resources/native-core.js'
fixture_script = """
import {initialFocusRecord,applyFocusAction,reconcileFocus} from './core/focus-model.js';
const now=1577872800000;
const taskState={projects:[],tasks:[{id:'task-a',title:'隔离通知消费者',status:'todo',projectId:null}]};
const record=initialFocusRecord({timeZone:'UTC'});
const started=applyFocusAction(record,{type:'focus.start',phase:'work',taskId:'task-a',durationSeconds:60},{now,sessionId:'notification-fixture',taskState});
console.log(JSON.stringify(reconcileFocus(started.nextRecord,{now:now+60000,taskState}).nextRecord));
"""
fixture = subprocess.check_output(['node', '--input-type=module', '-e', fixture_script], cwd=root)

# Keep source, module cache, and synthetic records in a disposable workspace tree.
with tempfile.TemporaryDirectory(prefix='.native-notification-test-', dir=root / 'dist') as temporary:
    directory = pathlib.Path(temporary)
    for name in ['failure', 'crash']:
        target = directory / name
        target.mkdir()
        (target / 'focus.json').write_bytes(fixture)
    source = directory / 'main.swift'
    source.write_text(r'''import Foundation
import JavaScriptCore

struct Failure: LocalizedError { let message: String; var errorDescription: String? { message } }
func jsonText(_ value: Any) throws -> String { String(data: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]), encoding: .utf8)! }
func matches(_ text: String, _ pattern: String) -> Bool { text.range(of: pattern, options: .regularExpression) != nil }
func queryPairs(_ query: String) -> [[String]] { [] }

// Bind production Focus to its real serial queue and JSContext, without opening a listener.
final class WorkbenchServer {
    let queue = DispatchQueue(label: "daylight.notification.test", autoreleaseFrequency: .workItem)
    let port: UInt16 = 12345
    var focus: Focus!
    init(_ directory: URL, core: String) {
        queue.sync {
            let engine = JSContext()!
            engine.evaluateScript(core)
            precondition(engine.exception == nil)
            focus = Focus(engine: engine, queue: queue, directory: directory, getTasks: {
                ["version": 0, "state": ["projects": [], "tasks": [["id": "task-a", "title": "隔离通知消费者", "status": "todo"]]]]
            }, onChanged: {})
        }
    }
    func updateFocusPlatform(_ status: [String: Any]) {}
    func snapshot() throws -> [String: Any] { try queue.sync { try focus.snapshot(reconcileFirst: false) } }
    func close() { queue.sync { focus.close() } }
}
func drain(_ queue: DispatchQueue) {
    var done = false
    queue.async { DispatchQueue.main.async { done = true } }
    let deadline = Date().addingTimeInterval(5)
    while !done && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    precondition(done, "native notification queue did not drain")
}
func outcome(_ snapshot: [String: Any]) -> [String: Any] { snapshot["lastOutcome"] as! [String: Any] }
func notificationState(_ snapshot: [String: Any]) -> String { (outcome(snapshot)["notification"] as! [String: Any])["state"] as! String }
func disk(_ directory: URL) throws -> [String: Any] { try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("focus.json"))) as! [String: Any] }

precondition(CommandLine.arguments.count == 3, "notification test expects data directory and native core path")
let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let core = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
let failureDirectory = directory.appendingPathComponent("failure")
let first = WorkbenchServer(failureDirectory, core: core)
let pending = try first.snapshot()
precondition(notificationState(pending) == "pending")
let beforeVersion = (pending["version"] as! NSNumber).intValue
let beforeDisk = try Data(contentsOf: failureDirectory.appendingPathComponent("focus.json"))
let previous = failureDirectory.appendingPathComponent("focus.previous.json")
try FileManager.default.createDirectory(at: previous, withIntermediateDirectories: false)
let request: [String: Any] = ["requestId": "notification-save-failure-1", "expectedVersion": beforeVersion,
    "action": ["type": "focus.settings", "settings": ["soundEnabled": false]]]
let failedResponse = first.queue.sync { first.focus.handle(path: "/api/focus/actions", query: "", body: Data((try! jsonText(request)).utf8)) }
let failedValue = failedResponse.1 as! [String: Any]
precondition(failedResponse.0 == 503 && failedValue["code"] as! String == "FOCUS_SAVE_FAILED")
precondition((failedValue["version"] as! NSNumber).intValue == beforeVersion)
precondition(!(failedValue["error"] as! String).contains(failureDirectory.path), "save failure leaked a local path")
var deliveries = 0
let consumer = FocusNotificationConsumer(queue: first.queue, consume: { try first.focus.consumeNotification($0) }, settings: {
    try first.focus.snapshot(reconcileFirst: false)["settings"] as! [String: Any]
}, deliver: { value, _ in
    // This is an injected observer, not UserNotifications or an OS-delivery assertion.
    deliveries += 1
    precondition(notificationState(try! disk(failureDirectory)) == "attempted", "delivery ran before durable consumption")
    precondition(value["id"] as! String == outcome(pending)["id"] as! String)
})
consumer.process(pending, ready: false)
drain(first.queue)
precondition(deliveries == 0)
consumer.process(pending, ready: true)
drain(first.queue)
precondition(deliveries == 0, "failed intent save submitted a notification")
let afterFailure = try first.snapshot()
let afterFailureDisk = try Data(contentsOf: failureDirectory.appendingPathComponent("focus.json"))
precondition(notificationState(afterFailure) == "pending")
precondition((afterFailure["version"] as! NSNumber).intValue == beforeVersion)
precondition(afterFailureDisk == beforeDisk)
try FileManager.default.removeItem(at: previous)
consumer.process(pending, ready: true)
consumer.process(pending, ready: true)
drain(first.queue)
precondition(deliveries == 1, "successful retry did not consume exactly the pending intent")
consumer.process(pending, ready: true) // Stale pending DTO still checks the durable authority.
drain(first.queue)
precondition(deliveries == 1)
consumer.stop(); first.close()

let crashDirectory = directory.appendingPathComponent("crash")
let beforeCrash = WorkbenchServer(crashDirectory, core: core)
let oldPending = try beforeCrash.snapshot()
_ = try beforeCrash.queue.sync { try beforeCrash.focus.consumeNotification(outcome(oldPending)["id"] as! String) }
let attemptedDisk = try disk(crashDirectory)
precondition(notificationState(attemptedDisk) == "attempted")
beforeCrash.close() // Crash window: the real durable consume succeeded, but no OS submission ran.
let restarted = WorkbenchServer(crashDirectory, core: core)
let afterRestart = try restarted.snapshot()
precondition(notificationState(afterRestart) == "attempted")
var afterRestartDeliveries = 0
let recoveredConsumer = FocusNotificationConsumer(queue: restarted.queue, consume: { try restarted.focus.consumeNotification($0) }, settings: {
    try restarted.focus.snapshot(reconcileFirst: false)["settings"] as! [String: Any]
}, deliver: { _, _ in afterRestartDeliveries += 1 })
recoveredConsumer.process(try restarted.snapshot(), ready: true)
recoveredConsumer.process(oldPending, ready: true)
drain(restarted.queue)
precondition(afterRestartDeliveries == 0, "restart resubmitted an already attempted intent")
let afterRestartDisk = try disk(crashDirectory)
precondition(notificationState(afterRestartDisk) == "attempted")
recoveredConsumer.stop(); restarted.close()
print("PASS: native intent-save failure submits nothing; retry persists attempted before injected delivery; attempted restart and stale pending DTO never resubmit (no OS notification invoked)")
''')
    # Interpret exact production sources using the system Swift tool, without a new ad-hoc executable.
    # HTTP focus-contract-test.py separately covers the actual packaged native binary.
    adapter_source = (root / 'native/FocusNotifications.swift').read_text()
    begin = adapter_source.index('final class FocusNotificationConsumer {')
    end = adapter_source.index('/// GUI-only permission bridge', begin)
    consumer_source = adapter_source[begin:end]
    assert consumer_source.startswith('final class FocusNotificationConsumer {')
    harness_source = source.read_text()
    source.write_text('\n'.join([
        (root / 'native/FocusTimeZone.swift').read_text(),
        (root / 'native/Focus.swift').read_text(),
        consumer_source,
        harness_source,
    ]))
    subprocess.run(['/usr/bin/swift', '-target', 'arm64-apple-macos13.0',
                    '-module-cache-path', str(directory / 'cache'),
                    str(source), str(directory), str(core)], check=True, timeout=120)
