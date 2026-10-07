// @ts-check
/**
 * 时间工具 —— 纯函数层，禁止 import vue。
 * 可在浏览器与 Node 中直接运行（`node scripts/test-core.mjs` 会验证这一点）。
 */

/** LRC 标准时间标签： [mm:ss.xx] / [mm:ss.xxx] / [mm:ss] / [mm:ss:xx]（旧格式用冒号当小数点） */
const TIME_TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

/** 增强型逐字标签： <mm:ss.xx> */
const ENHANCED_TAG_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g

/**
 * 把 `mm:ss.xx` 形式的时间片段解析为秒。
 * @param {string} str 形如 "01:02.34" / "1:2.5" / "00:05" / "00:05:30"
 * @returns {number|null} 秒；无法解析返回 null
 */
export function parseTimeTag(str) {
  if (typeof str !== 'string') return null
  const m = /^\s*(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\s*$/.exec(str)
  if (!m) return null

  const minutes = Number(m[1])
  const seconds = Number(m[2])
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
  // 秒位合法范围 0-59（容忍 60 作为进位写法）
  if (seconds > 60) return null

  const fracRaw = m[3] ?? ''
  let frac = 0
  if (fracRaw.length === 1) frac = Number(fracRaw) / 10
  else if (fracRaw.length === 2) frac = Number(fracRaw) / 100
  else if (fracRaw.length === 3) frac = Number(fracRaw) / 1000
  else frac = 0

  return minutes * 60 + seconds + frac
}

/**
 * 把秒格式化为 `mm:ss.cc`（两位百分秒），用于导出 LRC。
 * @param {number} totalSeconds
 * @param {number} [precision=2] 小数位数 2 或 3
 * @returns {string}
 */
export function formatTimeTag(totalSeconds, precision = 2) {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0
  const minutes = Math.floor(safe / 60)
  const seconds = Math.floor(safe % 60)
  const frac = Math.round((safe - Math.floor(safe)) * 10 ** precision)
  // 四舍五入可能把 frac 进位成 10^precision（如 1.999 → 200）
  const carry = frac >= 10 ** precision ? 1 : 0
  const sec = seconds + carry
  const fracStr = String(carry ? 0 : frac).padStart(precision, '0')
  const mm = String(minutes + (sec >= 60 ? 1 : 0)).padStart(2, '0')
  const ss = String(sec % 60).padStart(2, '0')
  return `${mm}:${ss}.${fracStr}`
}

/**
 * 把秒格式化为播放器友好的 `m:ss` 或 `h:mm:ss`。
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatClock(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00'
  const t = Math.floor(totalSeconds)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * 从字符串中提取所有标准时间标签。
 * @param {string} line
 * @returns {number[]} 秒数组（保持出现顺序）
 */
export function extractTimeTags(line) {
  if (typeof line !== 'string') return []
  const out = []
  TIME_TAG_RE.lastIndex = 0
  let m
  while ((m = TIME_TAG_RE.exec(line)) !== null) {
    const t = parseTimeTag(`${m[1]}:${m[2]}${m[3] != null ? `.${m[3]}` : ''}`)
    if (t !== null) out.push(t)
  }
  return out
}

/**
 * 剥离行内所有时间标签（标准 + 增强），返回正文。
 * @param {string} line
 * @returns {string}
 */
export function stripTimeTags(line) {
  if (typeof line !== 'string') return ''
  TIME_TAG_RE.lastIndex = 0
  ENHANCED_TAG_RE.lastIndex = 0
  return line.replace(TIME_TAG_RE, '').replace(ENHANCED_TAG_RE, '').trim()
}

/** 判断一行是否含增强型逐字标签。 */
export function hasEnhancedTags(line) {
  if (typeof line !== 'string') return false
  ENHANCED_TAG_RE.lastIndex = 0
  return ENHANCED_TAG_RE.test(line)
}

/**
 * 在**已按时间升序排列**的数组中，二分查找 `time` 落在哪一行。
 * 规则：返回最后一个 `t <= time` 的下标 —— 这正是"当前正在唱的句子"。
 * @param {Array<{t:number}>} lines 必须已升序
 * @param {number} time 秒
 * @returns {number} 下标；`time` 早于第一行时返回 -1
 */
export function findLineIndexAt(lines, time) {
  if (!Array.isArray(lines) || lines.length === 0) return -1
  if (!Number.isFinite(time)) return -1
  if (time < lines[0].t) return -1

  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].t <= time) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * 取某行所属"句"的结束时间（下一行起点），用于卡拉OK 进度与自动暂停判断。
 * @param {Array<{t:number}>} lines
 * @param {number} index
 * @param {number} [fallbackDuration=0] 最后一行无下一行时使用的时长
 * @returns {number}
 */
export function getLineEnd(lines, index, fallbackDuration = 0) {
  if (!Array.isArray(lines) || index < 0 || index >= lines.length) return 0
  const next = lines[index + 1]
  if (next) return next.t
  return Math.max(lines[index].t + 2, fallbackDuration)
}

/**
 * 数值夹取。
 * @param {number} v @param {number} min @param {number} max
 */
export function clamp(v, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return min
  return n < min ? min : n > max ? max : n
}

/**
 * 解析 `[offset:+500]` 的值（毫秒）。
 * 社区约定：正数表示歌词整体**提前**，即 最终时间 = 原时间 - offset/1000。
 * @param {string|number} raw
 * @returns {number} 毫秒；无法解析返回 0
 */
export function parseOffset(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0
  if (typeof raw !== 'string') return 0
  const m = /^\s*([+-]?)(\d+)\s*$/.exec(raw)
  if (!m) return 0
  const v = Number(m[2])
  return m[1] === '-' ? -v : v
}
