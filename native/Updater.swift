import AppKit
import CryptoKit
import Foundation

/// In-app updates. Everything is verified before it can replace the installed app:
/// the Ed25519 signature of latest-mac.json, the zip's size and SHA-256 (also against GitHub's own digest),
/// the extracted bundle's code signature, bundle identifier, version, and designated requirement.
/// The replacement itself is done by the bundled DaylightUpdater helper after this process has quit.
final class AppUpdater: NSObject, URLSessionDownloadDelegate {
    struct Plan {
        let version: String
        let url: String
        let size: Int64
        let sha256: String
        let githubDigest: String?
    }

    unowned let server: WorkbenchServer
    let queue = DispatchQueue(label: "daylight.updater")
    let updates: URL
    let currentVersion: String
    let bundleID: String
    let bundleURL: URL
    let publicKey: Data?
    /// Isolated test runs may point release traffic at a local mock server. Never honoured in a normal launch.
    let testBase: String?
    let backgroundEnabled: Bool
    var onReady: ((String) -> Void)?
    var onPrompt: ((String) -> Void)?

    private let lock = NSLock()
    private var session: URLSession!
    private var task: URLSessionDownloadTask?
    private var phase = "idle"
    private var received: Int64 = 0
    private var total: Int64 = 0
    private var targetVersion: String?
    private var failure: [String: String]?
    private var reauth: [String: Any]?
    private var staged: [String: Any]?
    private var plan: Plan?
    private var mode = "notify"
    private var currentDR: String?
    private var signing = "unknown"
    private var support: [String: Any] = ["supported": false, "reason": "checking", "message": "正在检查安装环境…"]
    private var history: [[String: Any]] = []
    private var backupInfo: [String: Any]?
    private var lastResult: [String: Any]?
    private var acknowledgedResult: String?
    private var installing = false
    private var healthWritten = false
    private var resultStamp: Date?
    private var promptedVersion: String?
    private var downloadedFile: URL?
    private var cancelRequested = false
    private var autoFailedVersion: String?
    private var failures = 0
    private var nextCheckAt = Date.distantFuture
    private var lastCheckedAt = Date.distantPast
    private var checking = false
    private var ticker: DispatchSourceTimer?
    private let formatter = ISO8601DateFormatter()

