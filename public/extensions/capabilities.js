// 扩展页的后端能力开关（0.7）。
// 后端把能力统一放在 /api/v1/capabilities 的 extensions.* 下；网页界面读不了 /api/v1，所以 /state 和 /refresh 带一份同形状的镜像：
//   capabilities.extensions.{ reveal, restoreBackup, mcpConflictCompare }
// 只读这一处（Jevis 2026-10-30 决定）：只有 capabilities.extensions.<name> 是字面 true 才算支持；
// 缺失、false、字符串 "true"、数字 1，以及镜像顶层的扁平键（旧形状）一律按不支持处理，对应按钮不显示。
export function extensionCapability(capabilities, name) {
  const extensions = capabilities?.extensions;
  return !!extensions && typeof extensions === 'object' && !Array.isArray(extensions) && extensions[name] === true;
}
