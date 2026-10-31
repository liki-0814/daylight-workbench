// 0.8: 同步外部脚本（CSP 禁内联脚本），放在 <head> 最前面。
// 只做一件事：固定 <html data-theme="light">。深色模式延后（0.8 强制浅色）：
// Mist 主题文件里的 `prefers-color-scheme: dark` 规则带 :not([data-theme="light"])，
// 属性显式为 light 时系统深色也不会触发。深色验收通过后，只改本文件。
document.documentElement.dataset.theme = 'light';