    init(server: WorkbenchServer) {
        self.server = server
        let info = Bundle.main.infoDictionary ?? [:]
        currentVersion = info["CFBundleShortVersionString"] as? String ?? ""
        bundleID = Bundle.main.bundleIdentifier ?? ""
        bundleURL = Bundle.main.bundleURL
        updates = server.directory.appendingPathComponent("updates")
        let key = (info["DaylightUpdatePublicKey"] as? String).flatMap { Data(base64Encoded: $0) }
        publicKey = key?.count == 32 ? key : nil
        let env = ProcessInfo.processInfo.environment
        let isolated = env["WORKBENCH_DATA_DIR"] != nil && env["PORT"] != nil && env["PORT"] != "4318"
        let base = env["DAYLIGHT_UPDATE_TEST_BASE"]
        testBase = isolated && base?.hasPrefix("http://127.0.0.1:") == true ? base : nil
        backgroundEnabled = !CommandLine.arguments.contains("--headless") && (testBase == nil || env["DAYLIGHT_UPDATE_BACKGROUND"] == "1")
        super.init()
        let operations = OperationQueue()
        operations.maxConcurrentOperationCount = 1
        operations.underlyingQueue = queue
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 30 * 60
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: operations)
        formatter.formatOptions = [.withInternetDateTime]
    }

    // MARK: Paths and small helpers

    private func directory(_ version: String) -> URL { updates.appendingPathComponent(version) }
    private func stagedApp(_ version: String) -> URL { directory(version).appendingPathComponent("extract/Daylight.app") }
    private var backupDirectory: URL { updates.appendingPathComponent("backup") }
    private var settingsFile: URL { updates.appendingPathComponent("settings.json") }
    private var healthFile: URL { updates.appendingPathComponent("health.json") }
    private var resultFile: URL { updates.appendingPathComponent("last-result.json") }
    private var historyFile: URL { updates.appendingPathComponent("history.json") }
    private func now() -> String { formatter.string(from: Date()) }

    func mapAPI(_ url: String) -> String {
        guard let testBase else { return url }
        return testBase + "/releases/latest"
    }
    private func mapDownload(_ url: String) -> String {
        guard let testBase else { return url }
        return url.replacingOccurrences(of: "https://github.com/liki-0814/daylight-workbench/releases/download/", with: testBase + "/download/")
    }

    private func ensureDirectory(_ url: URL) {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    private func writeJSON(_ object: Any, to url: URL) {
        guard let data = try? jsonData(object) else { return }
        ensureDirectory(url.deletingLastPathComponent())
        try? data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    private func readJSON(_ url: URL) -> Any? {
        (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) }
    }

    @discardableResult
    private func run(_ path: String, _ arguments: [String], timeout: TimeInterval = 120) -> (status: Int32, output: String) {
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: path); process.arguments = arguments
        process.standardOutput = pipe; process.standardError = pipe
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        var data = Data()
        let reading = DispatchGroup(); reading.enter()
        DispatchQueue.global().async { data = pipe.fileHandleForReading.readDataToEndOfFile(); reading.leave() }
        do { try process.run() } catch { reading.leave(); return (127, "\(error)") }
        if done.wait(timeout: .now() + timeout) == .timedOut { process.terminate(); _ = done.wait(timeout: .now() + 3); reading.wait(); return (124, "timeout") }
        reading.wait()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    private func compare(_ left: String, _ right: String) -> Int? {
        try? server.queue.sync { try server.js("Daylight.compareVersions(\(try jsonText(left)),\(try jsonText(right)))") as? Int }
    }

    private func designatedRequirement(_ app: URL) -> String? {
        let output = run("/usr/bin/codesign", ["-d", "-r-", app.path], timeout: 30).output
        guard let line = output.split(separator: "\n").first(where: { $0.hasPrefix("designated => ") || $0.hasPrefix("# designated => ") }) else { return nil }
        return line.drop(while: { $0 == "#" || $0 == " " }).dropFirst("designated => ".count).split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ")
    }
    private func cdhash(_ file: URL) -> String? {
        run("/usr/bin/codesign", ["-d", "-vvv", file.path], timeout: 30).output.split(separator: "\n").first { $0.hasPrefix("CDHash=") }.map { String($0.dropFirst(7)) }
    }
    private func plist(_ app: URL) -> [String: Any]? {
        (try? PropertyListSerialization.propertyList(from: Data(contentsOf: app.appendingPathComponent("Contents/Info.plist")), format: nil)) as? [String: Any]
    }
    private func sha256Hex(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Lifecycle

    func start() {
        queue.async {
            self.ensureDirectory(self.updates)
            let saved = self.readJSON(self.settingsFile) as? [String: Any]
            self.lock.lock()
            if let value = saved?["mode"] as? String, ["notify", "download-quit", "download-prompt"].contains(value) { self.mode = value }
            self.acknowledgedResult = saved?["acknowledgedResult"] as? String
            self.history = self.readJSON(self.historyFile) as? [[String: Any]] ?? []
            self.lock.unlock()
            self.loadLastResult()
            self.refreshEnvironment()
            self.refreshBackup()
            self.recoverStaged()
            if self.backgroundEnabled { self.scheduleBackground() }
        }
    }

    private func loadLastResult() {
        guard let result = readJSON(resultFile) as? [String: Any], let id = result["id"] as? String else { return }
        lock.lock()
        lastResult = result
        if !history.contains(where: { $0["id"] as? String == id }) {
            history.insert(result, at: 0)
            history = Array(history.prefix(20))
            writeJSON(history, to: historyFile)
        }
        lock.unlock()
    }

    private func refreshEnvironment() {
        let dr = designatedRequirement(bundleURL)
        // A self-signed certificate is its own root, so its requirement reads `certificate root = H"…"` (or `certificate leaf`).
        let kind = dr == nil ? "unsigned" : dr!.contains("cdhash") ? "ad-hoc" : dr!.contains("anchor apple") ? "developer" : "self-signed"
        let parent = bundleURL.deletingLastPathComponent().path
        var value: [String: Any] = ["supported": true]
        func block(_ reason: String, _ message: String) { value = ["supported": false, "reason": reason, "message": message] }
        if !bundleURL.path.hasSuffix(".app") { block("not-app", "当前不是从 .app 运行，无法在应用内更新。") }
        else if bundleURL.path.contains("/AppTranslocation/") { block("translocated", "Daylight 正在被系统隔离运行（App Translocation）。请把它拖进「应用程序」文件夹，再重新打开。") }
        else if bundleURL.path.hasPrefix("/Volumes/") { block("read-only-volume", "Daylight 正从磁盘映像里运行。请先把它拖进「应用程序」文件夹。") }
        else if publicKey == nil { block("no-key", "这个版本没有内置更新公钥，无法验证更新包。请从 GitHub 手动下载。") }
        else if !FileManager.default.isWritableFile(atPath: parent) { block("not-writable", "没有权限替换 \(bundleURL.path) 所在的文件夹。请从 GitHub 下载 DMG 手动安装。") }
        else if dr == nil { block("unsigned", "当前版本没有签名，无法确认更新包是否来自同一发布者。请从 GitHub 手动下载。") }
        else if kind == "ad-hoc" { block("adhoc", "当前版本使用临时签名，无法在应用内直接更新到新签名版本。请从 GitHub 下载 DMG 手动安装一次，之后即可在应用内更新（系统权限和部分服务需要重新授权一次）。") }
        lock.lock(); currentDR = dr; signing = kind; support = value; lock.unlock()
    }

    private func refreshBackup() {
        let app = backupDirectory.appendingPathComponent("Daylight.app")
        guard FileManager.default.fileExists(atPath: app.path), let info = readJSON(backupDirectory.appendingPathComponent("backup.json")) as? [String: Any], let version = info["version"] as? String else {
            lock.lock(); backupInfo = nil; lock.unlock(); return
        }
        let matches = designatedRequirement(app).map { $0 == currentDR } ?? false
        lock.lock(); backupInfo = ["version": version, "createdAt": info["createdAt"] as? String ?? "", "sameSigner": matches]; lock.unlock()
    }

    /// A zip that finished verifying before the last quit stays installable.
    private func recoverStaged() {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: updates.path) else { return }
        for name in names where name.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil {
            let folder = directory(name)
            let info = readJSON(folder.appendingPathComponent("staged.json")) as? [String: Any]
            if let order = compare(currentVersion, name), order < 0, let info, info["version"] as? String == name,
               FileManager.default.fileExists(atPath: stagedApp(name).path), supportedNow(),
               run("/usr/bin/codesign", ["--verify", "--strict", "--deep", stagedApp(name).path], timeout: 60).status == 0,
               designatedRequirement(stagedApp(name)) == currentDR {
                lock.lock(); if staged == nil { staged = info; phase = "ready" }; lock.unlock()
            } else { try? FileManager.default.removeItem(at: folder) }
        }
        lock.lock(); let ready = phase == "ready" ? staged?["version"] as? String : nil; lock.unlock()
        if let ready { DispatchQueue.main.async { self.onReady?(ready) } }
    }

    private func supportedNow() -> Bool { lock.lock(); defer { lock.unlock() }; return support["supported"] as? Bool == true }

    // MARK: Status

    /// The helper writes its outcome (and the backup) after the new app is already running, so pick it up when the file appears.
    private func pickUpHelperOutcome() {
        let stamp = (try? FileManager.default.attributesOfItem(atPath: resultFile.path))?[.modificationDate] as? Date
        lock.lock(); let changed = stamp != nil && stamp != resultStamp; if changed { resultStamp = stamp }; lock.unlock()
        if changed { queue.async { self.loadLastResult(); self.refreshBackup() } }
    }

    func status() -> [String: Any] {
        pickUpHelperOutcome()
        lock.lock(); defer { lock.unlock() }
        var out: [String: Any] = [
            "supported": support["supported"] as? Bool == true, "phase": phase, "mode": mode,
            "current": ["version": currentVersion, "signing": signing, "bundlePath": bundleURL.path],
            "progress": ["received": received, "total": total], "history": history,
        ]
        if let reason = support["reason"] { out["reason"] = reason }
        if let message = support["message"] { out["message"] = message }
        if let targetVersion { out["target"] = targetVersion }
        if let failure { out["error"] = failure }
        if let reauth { out["needsReauth"] = reauth }
        if let staged { out["staged"] = ["version": staged["version"] ?? "", "size": staged["size"] ?? 0, "credentialsReset": staged["credentialsReset"] ?? false] }
        if let backupInfo { out["backup"] = backupInfo }
        if let lastResult, lastResult["id"] as? String != acknowledgedResult { out["lastResult"] = lastResult }
        return out
    }

    // MARK: Actions

    func perform(_ input: [String: Any], completion: @escaping (Int, Any) -> Void) {
        let action = input["action"] as? String ?? ""
        let force = input["force"] as? Bool == true
        queue.async {
            switch action {
            case "download": self.startDownload(completion)
            case "cancel": self.cancelDownload(completion)
            case "discard": self.discardStaged(); completion(200, self.status())
            case "install": self.requestInstall(force: force, completion)
            case "rollback": self.requestRollback(force: force, completion)
            case "ack":
                self.lock.lock(); self.acknowledgedResult = self.lastResult?["id"] as? String; self.failure = nil; self.reauth = nil; self.lock.unlock()
                self.saveSettings(); completion(200, self.status())
            case "mode":
                guard let value = input["value"] as? String, ["notify", "download-quit", "download-prompt"].contains(value) else { completion(400, ["error": "自动更新方式无效"]); return }
                self.lock.lock(); self.mode = value; self.lock.unlock()
                self.saveSettings(); completion(200, self.status())
                self.afterModeChange()
            default: completion(400, ["error": "不支持的操作"])
            }
        }
    }

    private func saveSettings() {
        lock.lock(); let value: [String: Any] = ["mode": mode, "acknowledgedResult": acknowledgedResult ?? ""]; lock.unlock()
        writeJSON(value, to: settingsFile)
    }

    private func afterModeChange() {
        lock.lock(); let idle = phase == "idle" && mode != "notify" && plan != nil; lock.unlock()
        if idle { startDownload { _, _ in } ; }
    }

    // MARK: Release verification

    /// Fetches latest-mac.json and its signature for an available release and records whether it may be installed.
    /// `completion` runs on the server queue.
    func resolve(_ record: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        var out = record
        guard record["status"] as? String == "available", var latest = record["latest"] as? [String: Any], let version = latest["version"] as? String else {
            self.lock.lock(); self.plan = nil; self.lock.unlock(); completion(out); return
        }
        func finish(_ install: [String: Any], _ value: Plan? = nil) {
            latest["install"] = install; out["latest"] = latest
            lock.lock(); plan = value; lock.unlock()
            server.queue.async { completion(out) }
        }
        queue.async {
            guard let update = latest["update"] as? [String: Any], let zip = update["zip"] as? [String: Any], let manifestAsset = update["manifest"] as? [String: Any],
                  let signatureAsset = update["signature"] as? [String: Any], let manifestURL = manifestAsset["url"] as? String, let signatureURL = signatureAsset["url"] as? String else {
                finish(["ok": false, "code": "no-package", "message": "这个发布没有应用内更新包，请下载 DMG 手动安装"]); return
            }
            guard self.supportedNow() else {
                self.lock.lock(); let message = self.support["message"] as? String ?? "此环境不支持应用内安装"; let reason = self.support["reason"] as? String ?? "unsupported"; self.lock.unlock()
                finish(["ok": false, "code": reason, "message": message]); return
            }
            self.fetchSmall(manifestURL) { manifestData in
                self.fetchSmall(signatureURL) { signatureData in
                    self.queue.async {
                        guard let manifestData, let signatureData else { finish(["ok": false, "code": "manifest-fetch", "message": "无法下载更新清单"]); return }
                        guard let publicKey = self.publicKey, let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey),
                              let text = String(data: signatureData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), let signature = Data(base64Encoded: text),
                              key.isValidSignature(signature, for: manifestData) else {
                            finish(["ok": false, "code": "bad-signature", "message": "更新清单签名无效，已拒绝"]); return
                        }
                        guard let manifestText = String(data: manifestData, encoding: .utf8) else { finish(["ok": false, "code": "manifest-malformed", "message": "更新清单不是有效文本"]); return }
                        let os = ProcessInfo.processInfo.operatingSystemVersion
                        do {
                            let parsed = try self.server.queue.sync { try self.server.js("Daylight.parseUpdateManifest(\(try jsonText(manifestText)),\(try jsonText(version)))") } as! [String: Any]
                            guard parsed["ok"] as? Bool == true, let manifest = parsed["manifest"] as? [String: Any] else {
                                finish(["ok": false, "code": parsed["code"] as? String ?? "manifest-malformed", "message": parsed["message"] as? String ?? "更新清单无效"]); return
                            }
                            guard manifest["url"] as? String == zip["url"] as? String else { finish(["ok": false, "code": "manifest-url", "message": "更新清单与发布附件不一致"]); return }
                            let args = "{current:\(try jsonText(self.currentVersion)),manifest:\(try jsonText(manifest)),release:\(try jsonText(zip)),os:\(try jsonText("\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"))}"
                            let decision = try self.server.queue.sync { try self.server.js("Daylight.decideUpdate(\(args))") } as! [String: Any]
                            guard decision["ok"] as? Bool == true else { finish(["ok": false, "code": decision["code"] as? String ?? "refused", "message": decision["message"] as? String ?? "此更新不能安装"]); return }
                            let size = (manifest["size"] as? NSNumber)?.int64Value ?? 0
                            let value = Plan(version: version, url: manifest["url"] as! String, size: size, sha256: manifest["sha256"] as! String, githubDigest: zip["digest"] as? String)
                            finish(["ok": true, "size": size, "minOS": manifest["minOS"] as? String ?? "", "date": manifest["date"] as? String ?? ""], value)
                        } catch { finish(["ok": false, "code": "manifest-malformed", "message": "更新清单无法解析"]) }
                    }
                }
            }
        }
    }

    private func fetchSmall(_ url: String, completion: @escaping (Data?) -> Void) {
        guard let target = URL(string: mapDownload(url)) else { completion(nil); return }
        var request = URLRequest(url: target)
        request.timeoutInterval = 15
        request.setValue("Daylight/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        session.dataTask(with: request) { data, response, error in
            guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200, let data, data.count <= 64 * 1024 else { completion(nil); return }
            completion(data)
        }.resume()
    }

    // MARK: Download and staging

    private func startDownload(_ completion: @escaping (Int, Any) -> Void) {
        lock.lock()
        guard support["supported"] as? Bool == true else { let message = support["message"] as? String ?? "此环境不支持应用内安装"; lock.unlock(); completion(409, ["error": message, "code": "unsupported"]); return }
        guard phase == "idle" else { lock.unlock(); completion(409, ["error": "正在处理另一个更新", "code": "busy-phase"]); return }
        guard let plan else { lock.unlock(); completion(409, ["error": "没有可安装的更新，请先检查更新", "code": "no-update"]); return }
        phase = "downloading"; received = 0; total = plan.size; targetVersion = plan.version; failure = nil; reauth = nil; cancelRequested = false
        lock.unlock()
        // Only one version is ever kept on disk.
        if let names = try? FileManager.default.contentsOfDirectory(atPath: updates.path) {
            for name in names where name.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil { try? FileManager.default.removeItem(at: directory(name)) }
        }
        ensureDirectory(directory(plan.version))
        guard let url = URL(string: mapDownload(plan.url)) else { fail("download-url", "更新地址无效", cleanup: plan.version); completion(200, status()); return }
        var request = URLRequest(url: url)
        request.setValue("Daylight/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        let download = session.downloadTask(with: request)
        task = download
        download.resume()
        completion(200, status())
    }

    private func cancelDownload(_ completion: @escaping (Int, Any) -> Void) {
        lock.lock(); let active = phase == "downloading"; if active { cancelRequested = true }; lock.unlock()
        task?.cancel()
        completion(200, status())
    }

    private func discardStaged() {
        lock.lock()
        guard phase == "ready", let version = staged?["version"] as? String else { lock.unlock(); return }
        staged = nil; phase = "idle"; targetVersion = nil
        lock.unlock()
        try? FileManager.default.removeItem(at: directory(version))
    }

    private func fail(_ code: String, _ message: String, cleanup version: String? = nil) {
        lock.lock(); failure = ["code": code, "message": message]; phase = "idle"; targetVersion = nil; received = 0; total = 0; staged = nil; lock.unlock()
        if let version { try? FileManager.default.removeItem(at: directory(version)) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, let host = url.host else { completionHandler(nil); return }
        if testBase != nil, url.scheme == "http", host == "127.0.0.1" { completionHandler(request); return }
        let trusted = (try? server.queue.sync { try server.js("Daylight.isTrustedRedirectHost(\(try jsonText(host)))") as? Bool }) == true
        completionHandler(url.scheme == "https" && trusted ? request : nil)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        lock.lock(); received = totalBytesWritten; if totalBytesExpectedToWrite > 0 { total = totalBytesExpectedToWrite }; lock.unlock()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        lock.lock(); let version = targetVersion; lock.unlock()
        guard let version else { return }
        let destination = directory(version).appendingPathComponent("package.zip")
        try? FileManager.default.removeItem(at: destination)
        do {
            try FileManager.default.moveItem(at: location, to: destination)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
            downloadedFile = destination
        } catch { downloadedFile = nil }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === self.task else { return }
        self.task = nil
        lock.lock(); let version = targetVersion; let cancelled = cancelRequested; lock.unlock()
        guard let version else { return }
        if cancelled || (error as NSError?)?.code == NSURLErrorCancelled {
            lock.lock(); phase = "idle"; targetVersion = nil; received = 0; total = 0; failure = nil; lock.unlock()
            try? FileManager.default.removeItem(at: directory(version)); return
        }
        if let error { fail("download-failed", "下载失败：\((error as NSError).localizedDescription)", cleanup: version); return }
        guard (task.response as? HTTPURLResponse)?.statusCode == 200, let file = downloadedFile else { fail("download-http", "下载失败：服务器没有返回更新包", cleanup: version); return }
        downloadedFile = nil
        DispatchQueue.global(qos: .utility).async { self.queue.async { self.verifyAndStage(version: version, zip: file) } }
    }

    private func verifyAndStage(version: String, zip: URL) {
        lock.lock(); let plan = self.plan; phase = "verifying"; lock.unlock()
        guard let plan, plan.version == version else { fail("plan-lost", "更新信息已变化，请重新检查", cleanup: version); return }
        let attributes = try? FileManager.default.attributesOfItem(atPath: zip.path)
        guard (attributes?[.size] as? NSNumber)?.int64Value == plan.size else { fail("size-mismatch", "更新包大小与清单不一致，已丢弃", cleanup: version); return }
        guard let digest = try? sha256Hex(zip), digest == plan.sha256 else { fail("digest-mismatch", "更新包校验值与清单不一致，已丢弃", cleanup: version); return }
        if let github = plan.githubDigest, github != digest { fail("digest-mismatch", "更新包校验值与 GitHub 记录不一致，已丢弃", cleanup: version); return }
        lock.lock(); phase = "extracting"; lock.unlock()
        let extract = directory(version).appendingPathComponent("extract")
        ensureDirectory(extract)
        guard run("/usr/bin/ditto", ["-x", "-k", zip.path, extract.path]).status == 0 else { fail("extract-failed", "无法解压更新包", cleanup: version); return }
        try? FileManager.default.removeItem(at: zip)
        let app = stagedApp(version)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: extract.path)) ?? []
        guard names == ["Daylight.app"] else { fail("bad-layout", "更新包内容不符合预期", cleanup: version); return }
        let verify = run("/usr/bin/codesign", ["--verify", "--strict", "--deep", app.path], timeout: 120)
        guard verify.status == 0 else { fail("bad-code-signature", "更新包的代码签名无效，已丢弃", cleanup: version); return }
        guard let info = plist(app), info["CFBundleIdentifier"] as? String == bundleID else { fail("bad-bundle-id", "更新包不是 Daylight，已丢弃", cleanup: version); return }
        guard info["CFBundleShortVersionString"] as? String == version, compare(currentVersion, version) == -1 else { fail("bad-version", "更新包版本与清单不一致或不比当前新，已丢弃", cleanup: version); return }
        guard FileManager.default.isExecutableFile(atPath: app.appendingPathComponent("Contents/MacOS/Daylight").path),
              FileManager.default.isExecutableFile(atPath: app.appendingPathComponent("Contents/Resources/DaylightUpdater").path) else { fail("bad-layout", "更新包缺少必要文件", cleanup: version); return }
        lock.lock(); let currentDR = self.currentDR; lock.unlock()
        guard let newDR = designatedRequirement(app), newDR == currentDR else {
            lock.lock(); reauth = ["version": version, "message": "新版本的签名身份与当前版本不同，需要从 GitHub 下载 DMG 手动安装，并重新授权系统权限。"]; lock.unlock()
            fail("needs-reauth", "新版本的签名身份与当前版本不同，需要手动安装并重新授权", cleanup: version); return
        }
        // Stored credentials are pinned to the helper binaries' code hashes; warn when a release changes them.
        var credentialsReset = false
        for helper in ["DaylightCredentials", "DaylightAgyCredentials"] {
            let before = cdhash(bundleURL.appendingPathComponent("Contents/Resources/\(helper)")), after = cdhash(app.appendingPathComponent("Contents/Resources/\(helper)"))
            if let before, let after, before != after { credentialsReset = true }
        }
        let record: [String: Any] = ["version": version, "size": plan.size, "sha256": digest, "credentialsReset": credentialsReset, "verifiedAt": now()]
        writeJSON(record, to: directory(version).appendingPathComponent("staged.json"))
        lock.lock(); staged = record; phase = "ready"; received = plan.size; lock.unlock()
        DispatchQueue.main.async { self.onReady?(version) }
    }

    // MARK: Install and rollback

    /// Number of proxy requests and AI conversations that a restart would interrupt.
    func activity(_ completion: @escaping (_ proxy: Int, _ ai: Int) -> Void) {
        let group = DispatchGroup()
        var proxyCount = 0, aiCount = 0
        if server.proxy.isReady {
            group.enter()
            server.proxy.handle(path: "/api/proxy/status", method: "GET", body: Data()) { _, object in
                proxyCount = (object as? [String: Any])?["activeRequests"] as? Int ?? 0; group.leave()
            }
        }
        if server.ai.isReady {
            group.enter()
            server.ai.handle(path: "/api/ai/state", method: "GET", body: Data()) { _, object in
                let conversations = (object as? [String: Any])?["conversations"] as? [[String: Any]] ?? []
                aiCount = conversations.filter { ["running", "waiting"].contains($0["status"] as? String ?? "") }.count; group.leave()
            }
        }
        group.notify(queue: queue) { completion(proxyCount, aiCount) }
    }

    private func requestInstall(force: Bool, _ completion: @escaping (Int, Any) -> Void) {
        lock.lock(); let ready = phase == "ready" ? staged?["version"] as? String : nil; let supported = support["supported"] as? Bool == true; lock.unlock()
        guard supported, let version = ready else { completion(409, ["error": "没有已准备好的更新", "code": "not-ready"]); return }
        activity { proxy, ai in
            if proxy + ai > 0 && !force { completion(409, ["error": "有 \(proxy) 个代理请求和 \(ai) 个 AI 对话正在进行，重启会中断它们", "code": "busy", "proxyRequests": proxy, "aiConversations": ai]); return }
            if self.launchHelper(kind: "install", source: self.stagedApp(version), version: version, relaunch: true) {
                completion(200, self.status())
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { NSApp.terminate(nil) }
            } else { completion(500, ["error": "无法启动更新程序", "code": "helper-failed"]) }
        }
    }

    private func requestRollback(force: Bool, _ completion: @escaping (Int, Any) -> Void) {
        lock.lock(); let backup = backupInfo; let idle = phase == "idle" || phase == "ready"; let supported = support["supported"] as? Bool == true; lock.unlock()
        guard supported, idle, let version = backup?["version"] as? String else { completion(409, ["error": "没有可回滚的版本", "code": "no-backup"]); return }
        activity { proxy, ai in
            if proxy + ai > 0 && !force { completion(409, ["error": "有 \(proxy) 个代理请求和 \(ai) 个 AI 对话正在进行，重启会中断它们", "code": "busy", "proxyRequests": proxy, "aiConversations": ai]); return }
            if self.launchHelper(kind: "rollback", source: self.backupDirectory.appendingPathComponent("Daylight.app"), version: version, relaunch: true) {
                completion(200, self.status())
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { NSApp.terminate(nil) }
            } else { completion(500, ["error": "无法启动更新程序", "code": "helper-failed"]) }
        }
    }

    /// Called from applicationWillTerminate: installs a staged update silently when the user chose "install on quit".
    func installOnQuit() {
        queue.sync {
            lock.lock()
            let eligible = mode == "download-quit" && phase == "ready" && !installing && support["supported"] as? Bool == true
            let version = staged?["version"] as? String
            lock.unlock()
            guard eligible, let version else { return }
            _ = launchHelper(kind: "install", source: stagedApp(version), version: version, relaunch: false)
        }
    }

    private func launchHelper(kind: String, source: URL, version: String, relaunch: Bool) -> Bool {
        lock.lock(); if installing { lock.unlock(); return true }; lock.unlock()
        let bundled = bundleURL.appendingPathComponent("Contents/Resources/DaylightUpdater")
        let folder = updates.appendingPathComponent("helper")
        let copy = folder.appendingPathComponent("DaylightUpdater")
        ensureDirectory(folder)
        try? FileManager.default.removeItem(at: copy)
        do { try FileManager.default.copyItem(at: bundled, to: copy) } catch { return false }
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: copy.path)
        var arguments = ["--mode", kind, "--parent-pid", String(ProcessInfo.processInfo.processIdentifier), "--target", bundleURL.path, "--source", source.path,
                         "--backup-dir", backupDirectory.path, "--updates-dir", updates.path, "--expected-version", version, "--from-version", currentVersion,
                         "--bundle-id", bundleID, "--relaunch", relaunch ? "1" : "0"]
        let env = ProcessInfo.processInfo.environment
        if env["WORKBENCH_DATA_DIR"] != nil && env["PORT"] != nil && env["PORT"] != "4318" && CommandLine.arguments.contains("--isolated-gui") {
            arguments += ["--relaunch-arg", "--isolated-gui"]
            for key in ["WORKBENCH_DATA_DIR", "PORT", "DAYLIGHT_UPDATE_TEST_BASE", "DAYLIGHT_UPDATE_BACKGROUND"] { if let value = env[key] { arguments += ["--relaunch-env", "\(key)=\(value)"] } }
            for key in ["DAYLIGHT_HELPER_WAIT", "DAYLIGHT_HELPER_HEALTH"] { if let value = env[key] { arguments += [key == "DAYLIGHT_HELPER_WAIT" ? "--wait-seconds" : "--health-seconds", value] } }
        }
        let process = Process()
        process.executableURL = copy; process.arguments = arguments
        process.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR": NSTemporaryDirectory()]
        process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return false }
        lock.lock(); installing = true; phase = "installing"; targetVersion = version; lock.unlock()
        return true
    }

    // MARK: Health marker

    /// The helper waits for this file before it declares an update successful.
    func markHealthy() {
        queue.async {
            guard !self.healthWritten else { return }
            self.healthWritten = true
            self.writeJSON(["version": self.currentVersion, "pid": Int(ProcessInfo.processInfo.processIdentifier), "at": self.now()], to: self.healthFile)
        }
    }

    // MARK: Background checks

    private func backoff() -> TimeInterval { min(15 * 60 * pow(2, Double(max(failures - 1, 0))), 6 * 60 * 60) }

    private func scheduleBackground() {
        let env = ProcessInfo.processInfo.environment
        let first = testBase != nil ? Double(env["DAYLIGHT_UPDATE_FIRST_CHECK_SECONDS"] ?? "") ?? 30 : 30
        nextCheckAt = Date().addingTimeInterval(first)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 5, repeating: testBase != nil ? 2 : 60)
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        ticker = timer
    }

    private func tick() {
        if Date() >= nextCheckAt { runBackgroundCheck() }
        promptIfReady()
    }

    /// Foreground: check right away when the last result is older than six hours (or the backoff has elapsed).
    func foreground() {
        queue.async {
            guard self.backgroundEnabled else { return }
            if Date().timeIntervalSince(self.lastCheckedAt) > 6 * 60 * 60 && Date() >= self.nextCheckAt.addingTimeInterval(-6 * 60 * 60 + 60) || (self.failures > 0 && Date() >= self.nextCheckAt) { self.runBackgroundCheck() }
        }
    }

    private func runBackgroundCheck() {
        guard !checking else { return }
        checking = true
        nextCheckAt = Date().addingTimeInterval(failures > 0 ? backoff() : 6 * 60 * 60)
        server.queue.async {
            self.server.fetchRelease(refresh: true) { record in
                self.queue.async {
                    self.checking = false
                    self.lastCheckedAt = Date()
                    if record["status"] as? String == "unavailable" { self.failures += 1 } else { self.failures = 0 }
                    self.nextCheckAt = Date().addingTimeInterval(self.failures > 0 ? self.backoff() : 6 * 60 * 60)
                    self.lock.lock()
                    let wanted = record["status"] as? String == "available" && self.mode != "notify" && self.phase == "idle" && self.plan != nil && self.plan?.version != self.autoFailedVersion
                    let version = self.plan?.version
                    self.lock.unlock()
                    if wanted {
                        self.startDownload { _, _ in }
                        self.queue.asyncAfter(deadline: .now() + 1) { self.rememberAutoFailure(version) }
                    }
                }
            }
        }
    }

    private func rememberAutoFailure(_ version: String?) {
        lock.lock(); if failure != nil { autoFailedVersion = version }; lock.unlock()
    }

    private func promptIfReady() {
        lock.lock()
        let version = mode == "download-prompt" && phase == "ready" && !installing ? staged?["version"] as? String : nil
        let already = promptedVersion
        lock.unlock()
        guard let version, version != already else { return }
        activity { proxy, ai in
            guard proxy + ai == 0 else { return }
            self.lock.lock(); self.promptedVersion = version; self.lock.unlock()
            DispatchQueue.main.async { self.onPrompt?(version) }
        }
    }

    /// Invoked by the restart prompt's "restart now" button.
    func restartNow() {
        requestInstall(force: false) { _, _ in }
    }
}
