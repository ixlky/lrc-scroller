// @ts-check
/**
 * 自动滚动 —— 把"当前行 + 设置"翻译成轨道的 translate3d 位移。
 *
 * 【为什么用 transform 而不是 scrollTop】
 *  - scrollTop 赋值会触发主线程布局与重绘，长歌词明显掉帧
 *  - transform 走 GPU 合成层，且**不参与布局**，所以当前行用 transform: scale 放大时
 *    相邻行位置纹丝不动（这是验收项，不是巧合）
 *
 * 【为什么每帧只写不读】
 * 行几何（offsetTop）只在歌词/设置变化时测量一次并缓存。
 * rAF 循环里只做纯计算 + 一次 style 写入，从不读布局属性，
 * 因此不会触发 layout thrashing（读写交错导致强制同步布局）。
 *
 * 【与阶段 2 的衔接】
 * 时间来源完全来自 playerStore.currentTime，
 * 所以"有音频"与"模拟时钟"两种模式自动都支持（需求 N1 的收益在此体现）。
 */

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useLyricsStore } from '@/stores/lyricsStore'
import { usePlayerStore } from '@/stores/playerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { findLineIndexAt } from '@/core/timeUtils'
import {
  computeCenteringOffset,
  smoothTowards,
  isSettled,
  isLineOffscreen,
  findRowAtViewportCenter,
} from '@/core/scroll'

/**
 * 创建一个自动滚动控制器。
 * @param {Object} p
 * @param {import('vue').Ref<HTMLElement|null>} p.containerRef 可视容器（overflow:hidden）
 * @param {import('vue').Ref<HTMLElement|null>} p.trackRef 轨道（被 translate 的元素）
 * @param {import('vue').Ref<Array<HTMLElement>>} [p.rowRefs] 可选：行元素数组，用于精确测量
 */
