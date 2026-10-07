// @ts-check
/**
 * 展示 / 全屏模式（阶段 4）。
 *
 * 【为什么拆成三层】
 * 1. **模式状态**（isPresenting）—— UI 是否隐藏。纯状态，不碰 DOM。
 * 2. **浏览器全屏**（requestFullscreen）—— 只是让浏览器进入全屏。
 *    受限环境（iOS Safari、不支持 Fullscreen API）拿不到，于是需要降级。
 * 3. **控制条自动隐藏**（idle 检测）—— 鼠标移动淡入、静止 2 秒淡出。
 *
 * 【为什么第 2 层可以失败而不影响第 1 层】
 * iOS Safari 的 <video> 有全屏，但**任意元素的全屏 API 不支持**
 * （iPhone 上 requestFullscreen 根本不存在，iPad 上会直接抛错）。
 * 所以"全屏"不能是进入展示模式的**前提**，只能是锦上添花：
 * 拿不到就退化成"伪全屏"——CSS 把界面铺满窗口，功能完全一致，
 * 只是浏览器标签栏/地址栏还在。用户看到一句提示即可。
 *
 * 【为什么一定要监听原生 fullscreenchange】
 * 用户可能用 F11、系统手势、浏览器菜单退出全屏 —— 这些都绕过我们的按钮。
 * 如果只听自己的按钮，界面就会永远卡在"UI 全部隐藏"的状态，
 * 看起来像应用坏了。监听原生事件是这个状态机的**兜底收敛路径**。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useUiStore } from '@/stores/uiStore'

/** 鼠标静止多少毫秒后控制条淡出 */
export const IDLE_HIDE_MS = 2000

/** 控制条淡入/淡出动画时长（毫秒），与 CSS 保持一致 */
export const CONTROL_FADE_MS = 220

/**
 * 当前环境是否支持任意元素全屏。
 * iOS Safari（含 iPadOS）不支持 → 走伪全屏降级。
 * @returns {boolean}
 */
export function supportsElementFullscreen() {
  if (typeof document === 'undefined') return false
  const d = /** @type {any} */ (document)
  // iPhone/iPad 上 Fullscreen API 对普通元素缺席；iPadOS 桌面模式下
  // 有 API 但会抛错，因此两处都要判断
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || ''
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ 伪装成 Mac，用触点数量区分
    (ua.includes('Macintosh') && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
  if (isIOS) return false
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled)
}

/**
 * 展示模式控制器。
 *
 * @param {{ reduceMotion?: import('vue').Ref<boolean> }} [opts]
 */
