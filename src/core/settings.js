// @ts-check
/**
 * 设置的默认值与字段元信息 —— 纯函数层，禁止 import vue。
 *
 * 这里是"唯一事实来源"：
 *  - settingsStore 用它做 localStorage 的逐字段兜底
 *  - CSS 变量映射用它决定哪些字段需要转成 --lrc-*
 *  - 设置面板的滑杆范围也从这里读，避免"UI 能拖到 3，逻辑只认到 1"的错位
 */

export const SETTINGS_VERSION = 1

/** @typedef {ReturnType<typeof createDefaultSettings>} Settings */

export function createDefaultSettings() {
  return {
    version: SETTINGS_VERSION,

    font: {
      family: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
      size: 40, // px（在 1080p 高度下的基准字号）
      weight: 600,
      letterSpacing: 0.02, // em
      lineHeight: 1.6, // 倍数
      scale: 1.35, // 当前行放大比例
    },

    color: {
      normal: '#9aa4b2',
      active: '#ffffff',
      /**
       * 刚打完的那一行（打轴模式的 is-tapped）。
       *
       * 取 UI accent 蓝 #4c8dff —— 与 active（白）、normal（灰）明显不同，
       * 蓝色也符合"刚操作完/待确认"的直觉。
       */
      tapped: '#4c8dff',
      bg: '#0b0e14',
      bgMode: 'solid', // solid | green | black
    },

    layout: {
      align: 'center', // left | center | right
      padTop: 0.35, // 视口高度比例
      padBottom: 0.35,
      maxWidth: 0.9,
    },

    motion: {
      transitionMs: 260,
      activeFadeMs: 180,
      scrollMode: 'center', // center | golden
      followUser: 'resume', // resume | manual
      reduceMotion: false,
    },

    /**
     * 歌词虚化：以当前行为中心，距离越远的行越透明。
     * 规则与默认值详见 core/fade.js。
     */
    fade: {
      enabled: true,
      solidAbove: 2, // 当前行上方保持完全不透明的行数
      solidBelow: 2, // 当前行下方保持完全不透明的行数
      fadeRows: 5, // 实体区边缘往外渐变的行数
      mode: 'ease', // linear | ease | none
    },

    sync: {
      bpm: null,
      firstBeatMs: 0,
      snap: 'none', // none | nearest | next
    },

    export: {
      /** 分辨率 preset id：480p | 720p | 1080p | 2k | 4k（见 RESOLUTION_PRESETS） */
      resolution: '720p',
      width: 1280,
      height: 720,
      fps: 30,
      bgMode: 'solid', // solid | green | black | transparent(实验占位)
      bitrateMbps: 8,
      watermark: '',
    },
  }
}

/**
 * 导出分辨率预设。
 *
 * 【为什么成品率由"短边"决定】
 * 16:9 下 480p/720p/1080p/2K/4K 的高度分别是 480/720/1080/1440/2160。
 * 预览舞台的宽高比会随窗口变化，导出统一按 16:9 输出，
 * 横向按预览舞台的宽高比等比缩放并居中补边（见 renderFrame 的版心逻辑），
 * 因此无论窗口多宽，换行位置都与预览一致。
 */
export const RESOLUTION_PRESETS = [
  { id: '480p', label: '480p', width: 854, height: 480 },
  { id: '720p', label: '720p', width: 1280, height: 720 },
  { id: '1080p', label: '1080p', width: 1920, height: 1080 },
  { id: '2k', label: '2K', width: 2560, height: 1440 },
  { id: '4k', label: '4K', width: 3840, height: 2160 },
]

/** 导出帧率预设 */
export const FPS_PRESETS = [
  { value: 24, label: '24 帧（电影感）' },
  { value: 30, label: '30 帧（常用）' },
  { value: 60, label: '60 帧（顺滑）' },
]

/**
 * 按 id 取分辨率预设；未知 id 回落到 720p。
 * @param {string} id
 * @returns {{id:string,label:string,width:number,height:number}}
 */
export function findResolution(id) {
  return RESOLUTION_PRESETS.find((p) => p.id === id) ?? RESOLUTION_PRESETS[1]
}

/**
 * 按画布高宽推断最接近的分辨率 preset id（用于设置面板回显）。
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function nearestResolutionId(width, height) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return '720p'
  let best = RESOLUTION_PRESETS[1]
  let bestDiff = Infinity
  for (const p of RESOLUTION_PRESETS) {
    const d = Math.abs(p.height - h) + Math.abs(p.width - w)
    if (d < bestDiff) {
      bestDiff = d
      best = p
    }
  }
  return best.id
}

/**
 * 字段元信息：范围 + 步长 + 单位。
 * UI 控件与校验都从这里取值，防止两处硬编码不一致。
 */
