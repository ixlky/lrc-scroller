// @ts-check
/**
 * 颜色换算 —— 纯函数层，禁止 import vue。
 *
 * 供设置面板的 RGB 调色盘与 HSL 色相环使用。
 * 之所以单独成文件并用 Node 单测：颜色换算（尤其 HSL 往返）极易出现
 * "拖一下颜色跳变"、"灰阶时色相丢失"这类问题，靠肉眼看很难覆盖边界。
 */

/**
 * 把 #rgb / #rrggbb / #rrggbbaa 解析为 RGB。
 * @param {string} hex
 * @returns {{r:number,g:number,b:number,a:number}|null} a 为 0~1
 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null
  const v = hex.trim().toLowerCase()
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v)
  if (m3) {
    return {
      r: parseInt(m3[1] + m3[1], 16),
      g: parseInt(m3[2] + m3[2], 16),
      b: parseInt(m3[3] + m3[3], 16),
      a: 1,
    }
  }
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/.exec(v)
  if (m6) {
    return {
      r: parseInt(m6[1], 16),
      g: parseInt(m6[2], 16),
      b: parseInt(m6[3], 16),
      a: m6[4] ? parseInt(m6[4], 16) / 255 : 1,
    }
  }
  return null
}

/**
 * RGB → #rrggbb。
 * @param {number} r @param {number} g @param {number} b
 * @returns {string}
 */
export function rgbToHex(r, g, b) {
  const c = (n) => {
    const v = Math.round(Number(n) || 0)
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')
  }
  return `#${c(r)}${c(g)}${c(b)}`
}

/**
 * RGB → HSL。
 * @param {number} r 0~255 @param {number} g 0~255 @param {number} b 0~255
 * @returns {{h:number,s:number,l:number}} h 0~360, s/l 0~100
 */
export function rgbToHsl(r, g, b) {
  const rn = Math.max(0, Math.min(255, Number(r) || 0)) / 255
  const gn = Math.max(0, Math.min(255, Number(g) || 0)) / 255
  const bn = Math.max(0, Math.min(255, Number(b) || 0)) / 255

  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
    else if (max === gn) h = ((bn - rn) / d + 2) / 6
    else h = ((rn - gn) / d + 4) / 6
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

/**
 * HSL → RGB。
 * @param {number} h 0~360 @param {number} s 0~100 @param {number} l 0~100
 * @returns {{r:number,g:number,b:number}}
 */
export function hslToRgb(h, s, l) {
  // 色相环绕处理（拖色相环可能得到 360 或负数）
  let hn = ((Number(h) || 0) % 360 + 360) % 360 / 360
  const sn = Math.max(0, Math.min(100, Number(s) || 0)) / 100
  const ln = Math.max(0, Math.min(100, Number(l) || 0)) / 100

  if (sn === 0) {
    const v = Math.round(ln * 255)
    return { r: v, g: v, b: v }
  }

  const hue2rgb = (p, q, t) => {
    let tn = t
    if (tn < 0) tn += 1
    if (tn > 1) tn -= 1
    if (tn < 1 / 6) return p + (q - p) * 6 * tn
    if (tn < 1 / 2) return q
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6
    return p
  }

  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn
  const p = 2 * ln - q

  return {
    r: Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hn) * 255),
    b: Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
  }
}

/** HSL 直接转 hex（设置面板最常用的一条链路） */
export function hslToHex(h, s, l) {
  const { r, g, b } = hslToRgb(h, s, l)
  return rgbToHex(r, g, b)
}

/** hex 直接转 HSL */
export function hexToHsl(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) return { h: 0, s: 0, l: 0 }
  return rgbToHsl(rgb.r, rgb.g, rgb.b)
}

/**
 * 判断文本应该用黑还是白，才能在这个背景色上清晰可读。
 * 用于色块上的数值文字。
 * @param {string} hex
 * @returns {'#000000'|'#ffffff'}
 */
export function contrastText(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) return '#ffffff'
  // 相对亮度（sRGB 加权），阈值取 0.55 偏保守，保证小字也清楚
  const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255
  return lum > 0.55 ? '#000000' : '#ffffff'
}