export function useFullscreen(opts = {}) {
  const ui = useUiStore()

  // ── 第 1 层：模式状态 ──────────────────────
  /** 是否处于展示模式（UI 隐藏） */
  const isPresenting = ref(false)
  /** 是否真的拿到了浏览器全屏（false = 伪全屏降级） */
  const isNativeFullscreen = ref(false)
  /**
   * 原生全屏是否是**我们自己请求的**。
   *
   * 只有它为 true 时，fullscreenchange 的退出才收敛退出演示模式。
   * 伪全屏降级后为 false —— 用户自己按 F11 进出原生全屏时，
   * 我们不响应（否则会连带把演示也退掉）。
   */
  let requestedNative = false
  /** 降级原因，用于给用户提示 */
  const degradedReason = ref(/** @type {string|null} */ (null))

  /** 是否因为系统"减少动态效果"而跳过淡出动画 */
  const reduceMotion = opts.reduceMotion ?? ref(false)

  // ── 第 3 层：控制条空闲隐藏 ──────────────────
  /** 空闲计时器的当前剩余时间，供测试用 */
  const idleMsLeft = ref(IDLE_HIDE_MS)
  /** 控制条是否应当可见（isPresenting 为 false 时恒为 true） */
  const controlVisible = ref(true)

  let idleTimer = /** @type {number|null} */ (null)
  let tickTimer = /** @type {number|null} */ (null)
  let idleDeadline = 0

  function clearTimers() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (tickTimer !== null) {
      clearInterval(tickTimer)
      tickTimer = null
    }
    idleMsLeft.value = IDLE_HIDE_MS
  }

  /** 取消空闲计时，控制条保持可见 */
  function cancelIdle() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (tickTimer !== null) {
      clearInterval(tickTimer)
      tickTimer = null
    }
    idleMsLeft.value = IDLE_HIDE_MS
  }

  /**
   * 记录一次"用户有活动"：控制条淡入并重置空闲倒计时。
   * @param {boolean} [force] 即使已可见也重置倒计时
   */
  function markActivity(force = false) {
    if (!isPresenting.value) return
    if (!controlVisible.value) controlVisible.value = true
    else if (!force) return

    cancelIdle()
    idleDeadline = Date.now() + IDLE_HIDE_MS

    // 空闲计时器负责最终隐藏；
    // tickTimer 只是为了让测试能读到剩余时间（也让倒计时可视），
    // 两者用同一个 deadline，不会各走各的。
    idleTimer = /** @type {number} */ (
      setTimeout(() => {
        controlVisible.value = false
        idleTimer = null
        idleMsLeft.value = 0
        if (tickTimer !== null) {
          clearInterval(tickTimer)
          tickTimer = null
        }
      }, IDLE_HIDE_MS)
    )
    tickTimer = /** @type {number} */ (
      setInterval(() => {
        idleMsLeft.value = Math.max(0, idleDeadline - Date.now())
      }, 100)
    )
  }

  // ── 浏览器全屏进出 ──────────────────────────
  const d = typeof document === 'undefined' ? null : /** @type {any} */ (document)

  /**
   * 请求浏览器全屏。拿不到就静默失败（调用方负责提示降级）。
   *
   * 【为什么要同时兼容两套 API 名】
   * 标准是 requestFullscreen，但 Safari 至今仍用 webkit 前缀，
   * 且旧版是回调式（不返回 Promise）—— 所以不能直接 await fn()，
   * 必须判断返回值是不是 thenable。
   *
   * @param {HTMLElement} target
   * @returns {Promise<boolean>} 是否真的进入了全屏
   */
  async function requestNative(target) {
    try {
      const el = /** @type {any} */ (target)
      const fn = el.requestFullscreen || el.webkitRequestFullscreen
      if (typeof fn !== 'function') return false
      // navigationUI: 'hide' 让 Chrome 隐藏悬浮的播放控件
      const ret = fn.call(el, { navigationUI: 'hide' })
      if (ret && typeof ret.then === 'function') await ret
      return true
    } catch {
      return false
    }
  }

  /**
   * 退出浏览器全屏。
   * @returns {Promise<boolean>}
   */
  async function exitNative() {
    try {
      const fn = d?.exitFullscreen || d?.webkitExitFullscreen
      if (typeof fn !== 'function') return false
      const ret = fn.call(d)
      if (ret && typeof ret.then === 'function') await ret
      return true
    } catch {
      return false
    }
  }

  /** 原生全屏当前是否处于激活状态 */
  function nativeActive() {
    if (!d) return false
    const el = d.fullscreenElement || d.webkitFullscreenElement
    return !!el
  }

  /**
   * 原生全屏当前是否处于激活状态，**且是我们自己请求的**。
   *
   * 【为什么要区分"谁请求的"】
   * 伪全屏降级后，isPresenting 仍为 true、isNative 为 false。
   * 这时用户可能自己按 F11 进原生全屏（此时界面看起来一样，
   * 因为展示模式已经把 UI 都藏了），再按 F11 退出。
   *
   * 如果 fullscreenchange 一律"原生全屏空了 → 退出演示模式"，
   * 用户第二次按 F11 就会把整个演示也退掉 —— 但他只想退出浏览器全屏，
   * 并不想退出演示。更糟的是：伪全屏是**永久状态**，
   * 这次误退出会让用户莫名其妙回到编辑界面。
   *
   * 所以记录一个 requestedNative：只有"我们自己请求的原生全屏"
   * 被外部退出时，才收敛退出演示模式。
   * 用户手动 F11 进出的全屏，我们不认、不响应。
   */
  function requestedNativeActive() {
    return requestedNative && nativeActive()
  }

  /**
   * 原生 fullscreenchange 的统一处理。
   * 这是"用户用 F11 / 系统手势退出"的兜底收敛路径。
   */
  function onFullscreenChange() {
    // 伪全屏：原生全屏状态与我们无关，用户 F11 进出不改变展示模式
    if (!requestedNative) {
      // 只同步"当前是否真的在原生全屏"，不触发退出演示
      isNativeFullscreen.value = nativeActive()
      return
    }

    isNativeFullscreen.value = nativeActive()
    if (!isNativeFullscreen.value && isPresenting.value) {
      // 浏览器退出了**我们请求的**全屏，但展示模式还开着
      // → 用户显然想回到编辑界面，跟着退出，避免卡在"UI 全没了"的状态
      leavePresentation({ skipNativeExit: true })
    }
  }

  /**
   * 进入展示模式。
   * @param {HTMLElement} [target] 要全屏的元素（一般是 app-shell）
   * @param {{ onBeforeEnter?: () => void }} [hooks]
   */
  async function enterPresentation(target, hooks) {
    if (isPresenting.value) return

    // 关闭设置抽屉 —— 不只是为了"挡住歌词"（抽屉在展示模式下本就会淡出）。
    //
    // 【真机 BUG：抽屉开着时进全屏，右侧出现白边】
    // 抽屉打开会让 .app-shell 得到 padding-right: 360px（需求 N2 的避让）。
    // 原生全屏时 .app-shell 就是全屏元素，这条 padding 会被画在全屏视口内，
    // 把 .app-stage 挤窄；而 shell 自身透明，挤出来的那条没有任何背景，
    // 露出的就是浏览器白色画布。
    // （CSS 侧已加 padding-right: 0 兜底，这里是第二道防线：
    //   从源头不让两个状态共存，也顺带保证抽屉不会在全屏里残留。）
    hooks?.onBeforeEnter?.()

    isPresenting.value = true
    controlVisible.value = false // 进来就是干净歌词，控制条隐藏
    idleMsLeft.value = IDLE_HIDE_MS

    const el = target ?? document.documentElement
    if (supportsElementFullscreen()) {
      const ok = await requestNative(el)
      isNativeFullscreen.value = ok
      // 标记"这次原生全屏是我们请求的" ——
      // fullscreenchange 只在这个标记为真时才收敛退出演示模式，
      // 用户自己按 F11 进出不会把演示也带出去。
      requestedNative = ok
      if (!ok) {
        degradedReason.value = '浏览器拒绝了全屏请求，已切换为伪全屏'
        ui.push({
          level: 'info',
          message: '已切换为伪全屏',
          hint: `${degradedReason.value}；按 Esc 退出展示模式`,
        })
      } else {
        degradedReason.value = null
      }
    } else {
      // iOS Safari / 不支持 Fullscreen API
      isNativeFullscreen.value = false
      // 没有请求过原生全屏 → 用户后续自己按 F11 也不该影响展示模式
      requestedNative = false
      degradedReason.value = '当前浏览器不支持网页全屏（iOS Safari 常见），已切换为伪全屏'
      ui.push({
        level: 'info',
        message: '伪全屏模式',
        // 【为什么要在这里告诉用户怎么退出】
        // 原生全屏时浏览器自带"按 Esc 退出全屏"的提示，
        // 伪全屏没有这层兜底 —— 用户只看到界面全没了，
        // 不知道按 Esc 能退，等于被关在里面。
        hint: '界面已铺满窗口，浏览器地址栏无法隐藏；功能完全一致。按 Esc 退出展示模式',
      })
    }
  }

  /**
   * 退出演示模式。
   * @param {{ skipNativeExit?: boolean }} [o]
   */
  async function leavePresentation(o = {}) {
    if (!isPresenting.value) return
    isPresenting.value = false
    controlVisible.value = true
    clearTimers()
    // 先清标记：否则随后由 exitNative 触发的 fullscreenchange
    // 会被当成"我们自己请求的原生全屏被退出"，多走一次收敛逻辑。
    requestedNative = false

    if (!o.skipNativeExit && isNativeFullscreen.value) {
      await exitNative()
      isNativeFullscreen.value = false
    }
    isNativeFullscreen.value = false
  }

  /**
   * 切换。
   * @param {HTMLElement} [target]
   * @param {{ onBeforeEnter?: () => void }} [hooks]
   */
  function toggle(target, hooks) {
    if (isPresenting.value) {
      void leavePresentation()
    } else {
      void enterPresentation(target, hooks)
    }
  }

  // ── 全局事件绑定 ────────────────────────────
  /** 鼠标/触摸/笔/keyboard 活动都算"有活动" */
  function onActivity() {
    markActivity()
  }

  /** 指针移动距离小于这个像素数就忽略，避免抖动导致永不淡出 */
  const MOVE_THRESHOLD = 6
  let lastX = 0
  let lastY = 0
  let hasLast = false

  function onPointerMove(e) {
    if (!isPresenting.value) return
    if (hasLast) {
      const dx = Math.abs(e.clientX - lastX)
      const dy = Math.abs(e.clientY - lastY)
      if (dx < MOVE_THRESHOLD && dy < MOVE_THRESHOLD) return
    }
    lastX = e.clientX
    lastY = e.clientY
    hasLast = true
    markActivity()
  }

  function onTouchStart() {
    hasLast = false
    markActivity()
  }

  function onFullscreenChangeBound() {
    onFullscreenChange()
  }

  onMounted(() => {
    const fsEvents = d
      ? ['fullscreenchange', 'webkitfullscreenchange', 'fullscreenerror', 'webkitfullscreenerror']
      : []
    for (const ev of fsEvents) {
      d.addEventListener(ev, onFullscreenChangeBound)
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onActivity, { passive: true })
    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('keydown', onActivity, { passive: true })
    // 控制条上的操作（拖进度条等）本身也算活动
    window.addEventListener('wheel', onActivity, { passive: true })
  })

  onBeforeUnmount(() => {
    clearTimers()
    const fsEvents = d
      ? ['fullscreenchange', 'webkitfullscreenchange', 'fullscreenerror', 'webkitfullscreenerror']
      : []
    for (const ev of fsEvents) {
      d?.removeEventListener(ev, onFullscreenChangeBound)
    }
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerdown', onActivity)
    window.removeEventListener('touchstart', onTouchStart)
    window.removeEventListener('keydown', onActivity)
    window.removeEventListener('wheel', onActivity)
  })

  // 退出展示模式时不要留脏状态
  watch(isPresenting, (on) => {
    if (!on) {
      clearTimers()
      controlVisible.value = true
    }
  })

  const isDegraded = computed(() => isPresenting.value && !isNativeFullscreen.value)

  return {
    // 状态
    isPresenting,
    isNativeFullscreen,
    isDegraded,
    degradedReason,
    controlVisible,
    idleMsLeft,
    reduceMotion,
    // 动作
    enterPresentation,
    leavePresentation,
    toggle,
    markActivity,
    cancelIdle,
    // 能力探测
    supportsElementFullscreen,
    IDLE_HIDE_MS,
    CONTROL_FADE_MS,
  }
}

