// @ts-check
/**
 * 时钟模型 —— 纯函数层，禁止 import vue。
 *
 * 【为什么需要这个文件】
 * 需求 N1：没有音频时歌词也要能按时间轴滚动。
 * 最省事的做法是"再写一套定时器"，但那会导致阶段 3 的滚动逻辑被迫写两套分支：
 *   if (有音频) 读 audio.currentTime; else 读模拟时间
 * 一旦分成两套，两边行为就会逐渐走偏（回弹、跳帧、暂停不停等 bug 只修一边）。
 *
 * 因此这里把"时间从哪来"抽象成一个纯计算：
 * 有音频 → 读 audio.currentTime
 * 无音频 → 用下面的模拟时钟按 performance.now() 推算
 * 两者的**上游是同一个 rAF 循环**，上层只拿到一个 currentTime，完全不知道当前是哪种模式。
 *
 * 本文件之所以能用 Node 单测，是因为所有函数都是纯的：只依赖传入的 now 与 state。
 */

import { clamp } from './timeUtils.js'

/**
 * @typedef {Object} SimClockState
 * @property {boolean} playing  是否在走
 * @property {number} baseTime  上次 播放/暂停/跳转 时刻的基准秒数
 * @property {number} startedAt 上次 播放/暂停/跳转 时的 performance.now()（毫秒）
 * @property {number} rate      播放速率（1 = 原速）
 * @property {number} duration  总时长（秒）；未知时传 0，表示不设上限
 */

/**
 * 创建一个模拟时钟状态。
 * @param {{duration?:number, rate?:number, baseTime?:number}} [options]
 * @returns {SimClockState}
 */
export function createSimClock(options = {}) {
  return {
    playing: false,
    baseTime: options.baseTime ?? 0,
    startedAt: 0,
    rate: options.rate ?? 1,
    duration: options.duration ?? 0,
  }
}

/**
 * 计算某一时刻的模拟时间。
 *
 * 关键点：只依据 (now - startedAt) 差值推算，**不做累加**。
 * 累加（每帧 time += delta）会因帧间隔抖动而漂移，十几分钟后与真实时间明显不符；
 * 差值法任何时刻都能算出精确值，且暂停/跳转只是重置基准点。
 *
 * @param {SimClockState} state
 * @param {number} now performance.now() 毫秒
 * @returns {number} 秒
 */
export function simClockTimeAt(state, now) {
  if (!state.playing) return clamp(state.baseTime, 0, state.duration > 0 ? state.duration : Number.MAX_SAFE_INTEGER)

  const elapsed = ((now - state.startedAt) / 1000) * state.rate
  let t = state.baseTime + elapsed
  if (state.duration > 0) t = Math.min(t, state.duration)
  return Math.max(0, t)
}

/**
 * 让模拟时钟开始走动。
 * @param {SimClockState} state
 * @param {number} now
 * @returns {SimClockState} 新状态（不修改入参，便于测试与回滚）
 */
export function simClockPlay(state, now) {
  if (state.playing) return state
  return {
    ...state,
    playing: true,
    // 从当前时间接着走，而不是从 0 开始
    baseTime: simClockTimeAt(state, now),
    startedAt: now,
  }
}

/**
 * 暂停模拟时钟。
 * @param {SimClockState} state
 * @param {number} now
 * @returns {SimClockState}
 */
export function simClockPause(state, now) {
  if (!state.playing) return state
  return {
    ...state,
    playing: false,
    // 把当前时间固化为新基准
    baseTime: simClockTimeAt(state, now),
    startedAt: now,
  }
}

/**
 * 跳转到指定时间。
 * @param {SimClockState} state
 * @param {number} time 秒
 * @param {number} now
 * @returns {SimClockState}
 */
export function simClockSeek(state, time, now) {
  const max = state.duration > 0 ? state.duration : Number.MAX_SAFE_INTEGER
  return {
    ...state,
    baseTime: clamp(time, 0, max),
    startedAt: now,
  }
}

