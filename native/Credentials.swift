import Foundation
import Security
// Private stdin/stdout helper: credentials never enter command-line arguments.
do {
 let input = FileHandle.standardInput.readDataToEndOfFile()
 guard let body = try JSONSerialization.jsonObject(with: input) as? [String: String], let id = body["id"], !id.isEmpty else { exit(2) }
 let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "local.daylight.proxy", kSecAttrAccount as String: id]
 var status: OSStatus = errSecSuccess
 var result: [String: Any] = [:]
 switch body["action"] {
 case "get":
  var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
  var item: CFTypeRef?; status = SecItemCopyMatching(q as CFDictionary, &item)
  if status == errSecSuccess, let data = item as? Data { result["value"] = String(data: data, encoding: .utf8) ?? "" }
  if status == errSecItemNotFound { status = errSecSuccess }
 case "set":
  let value = Data((body["value"] ?? "").utf8)
  status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: value] as CFDictionary)
  if status == errSecItemNotFound { var q = query; q[kSecValueData as String] = value; status = SecItemAdd(q as CFDictionary, nil) }
 case "delete": status = SecItemDelete(query as CFDictionary); if status == errSecItemNotFound {status = errSecSuccess}
 default: exit(2)
 }
 guard status == errSecSuccess else { FileHandle.standardError.write(Data("钥匙串操作失败：\(status)".utf8)); exit(1) }
 FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
} catch { exit(2) }
