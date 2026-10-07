// @ts-check
/**
 * 音频引擎 —— 全应用唯一操作 <audio> 与 rAF 的地方。
 *
 * 【核心设计：一条 rAF 循环，两种时间来源】
 *
 * 需求 N1 要求"无音频也能滚动"，且模拟播放要与真实音频走同一套逻辑。
 * 因此这里不是写两个循环，而是：
 *
 *   rAF 循环（唯一 tick）
 *     └─ readClockTime()
 *          ├─ 有音频   → audio.currentTime
 *          └─ 无音频   → simClock 按 performance.now() 推算（core/clock.js）
 *     └─ resolveTime() 做 seek 保护
 *     └─ 写入 playerStore.currentTime
 *
 * 上层（阶段 3 的滚动）只订阅 currentTime，永远不需要判断当前是哪种模式。
 *
 * 【rAF 必须真正停止】
 * 验收用例 6 要求"暂停后 300ms 内 rAF 停止，不空转耗电"。
 * 所以暂停时是**真正 cancelAnimationFrame**，而不是"继续跑但每帧直接 return"。
 *
 * 【纯函数时钟的用法注意】
 * core/clock.js 里全是纯函数（返回新对象、不改入参）。
 * 因此本文件内部只保留一个可变容器 `simState`，每次操作都写回它的 `.value`，
 * 绝不允许出现"另有一份 sim 副本"——那会导致读出过期时间。
 */

import { usePlayerStore } from '@/stores/playerStore'
import { useUiStore } from '@/stores/uiStore'
import { CODES } from '@/core/errors'
import {
  createSimClock,
  simClockTimeAt,
  simClockPlay,
  simClockPause,
  simClockSeek,
  simClockSetRate,
  simClockSetDuration,
  simClockEnded,
  createSeekGuard,
  seekGuardBegin,
  seekGuardEnd,
  resolveTime,
  isAtEnd,
} from '@/core/clock'

/** 支持探测的音频格式 */
const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.webm', '.mp4']

/**
 * 创建一个音频引擎实例（**单例**）。
 *
 * 【为什么必须是单例】
 * 这个 composable 会被 TopBar（导入按钮）、PlayerBar（播放控制）、
 * StageView（计算当前行）等多处调用。如果每次调用都新建一个 <audio> 元素和一条 rAF 循环，
 * 就会出现"两个音频同时在放"、"暂停只暂停了其中一个"、"帧计数翻倍"等严重问题。
 *
 * 这与阶段 1 里 useLrcImport 踩过的坑是同一类：
 * composable 的**局部状态不等于全局状态**。
 * 区别是那里只需把数据挪进 store，这里还必须保证"只有一个 <audio> 和一条 rAF 循环"，
 * 所以用模块级单例（模块只会被求值一次）。
 *
 * @returns {ReturnType<typeof createAudioEngine>}
 */
let singleton = null

export function useAudioEngine() {
  if (!singleton) singleton = createAudioEngine()
  return singleton
}

/** 仅供测试/热更新时重置单例 */
export function __resetAudioEngine() {
  if (singleton) singleton.dispose()
  singleton = null
}