export function useAutoScroll({ containerRef, trackRef }) {
  const lyrics = useLyricsStore()
  const player = usePlayerStore()
  const settings = useSettingsStore()

  const { currentTime } = storeToRefs(player)

  /** 当前行下标（二分查找，O(log n)） */
  const activeIndex = computed(() => findLineIndexAt(lyrics.lines, currentTime.value))

  /** 缓存的每行几何：[{top, height}]，相对轨道顶部 */
  const rowMetrics = ref(/** @type {Array<{top:number,height:number}>} */ ([]))
  /** 轨道总高度 */
  const contentHeight = ref(0)
  /** 容器高度 */
  const containerHeight = ref(0)

  /** 当前显示的位移（正值，表示轨道向上移动了多少） */
  const currentOffset = ref(0)
  /** 目标位移 */
  const targetOffset = ref(0)

  /** 是否处于"用户正在自己滚动"的状态 */
  const userScrolling = ref(false)
  /** 用户最近一次交互的时间戳 */
  let lastUserAction = 0
  /** 恢复跟随的定时器 */
  let resumeTimer = 0

  /** 是否已经测量过几何 */
  const measured = ref(false)

  /** 当前行是否不在视野内（用于显示"回到当前行"） */
  const activeOffscreen = computed(() => {
    const m = rowMetrics.value[activeIndex.value]
    return isLineOffscreen(currentOffset.value, m, containerHeight.value)
  })

  /**
   * 虚化中心行。
   *
   * - 自动跟随状态（userScrolling=false）→ 当前播放行
   * - 用户滚动中（userScrolling=true）  → 视口中心对应的那一行
   *
   * 需求："用户滚轮滚动时，虚化中心 = 用户当前视口中心对应的那一行，
   *      让用户回看时也能看清"，停止滚动 3 秒后恢复为当前播放行。
   *
   * 之所以做成 computed：它依赖 userScrolling 与 currentOffset，
   * 两者变化时才重新求值；而在同一行内滚动时结果不变，
   * 于是虚化缓存命中、不会逐帧重算（有 computeCount 可证）。
   */
  const centerIndex = computed(() => {
    if (!userScrolling.value) return activeIndex.value
    const idx = findRowAtViewportCenter(rowMetrics.value, currentOffset.value, containerHeight.value)
    return idx >= 0 ? idx : activeIndex.value
  })

  /**
   * 位移的合法区间。
   *
   * 下界 = 首行居中所需位移（通常为负，轨道向下推，露出上方留白）
   * 上界 = 末行居中所需位移
   *
   * 注意不能沿用 [0, contentHeight - containerHeight]：
   * 那个区间是按"按页滚动"设计的，会让首行永远无法居中（实测偏差可达 92px）。
   * 用居中的几何语义算区间，才能保证任何一行都能精确停在容器中心。
   */
  function getBounds() {
    const metrics = rowMetrics.value
    const h = containerHeight.value
    if (!metrics.length || !(h > 0)) return { min: 0, max: 0 }
    const anchor = settings.settings.motion.scrollMode === 'golden' ? 0.38 : 0.5

    const first = metrics[0]
    const last = metrics[metrics.length - 1]
    const min = computeCenteringOffset(first, h, anchor)
    const max = computeCenteringOffset(last, h, anchor)
    return max > min ? { min, max } : { min, max: min }
  }

  /** 把位移夹到合法区间 */
  function clampOffset(target) {
    const { min, max } = getBounds()
    if (!Number.isFinite(target)) return min
    if (target < min) return min
    if (target > max) return max
    return target
  }

  // ────────────────────────────────────────────
  // 测量
  // ────────────────────────────────────────────

  /**
   * 测量行几何并缓存。
   *
   * 只在歌词/字号/行距/留白变化时调用，绝不放进 rAF 循环。
   * 读一次 offsetTop 会让浏览器 flush 布局，如果每帧都读就会拖慢整体帧率。
   */
  function measure() {
    const container = containerRef.value
    const track = trackRef.value

    /*
     * 阶段 5 前置修复：轨道消失时必须**清空**行几何，不能直接返回。
     *
     * 【为什么这是第 3 步的前置条件】
     * 原本 `if (!container || !track) return` 会把 rowMetrics 留在上一次的值上。
     * 触发路径（N3 引入条件渲染轨道后才暴露）：
     *   载入内置示例（14 行）→ 导入纯 .txt（0 行）→ 轨道 DOM 被移除
     *   → measured 正确变成 false，但 rowCount 仍是 14
     * 第 3 步打轴会**往轨道里灌行**，此时残留的 14 条几何会让
     * getBounds() 用"已经不存在的行"去算滚动上下界，直接算错。
     *
     * 所以这里显式清空：没有轨道就没有行，状态必须一致。
     */
    if (!container || !track) {
      rowMetrics.value = []
      measured.value = false
      containerHeight.value = container ? container.clientHeight : 0
      contentHeight.value = 0
      return
    }

    containerHeight.value = container.clientHeight
    contentHeight.value = track.scrollHeight

    const rows = track.querySelectorAll('[data-line-index]')
    /** @type {Array<{top:number,height:number}>} */
    const metrics = new Array(rows.length)

    // 用 offsetTop/offsetHeight：这两个值相对 offsetParent，
    // 而轨道的 offsetParent 就是容器（容器 position:relative），因此可直接当"相对轨道的顶部"使用。
    for (let i = 0; i < rows.length; i++) {
      const el = /** @type {HTMLElement} */ (rows[i])
      const index = Number(el.dataset.lineIndex)
      metrics[index] = { top: el.offsetTop, height: el.offsetHeight }
    }

    // 补齐可能的空洞（虚拟滚动下未渲染的行）
    for (let i = 0; i < metrics.length; i++) {
      if (!metrics[i]) metrics[i] = { top: 0, height: 0 }
    }

    rowMetrics.value = metrics
    measured.value = metrics.length > 0
  }

  /**
   * 计算当前行应处的位移。
   * @returns {number}
   */
  function computeTarget() {
    const idx = activeIndex.value
    const h = containerHeight.value
    const anchor = settings.settings.motion.scrollMode === 'golden' ? 0.38 : 0.5
    const metrics = rowMetrics.value
    if (!metrics.length || !(h > 0)) return 0

    // 还没到第一行（index < 0）时也把首行居中，而不是简单停在 0，
    // 否则歌曲开头第一句不在屏幕中间，观感上像是"没对齐"。
    const metric = idx < 0 ? metrics[0] : metrics[idx]
    if (!metric) return currentOffset.value

    return clampOffset(computeCenteringOffset(metric, h, anchor))
  }

  // ────────────────────────────────────────────
  // rAF 循环
  // ────────────────────────────────────────────

  let rafId = 0
  let lastFrameTime = 0
  /** 帧计数，供验收脚本确认循环真的在跑/已停 */
  let frameCount = 0

  function applyOffset(value) {
    const track = trackRef.value
    if (!track) return
    // 唯一的写入点。用 translate3d 触发 GPU 合成，并保留 0.01px 精度避免抖动
    track.style.transform = `translate3d(0, ${(-value).toFixed(2)}px, 0)`
  }

  function tick(now) {
    frameCount++
    const dt = lastFrameTime ? now - lastFrameTime : 16.7
    lastFrameTime = now

    // 用户手动滚动期间，视图归用户控制，自动滚动让位
    if (userScrolling.value) {
      targetOffset.value = currentOffset.value
      rafId = requestAnimationFrame(tick)
      return
    }

    targetOffset.value = computeTarget()

    const reduce = settings.reduceMotion

    if (reduce) {
      // 减少动态效果：直接对齐，不做补间
      currentOffset.value = targetOffset.value
      applyOffset(currentOffset.value)
    } else {
      const next = smoothTowards(currentOffset.value, targetOffset.value, dt)
      currentOffset.value = next
      applyOffset(next)
    }

    // 已到位且不在播放 → 停止循环，避免无意义耗电
    const settled = isSettled(currentOffset.value, targetOffset.value)
    if (settled && !player.playing) {
      currentOffset.value = targetOffset.value
      applyOffset(currentOffset.value)
      rafId = 0
      return
    }

    rafId = requestAnimationFrame(tick)
  }

  function startLoop() {
    if (rafId !== 0) return
    lastFrameTime = 0
    rafId = requestAnimationFrame(tick)
  }

  function stopLoop() {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  }

  /** 立即对齐（用于拖动进度条、跳转、切歌等场景，避免缓动造成视觉滞后） */
  function snapToTarget() {
    measureIfNeeded()
    targetOffset.value = computeTarget()
    currentOffset.value = targetOffset.value
    applyOffset(currentOffset.value)
  }

  // ────────────────────────────────────────────
  // 用户滚动保护
  // ────────────────────────────────────────────

  const RESUME_DELAY_MS = 3000

  /**
   * 打轴模式下**关闭**"3 秒后自动跳回当前行"。
   *
   * 【为什么要关】
   * 打轴时用户经常用 ↑/↓/滚轮往上翻看上一句歌词确认内容。
   * 而自动跟随会在 3 秒后把画面拽回"当前播放行" ——
   * 打轴过程中播放头的位置与编辑行是两套时间轴，
   * 那一跳会让用户突然失去位置感，甚至以为自己打错了行。
   *
   * 关掉之后：翻看是稳定的，「回到当前行」按钮仍然可用（用户主动点才跳）。
   * 需求已确认这样处理。
   */
  let autoResumeDisabled = false

  /** 设置是否禁用"3 秒自动跳回"（打轴模式会置 true） */
  function setAutoResumeDisabled(v) {
    autoResumeDisabled = !!v
  }

  /** 标记用户开始/继续手动滚动 */
  function markUserScroll() {
    lastUserAction = performance.now()
    if (!userScrolling.value) userScrolling.value = true

    if (resumeTimer) clearTimeout(resumeTimer)

    // followUser 为 manual 时永不自动恢复，只能手动点"回到当前行"
    if (settings.settings.motion.followUser === 'manual') return
    // 打轴模式同样永不自动恢复（见 setAutoResumeDisabled 的注释）
    if (autoResumeDisabled) return

    resumeTimer = setTimeout(() => {
      userScrolling.value = false
      resumeTimer = 0
      startLoop()
    }, RESUME_DELAY_MS)
  }

  /** 立即恢复跟随并回到当前行 */
  function resumeFollow({ snap = true } = {}) {
    if (resumeTimer) {
      clearTimeout(resumeTimer)
      resumeTimer = 0
    }
    userScrolling.value = false
    if (snap) snapToTarget()
    else startLoop()
  }

  /**
   * 用户手动滚动：在当前位置基础上增减位移。
   * 注意这里不读 DOM（避免强制布局），只改我们自己的 currentOffset。
   * @param {number} deltaPx 正值表示内容向上（看后面的歌词）
   */
  function scrollBy(deltaPx) {
    const next = clampOffset(currentOffset.value + deltaPx)
    if (next === currentOffset.value) return
    currentOffset.value = next
    targetOffset.value = next
    applyOffset(next)
    markUserScroll()
  }

  /** 直接滚到某个位移 */
  function scrollTo(offsetPx) {
    const next = clampOffset(offsetPx)
    currentOffset.value = next
    targetOffset.value = next
    applyOffset(next)
    markUserScroll()
  }

  /**
   * **程序滚动**到指定行，并让它居中。
   *
   * 【与 scrollTo / scrollBy 的区别：不调用 markUserScroll】
   * 那两个是"用户在看"，会置 userScrolling 并启动 3 秒自动跳回计时。
   * 打轴时空格跳行是**程序行为**，如果也算作用户翻看，
   * 就会出现"每打一行就启动一次 3 秒倒计时"，
   * 打完之后画面又被拽回播放头 —— 正好是打轴最需要避免的抖动。
   *
   * @param {number} index 行索引
   */
  function scrollToIndexProgrammatically(index) {
    const metric = rowMetrics.value[index]
    if (!metric) return
    const h = containerHeight.value
    if (!(h > 0)) return
    const anchor = settings.settings.motion.scrollMode === 'golden' ? 0.38 : 0.5
    const next = clampOffset(metric.top + metric.height / 2 - h * anchor)
    currentOffset.value = next
    targetOffset.value = next
    applyOffset(next)
    // 不动 userScrolling —— 这是程序行为，不是用户在翻看
  }

  // ────────────────────────────────────────────
  // 响应变化
  // ────────────────────────────────────────────

  function measureIfNeeded() {
    if (!measured.value) measure()
  }

  /** 设置里会影响排版的字段 */
  const layoutKey = computed(() => {
    const s = settings.settings
    return [
      s.font.size,
      s.font.lineHeight,
      s.font.letterSpacing,
      s.font.family,
      s.font.weight,
      s.font.scale,
      s.layout.padTop,
      s.layout.padBottom,
      s.layout.maxWidth,
      s.layout.align,
    ].join('|')
  })

  // 排版变化 → 重新测量（必须重新测量，行高变了缓存的几何就失效了）
  watch(layoutKey, async () => {
    measured.value = false
    // 等 DOM 应用新的 CSS 变量后再量
    await new Promise((r) => requestAnimationFrame(r))
    measure()
    if (!userScrolling.value) {
      // 字号/行距变化后当前行可能不再居中，重新对齐
      currentOffset.value = computeTarget()
      applyOffset(currentOffset.value)
    } else {
      // 用户正在自行浏览时只保证位移仍合法，不强行拉回
      currentOffset.value = clampOffset(currentOffset.value)
      applyOffset(currentOffset.value)
    }
  })

  // 歌词变化 → 重新测量
  watch(
    () => lyrics.count,
    async () => {
      measured.value = false
      await new Promise((r) => requestAnimationFrame(r))
      measure()
      currentOffset.value = 0
      targetOffset.value = computeTarget()
      currentOffset.value = targetOffset.value
      applyOffset(currentOffset.value)
    },
  )

  // 容器尺寸变化（窗口缩放、抽屉开关避让）→ 重新测量
  let resizeObserver = null
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      measure()
      if (!userScrolling.value) {
        currentOffset.value = computeTarget()
        applyOffset(currentOffset.value)
      }
    })
  }

  function observe() {
    const el = containerRef.value
    if (resizeObserver && el) resizeObserver.observe(el)
  }

  function unobserve() {
    resizeObserver?.disconnect()
  }

  // 播放状态变化 → 启停循环
  watch(
    () => player.playing,
    (playing) => {
      if (playing) startLoop()
      else {
        // 暂停后仍让缓动跑完，到位后 tick 会自行停止
        startLoop()
      }
    },
  )

  // 拖动进度条/跳转 → 立即对齐，避免缓动追不上造成视觉滞后
  //
  // 【为什么要区分播放/暂停】
  // 播放时 rAF 循环在跑，tick() 每帧都会平滑跟随，
  // 所以即使这里不 snap，慢速拖动也能追上 —— 只是慢半拍。
  // **暂停时 rAF 循环是停的**，滚动完全依赖这里的 snap；
  // 若用"跳变 >1 秒"作阈值，慢速拖动每步 <1 秒就永远达不到，
  // 歌词就会呆在原地（真机实测：30 步只跟随 8 次）。
  //
  // 因此规则是：
  //   - 暂停中：任何 currentTime 变化都立即对齐（此时没有平滑跟随可用）
  //   - 播放中：只有跳变 >1 秒才对齐（正常推进交给 rAF 平滑跟随，
  //     避免每次 seek 都瞬间跳位造成视觉突兀）
  let lastTime = currentTime.value
  watch(currentTime, (t) => {
    const jump = Math.abs(t - lastTime)
    lastTime = t

    if (!player.playing) {
      // 暂停中：rAF 已停，这里是指滚动的唯一通路
      if (!userScrolling.value) snapToTarget()
      return
    }

    // 播放中：只有明显跳变（seek）才立即对齐
    if (jump > 1) {
      if (!userScrolling.value) snapToTarget()
    }
  })

  onBeforeUnmount(() => {
    stopLoop()
    unobserve()
    if (resumeTimer) clearTimeout(resumeTimer)
  })

  return {
    activeIndex,
    centerIndex,
    activeOffscreen,
    currentOffset,
    targetOffset,
    containerHeight,
    contentHeight,
    rowMetrics,
    userScrolling,
    measure,
    measureIfNeeded,
    observe,
    unobserve,
    startLoop,
    stopLoop,
    snapToTarget,
    scrollBy,
    scrollTo,
    scrollToIndexProgrammatically,
    setAutoResumeDisabled,
    resumeFollow,
    markUserScroll,
    getBounds,
    /** 供验收脚本使用 */
    diagnostics: {
      get frameCount() {
        return frameCount
      },
      get rafActive() {
        return rafId !== 0
      },
      get measured() {
        return measured.value
      },
      get rowCount() {
        return rowMetrics.value.length
      },
      get userScrolling() {
        return userScrolling.value
      },
      /** 虚化中心行（诊断用：确认滚动时是否切换到视口中心） */
      get centerIndex() {
        return centerIndex.value
      },
      get activeIndex() {
        return activeIndex.value
      },
      RESUME_DELAY_MS,
    },
  }
}
