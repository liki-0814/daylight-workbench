import Foundation
import Darwin

// DaylightUpdater: replaces the installed app after Daylight has quit, verifies the new app and rolls back when it
// does not come up. It runs detached from the app it replaces and never links against the app's code.
// Usage: DaylightUpdater --mode install|rollback --parent-pid N --target App --source App --backup-dir DIR --updates-dir DIR
//        --expected-version V --from-version V --bundle-id ID --relaunch 1|0 [--relaunch-env K=V]... [--relaunch-arg A]...

setsid()
signal(SIGPIPE, SIG_IGN)

var options: [String: [String]] = [:]
do {
    var index = 1
    let args = CommandLine.arguments
    while index + 1 < args.count, args[index].hasPrefix("--") {
        options[String(args[index].dropFirst(2)), default: []].append(args[index + 1]); index += 2
    }
}
func option(_ name: String) -> String? { options[name]?.last }
func required(_ name: String) -> String {
    guard let value = option(name), !value.isEmpty else { fputs("missing --\(name)\n", stderr); exit(2) }
    return value
}

let mode = required("mode")
let parentPID = Int32(required("parent-pid")) ?? 0
let target = URL(fileURLWithPath: required("target"))
let source = URL(fileURLWithPath: required("source"))
let backupDirectory = URL(fileURLWithPath: required("backup-dir"))
let updatesDirectory = URL(fileURLWithPath: required("updates-dir"))
let expectedVersion = required("expected-version")
let fromVersion = required("from-version")
let bundleID = required("bundle-id")
let relaunch = option("relaunch") != "0"
let waitSeconds = Double(option("wait-seconds") ?? "") ?? 30
let healthSeconds = Double(option("health-seconds") ?? "") ?? 60
let smokeSeconds = Double(option("smoke-seconds") ?? "") ?? 20
let fm = FileManager.default
let logURL = updatesDirectory.appendingPathComponent("helper.log")
let healthURL = updatesDirectory.appendingPathComponent("health.json")
let resultURL = updatesDirectory.appendingPathComponent("last-result.json")
let isoFormatter = ISO8601DateFormatter()

func log(_ message: String) {
    let line = "\(isoFormatter.string(from: Date())) [\(getpid())] \(message)\n"
    if let handle = try? FileHandle(forWritingTo: logURL) { handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close() }
    else { try? Data(line.utf8).write(to: logURL) }
}

func finish(_ status: String, _ message: String) -> Never {
    var result: [String: Any] = ["id": UUID().uuidString.lowercased(), "kind": mode, "status": status, "from": fromVersion, "to": expectedVersion, "message": message, "at": isoFormatter.string(from: Date()), "relaunch": relaunch]
    if status == "rolled-back" || status == "failed" { result["restored"] = fromVersion }
    if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
        let temporary = updatesDirectory.appendingPathComponent(".last-result.\(getpid()).tmp")
        try? data.write(to: temporary)
        _ = rename(temporary.path, resultURL.path)
    }
    log("result \(status): \(message)")
    exit(status == "success" ? 0 : 1)
}

func isAlive(_ pid: Int32) -> Bool { pid > 0 && (kill(pid, 0) == 0 || errno == EPERM) }

