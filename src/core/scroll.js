// @ts-check
/**
 * 滚动数学 —— 纯函数层，禁止 import vue。
 *
 * 【为什么滚动要单独抽成纯函数】
 * "当前行居中误差 ≤2px"、"用户回看时不被拉回"、"2000 行不掉帧"这些要求，
 * 如果混在组件里，就只能靠肉眼看和手动试。抽出来之后：
 *  - 目标位移可以直接用 Node 断言到像素
 *  - 平滑跟随的收敛性可以在无浏览器的情况下验证
 *  - 组件里只剩"读几何 → 调这些函数 → 写 transform"三行胶水
 */

/**
 * 计算让某一行停在容器中心所需的轨道位移。
 *
 * 几何关系：
 *   容器高度 H，希望行的中心落在可视区中心。
 *   行在轨道内的中心位置 = lineTop + lineHeight/2
 *   所以轨道需要向上移动 (lineTop + lineHeight/2 - H/2)。
 *
 * @param {{top:number, height:number}} line 行相对轨道顶部的几何
 * @param {number} containerHeight 可视容器高度
 * @param {number} [anchorRatio=0.5] 锚点位置（0.5 = 居中，黄金分割常用 0.38）
 * @param {number} [offsetPx=0] 额外偏移（用于留白补偿）
 * @returns {number} 应设置的 translateY 的负值量，即轨道要向上移动的像素
 */
export function computeCenteringOffset(line, containerHeight, anchorRatio = 0.5, offsetPx = 0) {
  if (!line || !(containerHeight > 0)) return 0
  const anchorY = containerHeight * anchorRatio
  const lineCenter = line.top + line.height / 2
  return lineCenter - anchorY + offsetPx
}

/**
 * 把位移夹取到 [0, contentHeight - containerHeight]。
 *
 * 这是"按页滚动"语义的夹取，用于 Home/End/PageUp/PageDown 这类整页跳转，
 * 以及任何"不该露出容器外空白"的场景。
 *
 * 注意：**不要**用它夹取"让某一行居中"的位移。
 * 首行居中所需的位移本身是负的（要把轨道往下推才能让第一句停在中间），
 * 用 0 当下界会让首行永远无法居中（实测偏差可达 92px）。
 * 自动滚动走 useAutoScroll 的 getBounds()，按居中几何算区间。
 *
 * @param {number} target 目标位移
 * @param {number} contentHeight 轨道总高度
 * @param {number} containerHeight 容器高度
 * @returns {number}
 */
export function clampScrollOffset(target, contentHeight, containerHeight) {
  if (!Number.isFinite(target)) return 0
  // 内容比容器还矮时无处可滚，固定为 0
  if (contentHeight <= containerHeight) return 0
  const max = contentHeight - containerHeight
  if (target < 0) return 0
  if (target > max) return max
  return target
}

/**
 * 帧率无关的指数平滑。
 *
 * 常见错误写法：`current += (target - current) * 0.15`
 * 这样在 120Hz 屏幕上会比 60Hz 快一倍 —— 同一条代码在不同设备上手感不同。
 * 正确做法是把系数按实际帧间隔做幂运算，使"每秒收敛比例"恒定。
 *
 * @param {number} current 当前值
 * @param {number} target 目标值
 * @param {number} dtMs 距上一帧的毫秒数
 * @param {number} [halfLifeMs=90] 半衰期：每隔这么久，剩余差距减半
 * @returns {number} 新值
 */
export function smoothTowards(current, target, dtMs, halfLifeMs = 90) {
  if (!Number.isFinite(current)) return target
  if (!Number.isFinite(target)) return current
  const dt = Math.max(0, Math.min(Number(dtMs) || 0, 200)) // 夹取，避免切回标签页时巨大跳变
  if (dt === 0) return current
  const hl = halfLifeMs > 0 ? halfLifeMs : 1
  // 剩余比例 = 0.5 ^ (dt / halfLife)
  const keep = Math.pow(0.5, dt / hl)
  return target + (current - target) * keep
}

/**
 * 判断是否已经足够接近目标（用于停止逐帧写入，省电）。
 * @param {number} current
 * @param {number} target
 * @param {number} [epsilon=0.25] 亚像素级别即认为到位
 * @returns {boolean}
 */
export function isSettled(current, target, epsilon = 0.25) {
  return Math.abs(target - current) <= epsilon
}

/**
 * 找出"视口中心对应的那一行"。
 *
 * 用途：用户滚轮回看时，虚化中心应跟随用户正在看的区域，
 * 而不是固定的正在播放行 —— 否则回看时整片歌词糊得看不清。
 *
 * 做法：把"屏幕视口中心"换算成轨道内的像素位置，再在行几何里做二分查找。
 *   轨道位移 offset 表示轨道被向上推了 offset 像素，
 *   因此屏幕中心 y 对应轨道内位置 = offset + containerHeight / 2。
 *
 * 复杂度 O(log n)，1000 行也毫无压力，可安全地在滚动中每次调用。
 *
 * @param {Array<{top:number,height:number}>} rowMetrics 各行相对轨道顶部的几何（升序）
 * @param {number} offset 当前轨道位移（正值，轨道已上移的像素）
 * @param {number} containerHeight 容器高度
 * @returns {number} 行下标；无法确定时返回 -1
 */
export function findRowAtViewportCenter(rowMetrics, offset, containerHeight) {
  if (!Array.isArray(rowMetrics) || rowMetrics.length === 0) return -1
  if (!Number.isFinite(offset) || !(containerHeight > 0)) return -1

  const y = offset + containerHeight / 2

  // 二分：找最后一个 top <= y 的行
  if (y < rowMetrics[0].top) return 0

  let lo = 0
  let hi = rowMetrics.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const m = rowMetrics[mid]
    if (m && m.top <= y) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  if (ans < 0) return 0
  return Math.min(ans, rowMetrics.length - 1)
}

/**
 * 判断用户是否在"回看"（当前行在可视区域之外）。
 * 用于显示"回到当前行"按钮。
 * @param {number} offset 当前轨道位移
 * @param {{top:number,height:number}} line 当前行几何
 * @param {number} containerHeight
 * @returns {boolean}
 */
export function isLineOffscreen(offset, line, containerHeight) {
  if (!line || !(containerHeight > 0)) return false
  const top = line.top - offset
  const bottom = top + line.height
  // 留一点余量，贴边不算离开
  const margin = Math.min(24, containerHeight * 0.05)
  return bottom < margin || top > containerHeight - margin
}

/**
 * 计算"回到当前行"所需的位移（复用居中逻辑，便于统一行为）。
 * @param {{top:number,height:number}} line
 * @param {number} containerHeight
 * @param {number} [anchorRatio=0.5]
 * @returns {number}
 */
export function computeRecenterOffset(line, containerHeight, anchorRatio = 0.5) {
  return computeCenteringOffset(line, containerHeight, anchorRatio)
}
