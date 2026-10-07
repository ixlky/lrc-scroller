// @ts-check
/**
 * 缓动与过渡进度 —— 纯函数层，禁止 import vue / DOM。
 *
 * 【为什么单独抽出来】
 * 预览的过渡是浏览器用 CSS 跑的：
 *   .lyric-line { transition: transform 260ms cubic-bezier(.22,1,.36,1),
 *                              color 180ms ease, opacity 180ms ease }
 * 导出要在 canvas 上一帧一帧重放同一段曲线，就必须能**逐点求值**这两条
 * 三次贝塞尔。把采样器收在这里，导出与单测共用同一份实现，
 * 不会出现"测试用近似、实际用另一套"的偏差。
 *
 * 【为什么不用 smoothstep 近似 ease】
 * 早先的写法用 x²(3-2x) 代替 CSS 的 ease。它两端平缓、形状相似，
 * 但**不是同一条曲线** —— 帧序列摆在一起能看出节奏差。
 * 既然要求"动效与预览一致"，就用 CSS 真正的那条。
 */

/** CSS 关键字 `ease` 的贝塞尔控制点（规范定义值） */
export const EASE = /** @type {const} */ ([0.25, 0.1, 0.25, 1])

/** `.lyric-line` 的 transform 过渡曲线：cubic-bezier(.22, 1, .36, 1) */
export const TRANSITION_CURVE = /** @type {const} */ ([0.22, 1, 0.36, 1])

/**
 * 生成一条三次贝塞尔缓动函数。
 *
 * CSS 的 `cubic-bezier(x1,y1,x2,y2)` 把 P0=(0,0)、P3=(1,1) 固定，
 * 给定 x 求曲线上对应的 y。x(t) 是三次多项式，需要反解 t ——
 * 先牛顿迭代（快），不收敛时退回二分（稳）。
 *
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @returns {(x:number)=>number} x∈[0,1] → y∈[0,1]
 */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by

  const sampleX = (t) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t) => ((ay * t + by) * t + cy) * t
  const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx

  return function ease(x) {
    if (!Number.isFinite(x) || x <= 0) return 0
    if (x >= 1) return 1

    // 牛顿迭代：绝大多数情况 2~3 步就收敛
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x
      if (Math.abs(err) < 1e-7) return sampleY(t)
      const d = slopeX(t)
      if (Math.abs(d) < 1e-7) break
      t -= err / d
    }

    // 二分兜底：保证任何输入都有稳定输出（斜率极小处牛顿会失稳）
    let lo = 0
    let hi = 1
    t = x
    for (let i = 0; i < 40; i++) {
      const v = sampleX(t)
      if (Math.abs(v - x) < 1e-7) break
      if (v < x) lo = t
      else hi = t
      t = (lo + hi) / 2
    }
    return sampleY(t)
  }
}

/** CSS `ease` 的采样器（颜色 / 透明度过渡） */
export const easeCurve = cubicBezier(EASE[0], EASE[1], EASE[2], EASE[3])

/** `.lyric-line` transform 的采样器（缩放过渡） */
export const transitionCurve = cubicBezier(
  TRANSITION_CURVE[0],
  TRANSITION_CURVE[1],
  TRANSITION_CURVE[2],
  TRANSITION_CURVE[3],
)

/**
 * 过渡进度：经过 `elapsedMs` 毫秒后，一条时长 `durationMs` 的过渡走到了哪。
 *
 * 【duration 为 0 必须返回 1】
 * 设置面板允许把 `motion.transitionMs` / `activeFadeMs` 拖到 0，
 * 此时 CSS 的语义是"瞬间到位"。若这里返回 0（刚起步），
 * 导出会把每一帧都停在过渡起点 —— 当前行永远放不大。
 *
 * @param {number} elapsedMs 距过渡开始的时间（毫秒）
 * @param {number} durationMs 过渡总时长（毫秒）
 * @param {(x:number)=>number} curve 缓动采样器
 * @returns {number} 0~1
 */
export function progress(elapsedMs, durationMs, curve) {
  const d = Number(durationMs)
  if (!Number.isFinite(d) || d <= 0) return 1
  const e = Number(elapsedMs)
  if (!Number.isFinite(e) || e <= 0) return 0
  if (e >= d) return 1
  return curve(e / d)
}

/**
 * 线性插值。
 * @param {number} a @param {number} b @param {number} t 0~1
 * @returns {number}
 */
export function lerp(a, b, t) {
  const x = Number.isFinite(t) ? (t < 0 ? 0 : t > 1 ? 1 : t) : 1
  return a + (b - a) * x
}