@discardableResult
func run(_ path: String, _ arguments: [String], environment: [String: String]? = nil, timeout: TimeInterval = 60) -> (status: Int32, output: String) {
    let task = Process(), pipe = Pipe()
    task.executableURL = URL(fileURLWithPath: path); task.arguments = arguments
    if let environment { task.environment = environment }
    task.standardOutput = pipe; task.standardError = pipe
    let done = DispatchSemaphore(value: 0)
    task.terminationHandler = { _ in done.signal() }
    var data = Data()
    let reading = DispatchGroup(); reading.enter()
    DispatchQueue.global().async { data = pipe.fileHandleForReading.readDataToEndOfFile(); reading.leave() }
    do { try task.run() } catch { return (127, "\(error)") }
    if done.wait(timeout: .now() + timeout) == .timedOut { task.terminate(); _ = done.wait(timeout: .now() + 3); reading.wait(); return (124, "timeout") }
    reading.wait()
    return (task.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

func info(_ app: URL) -> [String: Any]? {
    (try? PropertyListSerialization.propertyList(from: Data(contentsOf: app.appendingPathComponent("Contents/Info.plist")), format: nil)) as? [String: Any]
}

func designatedRequirement(_ app: URL) -> String? {
    let result = run("/usr/bin/codesign", ["-d", "-r-", app.path])
    guard let line = result.output.split(separator: "\n").first(where: { $0.hasPrefix("designated => ") || $0.hasPrefix("# designated => ") }) else { return nil }
    return line.drop(while: { $0 == "#" || $0 == " " }).dropFirst("designated => ".count).split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ")
}

/// nil when the bundle is intact, belongs to this product and has the expected version.
func problem(with app: URL, version: String) -> String? {
    let verify = run("/usr/bin/codesign", ["--verify", "--strict", "--deep", app.path])
    if verify.status != 0 { return "签名校验失败：\(verify.output.trimmingCharacters(in: .whitespacesAndNewlines))" }
    guard let plist = info(app) else { return "无法读取 Info.plist" }
    if plist["CFBundleIdentifier"] as? String != bundleID { return "App 标识不匹配" }
    if (plist["DaylightVersion"] as? String ?? plist["CFBundleShortVersionString"] as? String) != version { return "版本号与预期不一致" }
    if !fm.isExecutableFile(atPath: app.appendingPathComponent("Contents/MacOS/Daylight").path) { return "缺少可执行文件" }
    return nil
}

func move(_ from: URL, _ to: URL, copy: Bool = false) throws {
    try? fm.removeItem(at: to)
    if !copy, rename(from.path, to.path) == 0 { return }
    let copied = run("/usr/bin/ditto", [from.path, to.path], timeout: 120)
    guard copied.status == 0 else { try? fm.removeItem(at: to); throw NSError(domain: "DaylightUpdater", code: 1, userInfo: [NSLocalizedDescriptionKey: "复制失败：\(copied.output)"]) }
    if !copy { try? fm.removeItem(at: from) }
}

/// Atomically exchanges two directories; falls back to two renames on file systems without RENAME_SWAP.
func swap(_ a: URL, _ b: URL) throws {
    if renamex_np(a.path, b.path, UInt32(RENAME_SWAP)) == 0 { return }
    let holder = a.deletingLastPathComponent().appendingPathComponent(".Daylight-swap-\(UUID().uuidString.prefix(8)).app")
    guard rename(a.path, holder.path) == 0 else { throw NSError(domain: "DaylightUpdater", code: 2, userInfo: [NSLocalizedDescriptionKey: "无法替换 App（\(String(cString: strerror(errno)))）"]) }
    guard rename(b.path, a.path) == 0 else { _ = rename(holder.path, a.path); throw NSError(domain: "DaylightUpdater", code: 3, userInfo: [NSLocalizedDescriptionKey: "无法替换 App（\(String(cString: strerror(errno)))）"]) }
    guard rename(holder.path, b.path) == 0 else { throw NSError(domain: "DaylightUpdater", code: 4, userInfo: [NSLocalizedDescriptionKey: "替换后无法整理旧版本"]) }
}

func processes(under app: URL) -> [Int32] {
    // LaunchServices reports the resolved path (/private/var…), the caller may have passed the symlinked one.
    // (Foundation's resolvingSymlinksInPath strips /private again, so use realpath.)
    var paths = [app.path]
    if let resolved = realpath(app.path, nil) { paths.append(String(cString: resolved)); free(resolved) }
    let prefixes = paths.map { $0 + "/Contents/MacOS/Daylight" }
    return run("/bin/ps", ["-axo", "pid=,command="]).output.split(separator: "\n").compactMap { line in
        let parts = line.drop { $0 == " " }.split(separator: " ", maxSplits: 1)
        guard parts.count == 2, prefixes.contains(where: { parts[1].hasPrefix($0) }), let pid = Int32(parts[0]) else { return nil }
        return pid
    }
}

func stop(_ app: URL) {
    // `open` returns before LaunchServices has finished starting the app, so keep scanning until nothing new appears.
    let started = Date()
    var quietScans = 0
    while quietScans < 2, Date().timeIntervalSince(started) < 15 {
        let running = processes(under: app)
        if running.isEmpty { quietScans += 1; Thread.sleep(forTimeInterval: 0.4); continue }
        quietScans = 0
        log("stopping \(running)")
        let signal = Date().timeIntervalSince(started) > 5 ? SIGKILL : SIGTERM
        for pid in running { kill(pid, signal) }
        Thread.sleep(forTimeInterval: 0.3)
    }
}

func launchApp(_ app: URL) -> Bool {
    // LaunchServices must not inherit the old app's environment; only what the parent explicitly asked for is passed.
    var environment: [String: String] = [:]
    for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "__CF_USER_TEXT_ENCODING"] { if let value = ProcessInfo.processInfo.environment[key] { environment[key] = value } }
    environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
    var arguments = ["-n", app.path]
    for pair in options["relaunch-env"] ?? [] { arguments += ["--env", pair] }
    let extra = options["relaunch-arg"] ?? []
    if !extra.isEmpty { arguments += ["--args"] + extra }
    let result = run("/usr/bin/open", arguments, environment: environment, timeout: 20)
    if result.status != 0 { log("open failed: \(result.output)") }
    return result.status == 0
}

func waitForHealth() -> Bool {
    let deadline = Date().addingTimeInterval(healthSeconds)
    while Date() < deadline {
        if let data = try? Data(contentsOf: healthURL), let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           object["version"] as? String == expectedVersion, let pid = object["pid"] as? Int, isAlive(Int32(pid)) { return true }
        Thread.sleep(forTimeInterval: 0.5)
    }
    return false
}

/// Quit-time installs have no app to watch, so the new build is started headless on a scratch port and data directory.
func smokeTest() -> Bool {
    let scratch = fm.temporaryDirectory.appendingPathComponent("daylight-smoke-\(UUID().uuidString.prefix(8))")
    try? fm.createDirectory(at: scratch, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? fm.removeItem(at: scratch) }
    let task = Process(), output = Pipe()
    task.executableURL = target.appendingPathComponent("Contents/MacOS/Daylight"); task.arguments = ["--headless"]
    task.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin", "WORKBENCH_DATA_DIR": scratch.path, "PORT": String(Int.random(in: 41000...48999))]
    task.standardOutput = output; task.standardError = FileHandle.nullDevice
    let ready = DispatchSemaphore(value: 0)
    var seen = Data()
    output.fileHandleForReading.readabilityHandler = { handle in
        let data = handle.availableData
        if data.isEmpty { return }
        seen.append(data)
        if String(data: seen, encoding: .utf8)?.contains("READY") == true { ready.signal() }
    }
    do { try task.run() } catch { return false }
    let ok = ready.wait(timeout: .now() + smokeSeconds) == .success
    output.fileHandleForReading.readabilityHandler = nil
    if task.isRunning { task.terminate(); Thread.sleep(forTimeInterval: 1); if task.isRunning { kill(task.processIdentifier, SIGKILL) } }
    return ok
}

log("start mode=\(mode) \(fromVersion)→\(expectedVersion) target=\(target.path) relaunch=\(relaunch)")
let waitDeadline = Date().addingTimeInterval(waitSeconds)
while isAlive(parentPID), Date() < waitDeadline { Thread.sleep(forTimeInterval: 0.1) }
if isAlive(parentPID) { finish("failed", "等待 Daylight 退出超时，未做任何修改") }

guard fm.fileExists(atPath: target.path), fm.fileExists(atPath: source.path) else { finish("failed", "找不到要替换的 App 或更新包，未做任何修改") }
try? fm.createDirectory(at: backupDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
let staging = target.deletingLastPathComponent().appendingPathComponent(".Daylight-update-\(UUID().uuidString.prefix(8)).app")
let pending = backupDirectory.appendingPathComponent("Daylight.app.pending")
let backup = backupDirectory.appendingPathComponent("Daylight.app")

do { try move(source, staging, copy: mode == "rollback") } catch { finish("failed", "无法准备新版本：\(error.localizedDescription)") }
if let issue = problem(with: staging, version: expectedVersion) { try? fm.removeItem(at: staging); finish("failed", "新版本未通过校验，未做任何修改：\(issue)") }
if mode == "install", let expected = designatedRequirement(target), let actual = designatedRequirement(staging), expected != actual {
    try? fm.removeItem(at: staging); finish("failed", "新版本的签名身份与当前版本不同，未做任何修改")
}
do { try swap(target, staging) } catch { try? fm.removeItem(at: staging); finish("failed", error.localizedDescription) }
// `staging` now holds the previous app. Park it as the pending backup.
do { try move(staging, pending) } catch { log("could not park previous app: \(error)") }

func restorePrevious(_ reason: String) -> Never {
    if relaunch { stop(target) }
    let restore = target.deletingLastPathComponent().appendingPathComponent(".Daylight-restore-\(UUID().uuidString.prefix(8)).app")
    do {
        try move(pending, restore)
        try swap(target, restore)
        try? fm.removeItem(at: restore)
        if relaunch { try? fm.removeItem(at: healthURL); _ = launchApp(target) }
        finish("rolled-back", "\(reason)，已恢复到 \(fromVersion)")
    } catch { finish("failed", "\(reason)，并且恢复旧版本失败：\(error.localizedDescription)。旧版本保留在 \(pending.path)") }
}

if let issue = problem(with: target, version: expectedVersion) { restorePrevious("替换后校验失败：\(issue)") }
if relaunch {
    try? fm.removeItem(at: healthURL)
    guard launchApp(target) else { restorePrevious("新版本无法启动") }
    if !waitForHealth() { restorePrevious("新版本在 \(Int(healthSeconds)) 秒内没有报告运行正常") }
} else if !smokeTest() { restorePrevious("新版本启动自检失败") }

// Healthy: the pending app becomes the single kept backup.
try? fm.removeItem(at: backup)
if fm.fileExists(atPath: pending.path), rename(pending.path, backup.path) == 0,
   let data = try? JSONSerialization.data(withJSONObject: ["version": fromVersion, "createdAt": isoFormatter.string(from: Date())], options: [.sortedKeys]) {
    try? data.write(to: backupDirectory.appendingPathComponent("backup.json"))
}
try? fm.removeItem(at: updatesDirectory.appendingPathComponent(expectedVersion))
finish("success", mode == "rollback" ? "已回滚到 \(expectedVersion)" : "已更新到 \(expectedVersion)")