/**
 * 校验并归一化用户输入的 HEX。
 *
 * 注意：非法输入必须返回 null，让调用方"不生效 + 标红"，
 * 绝不能猜一个近似值填回去 —— 那会让用户以为自己输对了。
 * @param {string} input
 * @returns {string|null} 归一化后的 #rrggbb，非法则 null
 */
export function validateHexInput(input) {
  if (typeof input !== 'string') return null
  const v = input.trim()
  if (v === '') return null
  const withHash = v.startsWith('#') ? v : `#${v}`
  const rgb = hexToRgb(withHash)
  if (!rgb) return null
  return rgbToHex(rgb.r, rgb.g, rgb.b)
}

/**
 * 计算色相环上某点的角度（0~360，0 在正上方，顺时针增长）。
 * 与 CSS conic-gradient 的角度约定保持一致，否则拖动位置会和显示的颜色错位。
 * @param {number} dx 相对圆心的 x 偏移
 * @param {number} dy 相对圆心的 y 偏移（屏幕坐标，向下为正）
 * @returns {number}
 */
export function pointToHue(dx, dy) {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI
  return (deg + 360) % 360
}

/**
 * 色相环上某个色相对应的圆环坐标（用于放置拖动圆点）。
 * @param {number} hue 0~360
 * @param {number} radius
 * @returns {{x:number,y:number}} 相对圆心的偏移
 */
export function hueToPoint(hue, radius) {
  const rad = (((Number(hue) || 0) % 360) * Math.PI) / 180
  return {
    x: Math.sin(rad) * radius,
    y: -Math.cos(rad) * radius,
  }
}

/**
 * 生成 HSL 色相环的 conic-gradient 字符串。
 * @param {number} [s=100] @param {number} [l=50]
 * @returns {string}
 */
export function hueRingGradient(s = 100, l = 50) {
  const stops = []
  for (let a = 0; a <= 360; a += 30) {
    stops.push(`hsl(${a} ${s}% ${l}%) ${a}deg`)
  }
  return `conic-gradient(${stops.join(', ')})`
}

/**
 * 生成 RGB 单通道滑杆的背景渐变。
 * 拖动 R 滑杆时，背景应展示"其它两通道固定、R 从 0 到 255"的实际颜色，
 * 这样用户才能预期拖动结果。
 * @param {'r'|'g'|'b'} channel
 * @param {number} r @param {number} g @param {number} b
 * @returns {string}
 */
export function channelGradient(channel, r, g, b) {
  const from = { r, g, b }
  const to = { r, g, b }
  from[channel] = 0
  to[channel] = 255
  return `linear-gradient(to right, ${rgbToHex(from.r, from.g, from.b)}, ${rgbToHex(to.r, to.g, to.b)})`
}

// ─────────────────────────────────────────────
// HSV 换算与插值（竖直明度条用）
// ─────────────────────────────────────────────

/**
 * RGB → HSV（色相/饱和度/明度）。
 *
 * 【为什么竖直明度条要用 HSV 而不是 HSL】
 * iro.js 风格的"圆环 + 竖直明度条"里，明度条顶端是**纯色**（V=100），
 * 底端是**纯黑**（V=0）—— 这正是 HSV 的 Value 语义。
 * 若用 HSL 的 Lightness，中段会出现"颜色变白"的效果，
 * 与"从纯色渐变到黑"的视觉预期不符。
 *
 * @param {number} r 0~255 @param {number} g 0~255 @param {number} b 0~255
 * @returns {{h:number,s:number,v:number}} h 0~360, s/v 0~100
 */
export function rgbToHsv(r, g, b) {
  const rn = Math.max(0, Math.min(255, Number(r) || 0)) / 255
  const gn = Math.max(0, Math.min(255, Number(g) || 0)) / 255
  const bn = Math.max(0, Math.min(255, Number(b) || 0)) / 255

  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min

  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
    else if (max === gn) h = ((bn - rn) / d + 2) / 6
    else h = ((rn - gn) / d + 4) / 6
  }

  const s = max === 0 ? 0 : d / max

  return { h: Math.round(h * 360), s: Math.round(s * 100), v: Math.round(max * 100) }
}

/**
 * HSV → RGB。
 * @param {number} h 0~360 @param {number} s 0~100 @param {number} v 0~100
 * @returns {{r:number,g:number,b:number}}
 */