export const FIELD_META = {
  'font.size': { min: 12, max: 160, step: 1, unit: 'px' },
  'font.weight': { min: 100, max: 900, step: 100, unit: '' },
  'font.letterSpacing': { min: -0.1, max: 1, step: 0.01, unit: 'em' },
  'font.lineHeight': { min: 1, max: 4, step: 0.05, unit: '倍' },
  'font.scale': { min: 1, max: 3, step: 0.01, unit: '倍' },
  'layout.padTop': { min: 0, max: 0.5, step: 0.01, unit: '' },
  'layout.padBottom': { min: 0, max: 0.5, step: 0.01, unit: '' },
  'layout.maxWidth': { min: 0.3, max: 1, step: 0.01, unit: '' },
  'motion.transitionMs': { min: 0, max: 2000, step: 10, unit: 'ms' },
  'motion.activeFadeMs': { min: 0, max: 2000, step: 10, unit: 'ms' },
  'sync.bpm': { min: 20, max: 300, step: 0.01, unit: 'BPM' },
  'sync.firstBeatMs': { min: -5000, max: 5000, step: 1, unit: 'ms' },
  // 虚化
  'fade.solidAbove': { min: 0, max: 20, step: 1, unit: '行' },
  'fade.solidBelow': { min: 0, max: 20, step: 1, unit: '行' },
  'fade.fadeRows': { min: 0, max: 30, step: 1, unit: '行' },
  'export.width': { min: 320, max: 3840, step: 2, unit: 'px' },
  'export.height': { min: 240, max: 2160, step: 2, unit: 'px' },
  'export.fps': { min: 10, max: 60, step: 1, unit: 'fps' },
  'export.bitrateMbps': { min: 1, max: 50, step: 1, unit: 'Mbps' },
}

export const FONT_FAMILY_PRESETS = [
  { label: '系统默认', value: 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif' },
  { label: '黑体 / 无衬线', value: '"Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif' },
  { label: '宋体 / 衬线', value: '"Songti SC", SimSun, Georgia, serif' },
  { label: '等宽', value: 'Consolas, "Courier New", ui-monospace, monospace' },
  { label: '楷体', value: 'KaiTi, "Kaiti SC", STKaiti, serif' },
  { label: '圆体', value: '"Yuanti SC", "Hiragino Maru Gothic ProN", "Microsoft YaHei", sans-serif' },
]

/**
 * 取值 + 兜底：类型不符或越界就回到默认值。
 * 这是 localStorage 容错的核心 —— 任何脏数据都不该让页面白屏。
 * @param {any} obj 源对象
 * @param {string} path 形如 'font.size'
 * @param {any} fallback
 */
export function pick(obj, path, fallback) {
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return fallback
    cur = cur[p]
  }
  if (cur === undefined || cur === null) return fallback

  if (typeof fallback === 'number') {
    const n = Number(cur)
    if (!Number.isFinite(n)) return fallback
    const meta = FIELD_META[path]
    if (meta) {
      if (n < meta.min) return fallback
      if (n > meta.max) return fallback
    }
    return n
  }
  if (typeof fallback === 'string') {
    return typeof cur === 'string' && cur.length > 0 ? cur : fallback
  }
  if (typeof fallback === 'boolean') {
    return typeof cur === 'boolean' ? cur : fallback
  }
  return cur
}

/**
 * 用默认值逐字段兜底任意输入，产出一个一定合法的 Settings。
 * 绝不抛异常 —— 坏数据只会被静默替换成默认值。
 * @param {any} raw
 * @returns {Settings}
 */
