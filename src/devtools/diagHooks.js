// @ts-check
/**
 * 验收/调试钩子。
 *
 * 【为什么需要它】
 * 自动化验收脚本必须在页面外部读取内部状态（帧计数、ObjectURL、播放模式等），
 * 而这些状态故意没有暴露在 DOM 上（暴露了会污染生产界面）。
 *
 * 【安全考虑】
 * 只在开发模式（`import.meta.env.DEV`）挂载，生产构建里整段代码会被 tree-shake 掉，
 * 不会在用户拿到的单文件 HTML 里留下任何后门。
 */

/**
 * 登记自动滚动控制器。
 *
 * StageView 在 setup 里创建 useAutoScroll，无法从 main.js 拿到，
 * 因此由它主动调用本函数登记。
 *
 * 【为什么要有 _pendingAuto 兜底】
 * main.js 里 diagHooks 是**动态 import** 的，而 app.mount() 是同步的 ——
 * StageView 的 setup 会先执行，此时 window.__lrcDiag 还不存在，
 * 直接赋值会被静默丢弃（表现为 auto 永远是 null，很难查）。
 * 因此先把值暂存，等 installDiagHooks 真正挂载时再补上。
 */
let _pendingAuto = null
/** 阶段 4：展示模式控制器。由 useFullscreen 首次创建时登记。 */
let _pendingFull = null
/** 阶段 5 第 3 步：打轴 store。由 StageView 登记。 */
let _pendingTapping = null

export function registerAutoScroll(autoScroll) {
  if (!import.meta.env.DEV) return
  // @ts-expect-error 开发期访问
  const diag = window.__lrcDiag
  if (diag) {
    diag.auto = autoScroll
  } else {
    _pendingAuto = autoScroll
  }
}

/**
 * 登记打轴 store（阶段 5 第 3 步）。
 * 与 registerAutoScroll 同理：动态 import 可能晚于组件 setup，先暂存。
 * @param {any} tapping
 */
export function registerTapping(tapping) {
  if (!import.meta.env.DEV) return
  // @ts-expect-error 开发期访问
  const diag = window.__lrcDiag
  if (diag) diag.tapping = tapping
  else _pendingTapping = tapping
}

/**
 * 登记展示模式控制器（阶段 4）。
 *
 * 与 registerAutoScroll 同理：diagHooks 是动态 import，
 * 可能晚于 App setup 执行，所以先暂存。
 *
 * @param {any} full
 */
export function registerFullscreen(full) {
  if (!import.meta.env.DEV) return
  // @ts-expect-error 开发期访问
  const diag = window.__lrcDiag
  if (diag) {
    diag.full = full
  } else {
    _pendingFull = full
  }
}

/**
 * 在开发模式下把内部状态挂到 window.__lrcDiag。
 * @param {{engine:any, player:any, lyrics:any, settings:any, getAudioEl:()=>HTMLAudioElement|null}} deps
 */
export function installDiagHooks(deps) {
  if (!import.meta.env.DEV) return

  // @ts-expect-error 开发期挂载
  window.__lrcDiag = {
    engine: deps.engine,
    player: deps.player,
    lyrics: deps.lyrics,
    settings: deps.settings,
    /** 自动滚动控制器（阶段 3）：由 StageView 登记 */
    auto: _pendingAuto,
    /** 展示模式控制器（阶段 4）：由 useFullscreenShared 登记 */
    full: _pendingFull,
    /** 打轴 store（阶段 5 第 3 步）：由 StageView 登记 */
    tapping: _pendingTapping,

    /** 真实 <audio> 的 currentTime（模拟模式下为 null） */
    audioTime() {
      const el = deps.getAudioEl()
      return el ? el.currentTime : null
    },

    /** 当前时长，便于脚本轮询等待加载完成 */
    get playerDuration() {
      return deps.player.duration
    },

    /** localStorage 中的设置原文（验收"刷新后恢复"与"重置后清空"用） */
    storedSettings() {
      try {
        return localStorage.getItem('lrc-scroller:settings:v1')
      } catch {
        return null
      }
    },
  }

  console.info('[lrc-scroller] 调试钩子已挂载：window.__lrcDiag（仅开发模式）')
}