/**
 * 全局单例。
 *
 * 【为什么需要单例而不是各自 new 一个】
 * 展示模式被三处用到：App.vue（挂 CSS 类）、TopBar（「演示」按钮）、
 * useKeyboard（F / Esc 快捷键）。如果每个调用点都 new 一个，
 * 它们会持有**不同的 isPresenting**，按键和按钮就会各说各话。
 *
 * 事件监听（pointermove / fullscreenchange 等）也因此只会注册一次。
 *
 * @type {{current: ReturnType<typeof useFullscreen>|null}}
 */
const singleton = { current: /** @type {any} */ (null) }

/**
 * 取得全局唯一的展示模式控制器（首次调用时创建）。
 *
 * @param {{ reduceMotion?: import('vue').Ref<boolean> }} [opts]
 * @returns {ReturnType<typeof useFullscreen>}
 */
export function useFullscreenShared(opts) {
  if (!singleton.current) {
    singleton.current = useFullscreen(opts)
    // 开发期把控制器登记到 window.__lrcDiag.full，供验收脚本驱动。
    // 动态 import 避免把 devtools 打进生产包（与 main.js 同一策略）。
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
      import('@/devtools/diagHooks')
        .then((m) => m.registerFullscreen?.(singleton.current))
        .catch(() => {
          /* 登记失败不影响功能，忽略 */
        })
    }
  }
  return singleton.current
}
