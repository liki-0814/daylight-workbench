import Foundation

/// Foundation supplies civil-day boundaries; all interval accounting stays in shared JS.
struct FocusTimeZone {
    static var initial: String {
        let identifier = TimeZone.current.identifier
        return TimeZone(identifier: identifier) == nil || (!identifier.contains("/") && identifier != "UTC") ? "UTC" : identifier
    }

    static func today(in identifier: String, now: Int64) throws -> String {
        let calendar = try calendar(in: identifier)
        let value = calendar.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: Double(now) / 1000))
        return String(format: "%04d-%02d-%02d", value.year!, value.month!, value.day!)
    }

    private static func calendar(in identifier: String) throws -> Calendar {
        guard let timeZone = TimeZone(identifier: identifier) else { throw Failure(message: "统计时区无效") }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    static func windows(from: String, to: String, timeZone: String) throws -> [[String: Any]] {
        let local = try calendar(in: timeZone)
        var civil = Calendar(identifier: .gregorian); civil.timeZone = TimeZone(secondsFromGMT: 0)!
        func parse(_ text: String) throws -> Date {
            let parts = text.split(separator: "-").compactMap { Int($0) }
            guard matches(text, "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"), parts.count == 3,
                  let date = civil.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])),
                  civil.component(.year, from: date) == parts[0], civil.component(.month, from: date) == parts[1], civil.component(.day, from: date) == parts[2] else { throw Failure(message: "日期无效") }
            return date
        }
        var day = try parse(from)
        let last = try parse(to)
        guard day <= last, civil.dateComponents([.day], from: day, to: last).day! < 366 else { throw Failure(message: "统计范围最多 366 天") }
        var result: [[String: Any]] = []
        while day <= last {
            var parts = civil.dateComponents([.year, .month, .day], from: day); parts.hour = 12
            let name = String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
            if let noon = local.date(from: parts), local.component(.year, from: noon) == parts.year,
               local.component(.month, from: noon) == parts.month, local.component(.day, from: noon) == parts.day,
               let interval = local.dateInterval(of: .day, for: noon) {
                result.append(["day": name, "startAt": Int64((interval.start.timeIntervalSince1970 * 1000).rounded()), "endAt": Int64((interval.end.timeIntervalSince1970 * 1000).rounded()), "exists": true])
            } else if let normalized = local.date(from: parts) {
                let boundary = Int64((local.startOfDay(for: normalized).timeIntervalSince1970 * 1000).rounded())
                result.append(["day": name, "startAt": boundary, "endAt": boundary, "exists": false])
            } else {
                throw Failure(message: "无法计算统计日期边界")
            }
            day = civil.date(byAdding: .day, value: 1, to: day)!
        }
        return result
    }
}