export function sanitizeSettings(raw) {
  const d = createDefaultSettings()
  if (!raw || typeof raw !== 'object') return d

  /** @type {any} */
  const out = createDefaultSettings()

  out.version = SETTINGS_VERSION
  out.font.family = pick(raw, 'font.family', d.font.family)
  out.font.size = pick(raw, 'font.size', d.font.size)
  out.font.weight = pick(raw, 'font.weight', d.font.weight)
  out.font.letterSpacing = pick(raw, 'font.letterSpacing', d.font.letterSpacing)
  out.font.lineHeight = pick(raw, 'font.lineHeight', d.font.lineHeight)
  out.font.scale = pick(raw, 'font.scale', d.font.scale)

  out.color.normal = normalizeColor(pick(raw, 'color.normal', d.color.normal), d.color.normal)
  out.color.active = normalizeColor(pick(raw, 'color.active', d.color.active), d.color.active)
  out.color.tapped = normalizeColor(pick(raw, 'color.tapped', d.color.tapped), d.color.tapped)
  out.color.bg = normalizeColor(pick(raw, 'color.bg', d.color.bg), d.color.bg)
  out.color.bgMode = pickEnum(pick(raw, 'color.bgMode', d.color.bgMode), ['solid', 'green', 'black'], d.color.bgMode)

  out.layout.align = pickEnum(pick(raw, 'layout.align', d.layout.align), ['left', 'center', 'right'], d.layout.align)
  out.layout.padTop = pick(raw, 'layout.padTop', d.layout.padTop)
  out.layout.padBottom = pick(raw, 'layout.padBottom', d.layout.padBottom)
  out.layout.maxWidth = pick(raw, 'layout.maxWidth', d.layout.maxWidth)

  out.motion.transitionMs = pick(raw, 'motion.transitionMs', d.motion.transitionMs)
  out.motion.activeFadeMs = pick(raw, 'motion.activeFadeMs', d.motion.activeFadeMs)
  out.motion.scrollMode = pickEnum(pick(raw, 'motion.scrollMode', d.motion.scrollMode), ['center', 'golden'], d.motion.scrollMode)
  out.motion.followUser = pickEnum(pick(raw, 'motion.followUser', d.motion.followUser), ['resume', 'manual'], d.motion.followUser)
  out.motion.reduceMotion = pick(raw, 'motion.reduceMotion', d.motion.reduceMotion)

  // 虚化
  out.fade.enabled = pick(raw, 'fade.enabled', d.fade.enabled)
  out.fade.solidAbove = pick(raw, 'fade.solidAbove', d.fade.solidAbove)
  out.fade.solidBelow = pick(raw, 'fade.solidBelow', d.fade.solidBelow)
  out.fade.fadeRows = pick(raw, 'fade.fadeRows', d.fade.fadeRows)
  out.fade.mode = pickEnum(pick(raw, 'fade.mode', d.fade.mode), ['linear', 'ease', 'none'], d.fade.mode)

  const bpm = pick(raw, 'sync.bpm', d.sync.bpm)
  out.sync.bpm = bpm === null ? null : bpm
  out.sync.firstBeatMs = pick(raw, 'sync.firstBeatMs', d.sync.firstBeatMs)
  out.sync.snap = pickEnum(pick(raw, 'sync.snap', d.sync.snap), ['none', 'nearest', 'next'], d.sync.snap)

  out.export.resolution = pickEnum(
    pick(raw, 'export.resolution', d.export.resolution),
    RESOLUTION_PRESETS.map((p) => p.id),
    d.export.resolution,
  )
  out.export.width = pick(raw, 'export.width', d.export.width)
  out.export.height = pick(raw, 'export.height', d.export.height)
  out.export.fps = pick(raw, 'export.fps', d.export.fps)
  out.export.bgMode = pickEnum(pick(raw, 'export.bgMode', d.export.bgMode), ['solid', 'green', 'black'], d.export.bgMode)
  out.export.bitrateMbps = pick(raw, 'export.bitrateMbps', d.export.bitrateMbps)
  out.export.watermark = typeof raw?.export?.watermark === 'string' ? raw.export.watermark : d.export.watermark

  return out
}

/** 只接受白名单里的字符串，否则回默认。 */
export function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/**
 * 颜色归一化：只接受 #rgb / #rrggbb / #rrggbbaa。
 * @param {any} value
 * @param {string} fallback
 * @returns {string}
 */
export function normalizeColor(value, fallback) {
  if (typeof value !== 'string') return fallback
  const v = value.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(v)) {
    // #abc → #aabbcc，便于统一处理
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
  }
  if (/^#[0-9a-f]{6}$/.test(v)) return v
  if (/^#[0-9a-f]{8}$/.test(v)) return v
  return fallback
}

/**
 * 把设置翻译成 CSS 变量对象（供 :style 绑定）。
 * 好处：改一个设置只触发一次样式重算，且全局所有行共享同一套变量。
 * @param {Settings} s
 * @returns {Record<string,string>}
 */
export function toCssVars(s) {
  const bgModeColor =
    s.color.bgMode === 'green' ? '#00b140' : s.color.bgMode === 'black' ? '#000000' : s.color.bg

  return {
    '--lrc-font-family': s.font.family,
    '--lrc-font-size': `${s.font.size}px`,
    '--lrc-font-weight': String(s.font.weight),
    '--lrc-letter-spacing': `${s.font.letterSpacing}em`,
    '--lrc-line-height': String(s.font.lineHeight),
    '--lrc-active-scale': String(s.font.scale),
    '--lrc-color-normal': s.color.normal,
    '--lrc-color-active': s.color.active,
    '--lrc-color-tapped': s.color.tapped,
    '--lrc-bg': bgModeColor,
    '--lrc-align': s.layout.align,
    '--lrc-pad-top': `${s.layout.padTop * 100}%`,
    '--lrc-pad-bottom': `${s.layout.padBottom * 100}%`,
    '--lrc-max-width': `${s.layout.maxWidth * 100}%`,
    '--lrc-transition': `${s.motion.transitionMs}ms`,
    '--lrc-fade': `${s.motion.activeFadeMs}ms`,
  }
}