/**
 * 更新速率。为保持时间连续，需要先把当前时间固化再换速率。
 * @param {SimClockState} state
 * @param {number} rate
 * @param {number} now
 * @returns {SimClockState}
 */
export function simClockSetRate(state, rate, now) {
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1
  const current = simClockTimeAt(state, now)
  return { ...state, rate: safeRate, baseTime: current, startedAt: now }
}

/**
 * 更新时长（例如用户换了一首歌，或音频 metadata 后才拿到真实时长）。
 * @param {SimClockState} state
 * @param {number} duration
 * @returns {SimClockState}
 */
export function simClockSetDuration(state, duration) {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0
  return { ...state, duration: d, baseTime: d > 0 ? Math.min(state.baseTime, d) : state.baseTime }
}

/**
 * 模拟时钟是否已走到终点。
 * 用于播放到底时自动暂停（与真实音频的 ended 事件行为保持一致）。
 * @param {SimClockState} state
 * @param {number} now
 * @returns {boolean}
 */
export function simClockEnded(state, now) {
  if (!state.playing || state.duration <= 0) return false
  return simClockTimeAt(state, now) >= state.duration
}

// ────────────────────────────────────────────────────────────
// seek 期间的"乐观时间"处理
// ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SeekGuard
 * @property {boolean} active    是否正在跳转/拖动
 * @property {number} targetTime 期望落地的时间
 * @property {number} startedAt  进入该状态的时间戳
 */

/**
 * 创建一个 seek 保护器。
 *
 * 【为什么必须有这个东西】
 * 设置 audio.currentTime 之后，浏览器不会立刻生效（要等解码器定位），
 * 在这段窗口内读 audio.currentTime 往往还是**旧值**。
 * 如果此时用旧值去刷新界面，进度条就会"回弹"或"跳回 0"——
 * 这正是验收用例 2 要防的 bug。
 *
 * 解决办法：拖动/跳转期间用一个乐观的 targetTime 顶替真实读数，
 * 直到确认已到位（或超时兜底）才恢复读取真实值。
 *
 * @param {number} [timeoutMs=1200] 超时兜底，避免某些浏览器不发 seeked 事件时永久卡住
 * @returns {SeekGuard & {timeoutMs:number}}
 */
export function createSeekGuard(timeoutMs = 1200) {
  return { active: false, targetTime: 0, startedAt: 0, timeoutMs }
}

/**
 * 进入 seek 状态。
 * @param {SeekGuard} guard
 * @param {number} targetTime
 * @param {number} now
 */
export function seekGuardBegin(guard, targetTime, now) {
  guard.active = true
  guard.targetTime = targetTime
  guard.startedAt = now
}

/**
 * 结束 seek 状态。
 * @param {SeekGuard} guard
 */
export function seekGuardEnd(guard) {
  guard.active = false
}

/**
 * 根据 seek 状态决定"当前应该显示什么时间"。
 *
 * @param {SeekGuard} guard
 * @param {number} realTime 从音频/模拟时钟读到的真实时间
 * @param {number} now
 * @returns {number} 应当使用的时间
 */
export function resolveTime(guard, realTime, now) {
  if (!guard.active) return realTime

  // 超时兜底：某些情况下 seeked 事件不会触发，不能让界面永远停在乐观值
  if (now - guard.startedAt > guard.timeoutMs) {
    seekGuardEnd(guard)
    return realTime
  }

  // 已经足够接近目标 → 认定为到位，交回真实值
  if (Math.abs(realTime - guard.targetTime) < 0.25) {
    seekGuardEnd(guard)
    return realTime
  }

  return guard.targetTime
}

/**
 * 判断是否已走到末尾（带一点容差，避免浮点误差导致永远差一点点）。
 * @param {number} time
 * @param {number} duration
 * @param {number} [epsilon=0.05]
 */
export function isAtEnd(time, duration, epsilon = 0.05) {
  if (!(duration > 0)) return false
  return time >= duration - epsilon
}