export function hsvToRgb(h, s, v) {
  const hn = ((((Number(h) || 0) % 360) + 360) % 360) / 360
  const sn = Math.max(0, Math.min(100, Number(s) || 0)) / 100
  const vn = Math.max(0, Math.min(100, Number(v) || 0)) / 100

  const i = Math.floor(hn * 6)
  const f = hn * 6 - i
  const p = vn * (1 - sn)
  const q = vn * (1 - f * sn)
  const tt = vn * (1 - (1 - f) * sn)

  // 分段映射（i 可能因浮点误差等于 6，需取模）
  const seg = i % 6
  const table = [
    [vn, tt, p],
    [q, vn, p],
    [p, vn, tt],
    [p, q, vn],
    [tt, p, vn],
    [vn, p, q],
  ]
  const [r, g, b] = table[seg] ?? table[0]
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) }
}

/**
 * HSL → HSV。用于把已有的 HSL 记忆值转成明度条需要的 V。
 * @param {number} h @param {number} s 0~100 @param {number} l 0~100
 * @returns {{h:number,s:number,v:number}}
 */
export function hslToHsv(h, s, l) {
  const { r, g, b } = hslToRgb(h, s, l)
  return rgbToHsv(r, g, b)
}

/**
 * HSV → HSL。用于从明度条的结果回到内部 HSL 记忆值。
 * @param {number} h @param {number} s 0~100 @param {number} v 0~100
 * @returns {{h:number,s:number,l:number}}
 */
export function hsvToHsl(h, s, v) {
  const { r, g, b } = hsvToRgb(h, s, v)
  return rgbToHsl(r, g, b)
}

/**
 * 生成竖直明度条的背景渐变。
 *
 * 顶端为当前色相/饱和度下的**纯色**（V=100），底端为纯黑。
 * @param {number} h @param {number} s 0~100
 * @returns {string}
 */
export function valueBarGradient(h, s) {
  const top = hsvToRgb(h, s, 100)
  return `linear-gradient(to bottom, ${rgbToHex(top.r, top.g, top.b)}, #000000)`
}

/**
 * 生成竖直明度条的渐变：顶端是当前色相/饱和度的纯色（V=100），底端纯黑（V=0）。
 *
 * 【为什么是纯线性，没有"感知"模式了】
 * 曾提供 `linear` / `perceptual`（在 V 上做 smoothstep）两档切换。
 * 但"感知"档会让**把手位置与颜色脱钩** ——
 * 把手在 30% 处显示的却可能是 50% 的明度，用户看到与得到不一致。
 * 明度条是取值控件，位置必须等于取值，因此只保留线性。
 *
 * @param {number} h @param {number} s 0~100
 * @param {number} [steps=11] 渐变采样段数（越多越平滑）
 * @returns {string}
 */
export function valueGradient(h, s, steps = 11) {
  const stops = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    // t=0（顶端）→ V=100 纯色；t=1（底端）→ V=0 纯黑
    const c = hsvToRgb(h, s, (1 - t) * 100)
    stops.push(`${rgbToHex(c.r, c.g, c.b)} ${(t * 100).toFixed(1)}%`)
  }
  return `linear-gradient(to bottom, ${stops.join(', ')})`
}

// ─────────────────────────────────────────────
// 绝对色度（供 ColorPicker 的解释性提示使用）
// ─────────────────────────────────────────────

/**
 * 计算 HSL 的**绝对色度**（chroma）。
 *
 * chroma = S × (1 - |2L - 1|)，即换算成 RGB 后的通道差比例。
 *
 * 【为什么还留着这个函数】
 * ensureHueVisible（自动提饱和/拉亮度）已按"所见即所得"的要求撤销。
 * 但**提示**还需要它：S=0 或 L∈{0%,100%} 时拖色相环颜色不变，
 * 这是数学上的正确结果（饱和度被亮度因子吞掉），不是 bug。
 * 用它算出"低到肉眼看不出"的程度，再据此显示解释性文案，
 * 避免用户以为功能坏了。
 *
 * @param {number} s 饱和度 0~100
 * @param {number} l 亮度 0~100
 * @returns {number} 0~100
 */