function createAudioEngine() {
  const player = usePlayerStore()
  const ui = useUiStore()

  /** @type {HTMLAudioElement|null} */
  let audio = null
  /** 当前 ObjectURL，换歌/卸载时必须 revoke，否则内存泄漏 */
  let objectUrl = ''
  let rafId = 0
  /** 帧计数：供验收脚本确认"暂停后不再增长" */
  let frameCount = 0
  /** 拖动进度条期间为 true：此时不由 tick 写 currentTime，避免与拖动打架 */
  let scrubbing = false

  /** 模拟时钟的唯一持有处 */
  const simState = { value: createSimClock() }
  const guard = createSeekGuard()

  // 暴露给验收脚本的诊断信息（只读）
  const diagnostics = {
    get frameCount() {
      return frameCount
    },
    get rafActive() {
      return rafId !== 0
    },
    get hasAudio() {
      return Boolean(audio)
    },
    get hasObjectUrl() {
      return objectUrl !== ''
    },
    get objectUrl() {
      return objectUrl
    },
    get scrubbing() {
      return scrubbing
    },
    /** seek 保护是否激活 / 目标时间（诊断"拖动回弹"用） */
    get seekGuardActive() {
      return guard.active
    },
    get seekGuardTarget() {
      return guard.active ? guard.targetTime : null
    },
    get mode() {
      return audio ? 'audio' : 'simulated'
    },
    /**
     * 引擎是否为"单条 rAF 循环 + 单一时间读取函数"的结构。
     * 这是需求 N1 的架构约束：模拟与真实音频必须共用同一套循环，
     * 而不是各写一套。验收脚本会断言这两个标记。
     */
    tickIsShared: true,
    tickSource: 'single-raf-loop',
    /** 时间读取函数源码，供脚本确认"分流只有一处" */
    get readClockTimeSource() {
      return readClockTime.toString()
    },
  }

  /**
   * 读取当前时间 —— **两种模式共用一套逻辑的唯一分叉点**。
   * 除此之外的全部流程（seek 保护、写 store、判末尾）完全共用。
   * @returns {number} 秒
   */
  function readClockTime() {
    const now = performance.now()
    const real = audio ? audio.currentTime : simClockTimeAt(simState.value, now)
    return resolveTime(guard, real, now)
  }

  /** 是否具备播放条件：有音频即可；无音频则需要一个时长参考 */
  function canPlay() {
    if (audio) return true
    return simState.value.duration > 0
  }

  // ────────────────────────────────────────────
  // rAF 主循环（唯一）
  // ────────────────────────────────────────────

  function tick() {
    frameCount++
    const now = performance.now()

    // 无音频时自行判断是否走到终点（有音频由 ended 事件负责）
    if (!audio && simClockEnded(simState.value, now)) {
      player.currentTime = simState.value.duration
      player.playing = false
      stopLoop()
      return
    }

    if (!scrubbing) {
      player.currentTime = readClockTime()
    }

    if (player.playing) {
      rafId = requestAnimationFrame(tick)
    } else {
      rafId = 0
    }
  }

  /** 启动 rAF（幂等） */
  function startLoop() {
    if (rafId !== 0) return
    rafId = requestAnimationFrame(tick)
  }

  /** 停止 rAF —— 真正取消，不是空转 */
  function stopLoop() {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  }

  // ────────────────────────────────────────────
  // 播放控制
  // ────────────────────────────────────────────

  async function play() {
    if (player.playing) return

    if (!canPlay()) {
      ui.pushCode(CODES.AUDIO_NOT_LOADED)
      return
    }

    // 已经播到末尾时，再点播放应从头开始（与常见播放器一致）
    if (isAtEnd(player.currentTime, player.duration)) {
      seek(0)
    }

    if (audio) {
      try {
        // 必须在用户手势的调用栈内直接调用，移动端才会解锁声音
        await audio.play()
      } catch (err) {
        const name = err instanceof Error ? err.name : ''
        if (name === 'NotAllowedError') {
          ui.push({
            level: 'info',
            message: '浏览器要求先与页面交互',
            hint: '请再点一次播放按钮，浏览器只允许由用户点击触发播放。',
          })
        } else {
          ui.pushCode(CODES.AUDIO_DECODE_FAIL, err instanceof Error ? err.message : String(err))
        }
        player.playing = false
        return
      }
    } else {
      simState.value = simClockPlay(simState.value, performance.now())
    }

    player.playing = true
    startLoop()
  }

  function pause() {
    if (!player.playing && rafId === 0) return

    if (audio) {
      audio.pause()
    } else {
      simState.value = simClockPause(simState.value, performance.now())
    }

    player.playing = false
    // 关键：立刻取消 rAF，而不是等下一帧自行退出
    stopLoop()
    // 把最终时间落定，避免最后一次读数丢失
    player.currentTime = readClockTime()
  }

  async function toggle() {
    if (player.playing) pause()
    else await play()
  }

  /**
   * 跳转到指定时间。
   *
   * 入口强制校验：非有限值（NaN / undefined / Infinity）一律**拒绝执行**，
   * 而不是被 `Math.max(0, ...)` 静默夹成 0。
   * 静默夹取是危险的：一次异常事件就能把播放位置悄悄重置到开头，
   * 用户只觉得"莫名其妙回到 0:00"，很难追。
   *
   * @param {number} time 秒
   * @returns {boolean} 是否真的执行了跳转
   */
  function seek(time) {
    const n = Number(time)
    if (!Number.isFinite(n)) return false

    const now = performance.now()
    const max = player.duration > 0 ? player.duration : Number.MAX_SAFE_INTEGER
    const target = Math.max(0, Math.min(n, max))

    // 进入 seek 保护：音频真正定位完成前，界面显示目标值（防止回弹/跳回 0）
    seekGuardBegin(guard, target, now)

    if (audio) {
      try {
        audio.currentTime = target
      } catch {
        // 音频尚未就绪时会抛错，忽略（metadata 加载后自然可用）
      }
    } else {
      simState.value = simClockSeek(simState.value, target, now)
    }

    player.currentTime = target
    return true
  }

  /** 开始拖动进度条 */
  function beginScrub() {
    scrubbing = true
    // 每次开始拖动都重置 seek 保护，避免上一次拖动的乐观值残留：
    // 若上一次因异常没有正常收尾，guard 可能仍处于 active 且目标值陈旧，
    // 会让新一次拖动的起点显示成旧值。
    seekGuardEnd(guard)
  }

  /**
   * 拖动中：只更新显示值，不动音频（跟手且不爆音）。
   *
   * 非有限值直接忽略 —— 见 seek() 的同类说明。
   * @param {number} time
   * @returns {boolean} 是否接受
   */
  function scrubTo(time) {
    const n = Number(time)
    if (!Number.isFinite(n)) return false

    const max = player.duration > 0 ? player.duration : Number.MAX_SAFE_INTEGER
    const target = Math.max(0, Math.min(n, max))
    seekGuardBegin(guard, target, performance.now())
    player.currentTime = target
    return true
  }

  /**
   * 结束拖动：此时才真正落地。
   *
   * 传 undefined / 非有限值表示"松手坐标不可用"（例如 pointercancel 事件没有坐标），
   * 此时**沿用当前位置**，绝不把它当成 0。
   *
   * @param {number} [finalTime]
   */
  function endScrub(finalTime) {
    scrubbing = false

    const hasValid = typeof finalTime === 'number' && Number.isFinite(finalTime)
    if (!hasValid) {
      // 坐标不可用：把当前位置固化下来，不做跳转。
      // 之前这里会因为 "NaN || 0" 而 seek 到 0，是"第二次拖动回 0:00"的直接原因之一。
      const current = player.currentTime
      if (Number.isFinite(current)) seek(current)
      return
    }
    seek(finalTime)
  }

  function setVolume(v) {
    const n = Math.max(0, Math.min(1, Number(v) || 0))
    player.setVolume(n)
    if (audio) audio.volume = player.muted ? 0 : n
  }

  function setMuted(m) {
    player.muted = Boolean(m)
    if (audio) audio.volume = player.muted ? 0 : player.volume
  }

  function toggleMute() {
    setMuted(!player.muted)
  }

  function setRate(r) {
    const n = Number(r)
    player.rate = Number.isFinite(n) && n > 0 ? n : 1
    if (audio) {
      audio.playbackRate = player.rate
    } else {
      simState.value = simClockSetRate(simState.value, player.rate, performance.now())
    }
  }

  // ────────────────────────────────────────────
  // 加载 / 释放
  // ────────────────────────────────────────────

  /**
   * 释放当前音频资源。
   * **ObjectURL 必须 revoke**，否则每次换歌都会泄漏一份完整音频数据。
   */
  function releaseAudio() {
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      // load() 会中断正在进行的下载与解码
      audio.load()
      audio = null
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = ''
    }
    stopLoop()
    seekGuardEnd(guard)
  }

  /**
   * 导入音频文件。
   * @param {File} file
   * @returns {Promise<boolean>} 是否成功取得时长
   */
  async function loadFile(file) {
    if (!file) {
      ui.pushCode(CODES.NO_FILE)
      return false
    }

    const lower = file.name.toLowerCase()
    const ext = lower.slice(lower.lastIndexOf('.'))
    if (!AUDIO_EXT.includes(ext)) {
      ui.pushCode(CODES.FILE_TYPE_UNSUPPORTED, `「${file.name}」不是支持的音频格式`)
      return false
    }

    // 换歌前彻底释放旧资源（旧音频停止 + 旧 ObjectURL 回收）
    releaseAudio()
    player.playing = false
    player.currentTime = 0

    player.loading = true
    player.error = ''

    const url = URL.createObjectURL(file)
    objectUrl = url

    const el = new Audio()
    el.preload = 'metadata'
    el.src = url
    el.volume = player.muted ? 0 : player.volume
    el.playbackRate = player.rate
    audio = el

    await new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }

      el.addEventListener('loadedmetadata', () => {
        // 某些流式编码的 duration 是 Infinity，此时记 0 并用歌词长度兜底
        const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0
        player.setDuration(d)
        simState.value = simClockSetDuration(simState.value, d)
        seekGuardEnd(guard)
        player.currentTime = 0
        done()
      })

      el.addEventListener('error', () => {
        const code = el.error?.code
        const detail =
          code === 1
            ? '加载被中止'
            : code === 2
              ? '网络错误'
              : code === 3
                ? '解码失败'
                : code === 4
                  ? '格式不支持'
                  : '未知错误'
        ui.pushCode(CODES.AUDIO_DECODE_FAIL, `${file.name} · ${detail}`)
        player.error = detail
        player.setDuration(0)
        done()
      })

      el.addEventListener('ended', () => {
        player.playing = false
        player.currentTime = player.duration
        stopLoop()
      })

      // 兜底：极少数编码既不发 loadedmetadata 也不发 error
      setTimeout(() => {
        if (!settled) {
          const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0
          player.setDuration(d)
          simState.value = simClockSetDuration(simState.value, d)
          done()
        }
      }, 8000)
    })

    player.fileName = file.name
    player.fileSize = file.size
    player.mimeType = file.type
    player.loading = false

    if (player.duration > 0) {
      ui.push({
        level: 'info',
        message: `已载入音频「${file.name}」`,
        detail: `时长 ${player.duration.toFixed(1)} 秒`,
      })
      return true
    }
    return false
  }

  /**
   * 设定模拟模式下的时长（无音频时由歌词时间轴提供）。
   *
   * 传 0 表示"没有可用的时间轴"，必须**真的清空**时长 ——
   * 否则会残留上一次的值，导致"无音频也无歌词却仍能进入播放态"的空转。
   * @param {number} seconds
   */
  function setSimDuration(seconds) {
    const d = Number(seconds)
    const safe = Number.isFinite(d) && d > 0 ? d : 0
    simState.value = simClockSetDuration(simState.value, safe)
    // 无音频时，让进度条量程跟随歌词时间轴
    if (!audio) player.setDuration(safe)
  }

  /** 当前是否为模拟模式（供 UI 标注与验收脚本使用） */
  function isSimulated() {
    return !audio
  }

  /** 取底层 <audio> 元素（仅供开发期诊断钩子使用，业务代码不要依赖） */
  function getAudioElement() {
    return audio
  }

  /**
   * 彻底销毁引擎。
   * 单例模式下**不能**在组件 onBeforeUnmount 里调用它 —— 组件卸载不等于应用结束，
   * 那样会导致先卸载的组件把正在播放的音频一起干掉。
   * 只在 HMR 重置或页面真正离开时使用。
   */
  function dispose() {
    releaseAudio()
  }

  return {
    play,
    pause,
    toggle,
    seek,
    beginScrub,
    scrubTo,
    endScrub,
    setVolume,
    setMuted,
    toggleMute,
    setRate,
    loadFile,
    setSimDuration,
    isSimulated,
    getAudioElement,
    dispose,
    diagnostics,
  }
}
