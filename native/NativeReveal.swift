import AppKit

/// Native half of "在访达中显示" (api-contract §H1). UNVERIFIED: written without a Swift toolchain; compile and try it on a Mac.
///
/// The extensions service lives in the AI helper (`ai/sidecar.mjs`) and resolves the location itself from `{kind, id|clientId}`;
/// the page never supplies a path. When the shell starts the helper with `DAYLIGHT_REVEAL=native`, the helper does not run
/// `open -R` but answers `{ok: true, hostReveal: "<absolute path>"}`. This hop (helper → shell) is the only place the path travels:
/// `finish` strips `hostReveal` from the reply, so the web page still only ever sees `{ok: true}`, and hands the path to NSWorkspace.
/// A helper that does not know the variable keeps using `open -R`, and a reply without `hostReveal` passes through unchanged.
enum NativeReveal {
    static let environmentKey = "DAYLIGHT_REVEAL", environmentValue = "native", field = "hostReveal"
    static let route = "/api/extensions/reveal"

    static func finish(_ code: Int, _ object: Any) -> (Int, Any) {
        guard var dictionary = object as? [String: Any] else { return (code, object) }
        guard let value = dictionary.removeValue(forKey: field) else { return (code, dictionary) }
        guard code == 200, let path = value as? String, path.hasPrefix("/"), !path.contains("\0"), FileManager.default.fileExists(atPath: path) else {
            return (500, ["error": "无法在访达中显示，请改为复制路径", "code": "EXTENSIONS_REVEAL_FAILED"])
        }
        let url = URL(fileURLWithPath: path)
        DispatchQueue.main.async { NSWorkspace.shared.activateFileViewerSelecting([url]) }
        return (200, dictionary)
    }
}