export function hslChroma(s, l) {
  const sn = Math.max(0, Math.min(100, Number(s) || 0)) / 100
  const ln = Math.max(0, Math.min(100, Number(l) || 0)) / 100
  return sn * (1 - Math.abs(2 * ln - 1)) * 100
}

// ─────────────────────────────────────────────
// 色轮（阶段 5 补丁 10：替代色相环）
// ─────────────────────────────────────────────

/**
 * 色轮中心的**死区半径占比**。
 *
 * 【为什么要死区】
 * S 与半径是线性关系（`S = 100 × r / R`），所以在中心附近 1px 位移
 * 会让 S 跳变好几个百分点 —— 想精确停在 S=5% 这种低饱和几乎不可能。
 * 死区内直接判定 S=0，让"我要纯灰"这个意图可以点中心达成。
 *
 * 取 10%：120px 的色轮 → 半径 60px → 死区 6px，够小不影响精度，
 * 又足够大到"手抖点不进去"。
 */
export const WHEEL_DEAD_ZONE = 0.1

/**
 * 色轮上"半径比例 → 饱和度"。**pointToHS 与 wheelGradient 共用这一个函数**，
 * 这是"看到什么颜色就点到什么颜色"的保证：
 * 绘制用的 S 与取色用的 S 来自同一处，不可能再对不上。
 *
 * @param {number} radiusRatio 0~1（半径比例，1 = 圆边）
 * @returns {number} 饱和度 0~100
 */
export function wheelSaturationAt(radiusRatio) {
  const r = Number(radiusRatio)
  if (!Number.isFinite(r) || r <= 0) return 0
  // 死区内一律 S=0
  if (r <= WHEEL_DEAD_ZONE) return 0
  return Math.min(100, r * 100)
}

/**
 * 点的相对坐标 → 饱和度与色相。
 *
 * 【坐标系】
 * dx = 点相对圆心的水平偏移（右为正）
 * dy = 点相对圆心的垂直偏移（**下为正**，与 DOM 的 clientY 一致）
 * 角度定义与 hueRingGradient 保持一致：**顶部为 0°，顺时针增加**。
 *
 * 【为什么用 HSV 而不是 HSL】
 * HSL 的 L 会随 S 变化 —— 拖到边缘时颜色会忽明忽暗；
 * 且色轮与竖直明度条都在改"亮度"，语义重叠。
 * HSV 的 H/S 独立于 V，拖色轮时明暗稳定，与明度条正交。
 *
 * @param {number} dx 水平偏移
 * @param {number} dy 垂直偏移
 * @param {number} radius 色轮可用半径（像素）
 * @returns {{h:number, s:number}} h 0~360、s 0~100
 */
export function pointToHS(dx, dy, radius) {
  if (!(radius > 0) || !Number.isFinite(dx) || !Number.isFinite(dy)) {
    return { h: 0, s: 0 }
  }
  // pointToHue 已经处理了 0/360 归一化，直接复用保证与色相环一致
  const h = pointToHue(dx, dy)
  const r = Math.sqrt(dx * dx + dy * dy) / radius
  return { h, s: wheelSaturationAt(r) }
}

/**
 * 饱和度与色相 → 点的相对坐标（色轮小点定位）。
 *
 * @param {number} h 0~360
 * @param {number} s 0~100
 * @param {number} radius 色轮可用半径（像素）
 * @returns {{x:number, y:number}} 相对圆心的偏移（y 向下为正）
 */
export function hsToPoint(h, s, radius) {
  const { x, y } = hueToPoint(h, radius)
  const k = Math.max(0, Math.min(100, Number(s) || 0)) / 100
  return { x: x * k, y: y * k }
}

