import Foundation

/// Owns a Node helper (proxy or AI). Task persistence remains in WorkbenchServer.
final class ProxyRuntime {
    let resources: URL
    let directory: URL
    let helper: String
    let workbenchURL: String?
    private let queue = DispatchQueue(label: "daylight.proxy")
    private var process: Process?
    private var input: Pipe?
    private var controlPort: Int?
    private var token = ""
    private var runtimeError = "正在检测 Node 运行环境…"
    private var nodePath = ""
    private var version = ""
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.connectionProxyDictionary = [:]
        return URLSession(configuration: configuration)
    }()
    init(resources: URL, directory: URL, helper: String = "qoder", workbenchURL: String? = nil) { self.resources = resources; self.directory = directory; self.helper = helper; self.workbenchURL = workbenchURL }
    private var configFile: URL { directory.appendingPathComponent("qoder/runtime.json") }
    func start() { queue.async { self.boot() } }
    func shutdown() { queue.sync { self.stop() } }
    private func stop() {
        controlPort = nil
        try? input?.fileHandleForWriting.close(); input = nil
        if let process, process.isRunning { process.terminate() }
        process = nil
    }
    private func candidatePaths() -> [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var paths = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { String($0) + "/node" }
        paths += ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", home + "/.volta/bin/node", home + "/.local/share/mise/shims/node"]
        for folder in [home + "/.nvm/versions/node", home + "/.local/share/mise/installs/node", home + "/.volta/tools/image/node", home + "/.local/share/fnm/node-versions"] {
            let names = ((try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []).sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            paths += names.map { folder + "/" + $0 + (folder.contains("fnm") ? "/installation/bin/node" : "/bin/node") }
        }
        var seen = Set<String>()
        return paths.filter { seen.insert($0).inserted && FileManager.default.isExecutableFile(atPath: $0) }
    }
    private func nodeVersion(_ path: String) -> String? {
        let task = Process(), output = Pipe()
        task.executableURL = URL(fileURLWithPath: path); task.arguments = ["--version"]
        task.standardOutput = output; task.standardError = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0); task.terminationHandler = { _ in done.signal() }
        do { try task.run() } catch { return nil }
        if done.wait(timeout: .now() + 3) == .timedOut { task.terminate(); return nil }
        guard task.terminationStatus == 0 else { return nil }
        let text = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard text.hasPrefix("v"), let major = Int(text.dropFirst().split(separator: ".").first ?? ""), major >= 22 else { return nil }
        return text
    }
    private func boot() {
        stop()
        do {
            let data = try? Data(contentsOf: configFile)
            let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            let custom = object?["nodePath"] as? String ?? ""
            let candidates = custom.isEmpty ? candidatePaths() : [custom]
            var found: (String, String)?
            for path in candidates { if let version = nodeVersion(path) { found = (path, version); break } }
            guard let selected = found else {
                runtimeError = custom.isEmpty ? "未找到 Node 22 或更新版本。请安装或在设置中指定 Node 路径。" : "指定路径不可用或版本低于 Node 22，请修改后重试。"
                return
            }
            nodePath = selected.0; version = selected.1; token = try secureToken()
            let task = Process(), pipe = Pipe(), output = Pipe()
            task.executableURL = URL(fileURLWithPath: nodePath)
            task.arguments = [resources.appendingPathComponent(helper == "ai" ? "ai/sidecar.mjs" : "proxy/sidecar.mjs").path]
            var env = ProcessInfo.processInfo.environment
            env["WORKBENCH_DATA_DIR"] = directory.path; env[helper == "ai" ? "DAYLIGHT_AI_TOKEN" : "DAYLIGHT_QODER_TOKEN"] = token
            if let workbenchURL { env["DAYLIGHT_WORKBENCH_URL"] = workbenchURL }
            env.removeValue(forKey: "NODE_OPTIONS"); env.removeValue(forKey: "NODE_PATH")
            task.environment = env; task.standardInput = pipe; task.standardOutput = output; task.standardError = FileHandle.nullDevice
            let ready = DispatchSemaphore(value: 0), lock = NSLock()
            var received = Data(), readyPort: Int?
            output.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                lock.lock(); defer { lock.unlock() }
                if data.isEmpty { ready.signal(); return }
                received.append(data)
                if let line = String(data: received, encoding: .utf8)?.components(separatedBy: "\n").first,
                   let bytes = line.data(using: .utf8), let result = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any], let port = result["port"] as? Int {
                    readyPort = port; ready.signal()
                }
            }
            try task.run(); process = task; input = pipe
            let result = ready.wait(timeout: .now() + 8)
            output.fileHandleForReading.readabilityHandler = nil
            lock.lock(); let port = readyPort; lock.unlock()
            guard result == .success, let port, task.isRunning else { stop(); runtimeError = "代理进程启动失败，请检查 Node 路径和代理数据文件。"; return }
            controlPort = port; runtimeError = ""
            task.terminationHandler = { [weak self, weak task] _ in
                guard let self else { return }
                self.queue.async {
                    if self.process === task { self.controlPort = nil; self.runtimeError = "代理进程已退出，请在设置中重新检测并启动。" }
                }
            }
        } catch { stop(); runtimeError = "代理运行环境初始化失败，请重新检测 Node。" }
    }
    func handle(path: String, method: String, body: Data, completion: @escaping (Int, Any) -> Void) {
        queue.async {
            if self.helper == "ai", self.controlPort == nil { self.boot() }
            if path == "/api/qoder/runtime", method == "POST" {
                guard let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], let custom = object["nodePath"] as? String,
                      custom.isEmpty || (custom.hasPrefix("/") && !custom.contains("\n")) else { completion(400, ["error": "Node 路径必须为绝对路径，留空可自动检测"]); return }
                let save = {
                    do {
                        let folder = self.configFile.deletingLastPathComponent()
                        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                        try jsonData(["nodePath": custom]).write(to: self.configFile, options: .atomic)
                        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: self.configFile.path)
                        self.boot()
                        completion(self.controlPort == nil ? 400 : 200, self.controlPort == nil ? ["error": self.runtimeError] : ["ok": true])
                    } catch { completion(500, ["error": "运行环境设置保存失败"]); }
                }
                if self.controlPort != nil {
                    self.forward(path: "/api/qoder/status", method: "GET", body: Data()) { code, result in
                        self.queue.async {
                            guard code == 200, let value = result as? [String: Any], value["state"] as? String == "stopped" else { completion(409, ["error": "请先停止代理再修改 Node 路径"]); return }
                            save()
                        }
                    }
                } else { save() }
                return
            }
            guard self.controlPort != nil else {
                if (path == "/api/qoder/status" || path == "/api/proxy/status") { completion(200, ["state": "stopped", "native": true, "runtimeError": self.runtimeError, "port": 4319, "autoStart": false, "activeRequests": 0]) }
                else { completion(503, ["error": self.runtimeError]) }
                return
            }
            self.forward(path: path, method: method, body: body, completion: completion)
        }
    }
    private func forward(path: String, method: String, body: Data, completion: @escaping (Int, Any) -> Void) {
        guard let port = controlPort, let url = URL(string: "http://127.0.0.1:\(port)" + path) else { completion(503, ["error": "代理服务尚未就绪"]); return }
        var request = URLRequest(url: url); request.httpMethod = method
        request.setValue(token, forHTTPHeaderField: "x-workbench-token"); request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if method != "GET" { request.httpBody = body }
        session.dataTask(with: request) { data, response, _ in
            guard let data, let response = response as? HTTPURLResponse, var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { completion(503, ["error": "代理进程暂时无法连接，请稍后重试或重新检测 Node"]); return }
            if (path == "/api/qoder/status" || path == "/api/proxy/status") { object["native"] = true }
            completion(response.statusCode, object)
        }.resume()
    }
}
