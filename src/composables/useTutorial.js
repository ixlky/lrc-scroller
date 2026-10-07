// @ts-check
/**
 * 教程控制器（单例）。
 *
 * 【为什么是单例】
 * 三处要共用同一份状态，各 new 一个就会出现"按钮说关着、遮罩却开着"：
 *   - App.vue      —— 挂载遮罩组件
 *   - TopBar       —— 「教程」按钮（可随时重放）
 *   - useKeyboard  —— 教程进行中要独占键盘
 * 与 useFullscreen / useTapping / useVideoExport 同一套约定。
 *
 * 【首次自动弹出】
 * 挂载后延迟一小段再弹：立刻弹会在首屏布局稳定前测量目标位置，
 * 高亮框会画偏。延迟同时也是给用户一个"页面出来了"的感知。
 */
import { ref } from 'vue'
import {
  TUTORIAL_STEPS,
  clampStepIndex,
  isLastStep,
  createTutorialFlags,
} from '@/core/tutorial'

/** 首次自动弹出的延迟（毫秒）：等首屏布局与字体稳定 */
export const AUTO_OPEN_DELAY_MS = 600

export function useTutorial() {
  /** 遮罩是否显示 */
  const active = ref(false)
  /** 当前步骤索引 */
  const index = ref(0)
  /** 用户是否曾经完成/关闭过（供 UI 决定是否弱化提示） */
  const seen = ref(false)

  const flags =
    typeof localStorage !== 'undefined' ? createTutorialFlags(localStorage) : createTutorialFlags(null)

  seen.value = flags.seen()

  /** 当前步骤对象（active 为 false 时也返回有效的第 0 步，避免模板里判空到处飞） */
  function current() {
    return TUTORIAL_STEPS[clampStepIndex(index.value)] ?? TUTORIAL_STEPS[0]
  }

  /** 开始（或从头重放） */
  function start() {
    index.value = 0
    active.value = true
  }

  /** 结束并记住"看过了" */
  function finish() {
    active.value = false
    seen.value = true
    flags.markSeen()
  }

  /** 关掉但不记（Esc/跳过也记 —— 用户已经知道有这东西了，别反复打扰） */
  function close() {
    finish()
  }

  function next() {
    if (isLastStep(index.value)) {
      finish()
      return
    }
    index.value = clampStepIndex(index.value + 1)
  }

  function prev() {
    index.value = clampStepIndex(index.value - 1)
  }

  function goTo(i) {
    index.value = clampStepIndex(i)
  }

  /** 清除"看过"标记（调试或"重新引导"用） */
  function reset() {
    flags.reset()
    seen.value = false
  }

  return {
    active,
    index,
    seen,
    total: TUTORIAL_STEPS.length,
    current,
    start,
    close,
    finish,
    next,
    prev,
    goTo,
    reset,
  }
}

/** @type {{current: ReturnType<typeof useTutorial>|null}} */
const singleton = { current: /** @type {any} */ (null) }

/**
 * 取得全局唯一的教程控制器（首次调用时创建）。
 * @returns {ReturnType<typeof useTutorial>}
 */
export function useTutorialShared() {
  if (!singleton.current) {
    singleton.current = useTutorial()
  }
  return singleton.current
}
