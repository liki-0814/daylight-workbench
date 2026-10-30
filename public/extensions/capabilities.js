// 扩展页的后端能力开关（0.7）。
// 后端把能力统一放在 /api/v1/capabilities 的 extensions.* 下；网页界面读不了 /api/v1，所以 /state 和 /refresh 带一份镜像 capabilities。
// 读法：镜像里的 extensions.<name> 优先；没有 extensions 对象时回退到镜像顶层的 <name>（#36 的 498c48f 目前返回的是顶层 {restoreBackup, reveal?}）。
// 只有明确为 true 才算支持；缺失、false、字符串 "true" 都按不支持处理，对应按钮不显示。
export function extensionCapability(capabilities, name) {
  const nested = capabilities?.extensions?.[name];
  return (nested !== undefined ? nested : capabilities?.[name]) === true;
}