/**
 * 生成色轮背景。
 *
 * 【两层叠加】
 * 底层：conic-gradient 铺当前明度下的**满饱和**纯色（S=100）
 * 顶层：一个径向遮罩，用**同明度的灰**把中心方向"冲淡"，
 *       使任意半径处**看到的饱和度恰好等于点下去得到的饱和度**。
 *
 * 【必须与 pointToHS 严格一致 —— 这是一次真实 BUG 的修复】
 * 旧实现的遮罩是**反的**：中心透明（显示满饱和色）、边缘盖灰。
 * 而 pointToHS 是"半径越大饱和度越高"。两者正好相反，于是：
 *   在 15% 半径处看到的是**大红**（S=100），点下去却得到 S=15% 的**淡粉**。
 *   只有 55% 半径附近两者偶然相等，其余位置全都"所见非所得"。
 *
 * 正确的遮罩不透明度由饱和度**反解**而来（不用手调百分比）：
 *   把满饱和色 C 与同明度灰 G 混合，结果为 C(1-a) + G·a。
 *   在 HSV 里这等价于保持 V 不变、饱和度变成 (1-a)：
 *     hsvToRgb(h, S, V)  ==  mix(hsvToRgb(h, 100, V), hsvToRgb(0, 0, V), 1 - S/100)
 *   所以要显示饱和度 S，遮罩不透明度就是 **a = 1 - S/100**：
 *     a=1 → 全灰（S=0，对应圆心与死区）
 *     a=0 → 满饱和（S=100，对应圆边）
 *
 * 停靠点直接调用 `wheelSaturationAt`（与取色同一个函数）生成，
 * 因此**只要那个函数不变，色轮就不可能再和取色对不上**。
 *
 * @param {number} v 当前明度 0~100
 * @returns {{background:string, center:string}} background 为完整 background 值
 */
export function wheelGradient(v) {
  const vn = Math.max(0, Math.min(100, Number(v) || 0)) / 100

  // 底层：满饱和色相锥形（沿圆周铺色相）
  const stops = []
  const STEPS = 36
  for (let i = 0; i <= STEPS; i++) {
    const h = (i / STEPS) * 360
    const c = hsvToRgb(h, 100, vn * 100)
    stops.push(`${rgbToHex(c.r, c.g, c.b)} ${((i / STEPS) * 100).toFixed(2)}%`)
  }

  // 顶层遮罩：当前明度下的灰，不透明度按"要显示的饱和度"反解
  const gray = hsvToRgb(0, 0, vn * 100)
  const grayHex = rgbToHex(gray.r, gray.g, gray.b)

  /** 半径比例 → 遮罩不透明度（= 1 - 该处应有的饱和度） */
  const alphaAt = (r) => 1 - wheelSaturationAt(r) / 100

  // 死区边界（r=WHEEL_DEAD_ZONE）两侧要各放一个停靠点：
  // 那里 S 从 0 直接跳到 10，是一条**有意为之**的硬边（见 WHEEL_DEAD_ZONE 的说明）。
  // 不加这两个点，浏览器会把跳变平滑掉，圆心附近的颜色就与取色对不上了。
  const MASK_STOPS = 24
  const mask = []
  mask.push(`${hexToRgba(grayHex, alphaAt(0))} 0%`)
  mask.push(`${hexToRgba(grayHex, alphaAt(WHEEL_DEAD_ZONE))} ${(WHEEL_DEAD_ZONE * 100).toFixed(2)}%`)
  for (let i = 1; i <= MASK_STOPS; i++) {
    const t = i / MASK_STOPS
    const r = WHEEL_DEAD_ZONE + (1 - WHEEL_DEAD_ZONE) * t
    mask.push(`${hexToRgba(grayHex, alphaAt(r))} ${(r * 100).toFixed(2)}%`)
  }

  return {
    background:
      // 【必须显式写 closest-side —— 这是第二次踩到的坑】
      // `radial-gradient(circle at center, …)` 的默认尺寸是 **farthest-corner**：
      // 120×120 的圆里它是 84.85px（半对角线），而不是 60px（半边长）。
      // 于是所有百分比停靠点都被拉伸了 1.41 倍 ——
      // 边缘本该是 S=100，实际只画到 S≈68，色轮整体发白。
      // closest-side 把 100% 精确锚在"半边长"上，也是唯一与
      // `Math.min(w,h)/2`（取色用的半径）一致的定义。
      `radial-gradient(circle closest-side at center, ${mask.join(', ')}), ` +
      `conic-gradient(from 0deg, ${stops.join(', ')})`,
    center: grayHex,
  }
}

/**
 * #rrggbb + alpha → rgba() 字符串。
 * @param {string} hex @param {number} alpha 0~1
 * @returns {string}
 */
function hexToRgba(hex, alpha) {
  const c = hexToRgb(hex)
  if (!c) return 'rgba(128, 128, 128, 1)'
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`
}
