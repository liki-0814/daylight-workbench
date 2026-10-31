# 视觉基线

此目录存放 `scripts/e2e.mjs --visual` 比对用的基线 PNG（固定视口 760/1240/1440×900、scale 1、浅色、reduced motion、zh-CN、Asia/Shanghai、冻结时间）。

- 基线只能通过 `node scripts/e2e.mjs --update-baseline --reason "为什么变"` 更新，原因会追加到 `CHANGES.md`。
- 0.7 的新界面（令牌、组件、外壳、布局）落地前不提交基线；基线应在 Iris 的前端合入后、由人工目视确认后生成。
- 比对阈值：单通道差 > 0.1（相对 255）算差异像素，差异像素占比 > 0.0001 判失败；差异图写入 `e2e/.out/`（已忽略）。
