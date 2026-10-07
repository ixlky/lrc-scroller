// @ts-check
/**
 * 打轴模式的状态机（阶段 5 第 3 步）。
 *
 * 【职责划分】
 * - `tappingStore`：纯数据（谁被打了、编辑行在哪、撤销栈）
 * - 本文件：把"用户按了某个键"翻译成"改 store + 动播放头 + 滚视野"
 *
 * 【为什么需要单独一层】
 * 三个动作要一起发生，缺一不可：
 *   1. store 记时间、推进编辑行
 *   2. 播放头回滚（撤销时）
 *   3. 视野滚到编辑行（**程序滚动**，不能算作用户在翻看）
 * 把它们塞进 store 会让 store 依赖 engine/auto，打破"store 只管数据"的分层。
 */
import { watch } from 'vue'
import { useTappingStore, ROLLBACK_SEC } from '@/stores/tappingStore'
import { useLyricsStore } from '@/stores/lyricsStore'
import { usePlayerStore } from '@/stores/playerStore'
import { useUiStore } from '@/stores/uiStore'
import { useAudioEngine } from '@/composables/useAudioEngine'
import { useAutoScroll } from '@/composables/useAutoScroll'

/** ←/→ 一次微调的毫秒数 */
export const NUDGE_STEP_MS = 10
/** Shift + ←/→ 的毫秒数 */
export const NUDGE_STEP_BIG_MS = 100
/** 应用后可撤销的时间窗口（毫秒） */
export const APPLY_UNDO_MS = 3000

/**
 * 深拷贝一个 Vue 响应式数组。
 *
 * 【为什么不能直接 structuredClone】
 * Pinia 的 state 是 Proxy，`structuredClone(proxy)` 会抛
 * `DataCloneError: could not be cloned`（实测：点「应用到歌词」直接崩）。
 * 必须先用 toRaw 拆掉 Proxy 再克隆，或者手工逐项拷贝 ——
 * 这里用 JSON 往返，因为快照里的值全是普通可序列化数据
 * （number / string / boolean / null / 数组），没有 Date、Map、undefined 字段。
 *
 * @template T
 * @param {T} v
 * @returns {T}
 */
function snapshotClone(v) {
  return JSON.parse(JSON.stringify(v))
}

/**
 * 应用撤销的快照。
 *
 * 【为什么不放进 store】
 * 它是一张"临时票据"：只在 3 秒内有效，刷新页面后本来就该失效。
 * 放 store 会被 _save() 持久化到 sessionStorage，
 * 刷新后还留着"上一次应用"的还原点，语义就错了。
 *
 * @type {any}
 */
let applySnapshot = null
/** @type {any} */
let applyTimer = 0

/**
 * 由 StageView 注册进来的滚动控制器。
 *
 * 【为什么必须注入，不能自己 new —— 这是一个真实的坑】
 * useAutoScroll 依赖 containerRef / trackRef 才能测量行几何（rowMetrics）。
 * 组件里创建的那个实例带着 refs；在这里 new 一个的话 refs 全是 null，
 * rowMetrics 永远是空数组，于是 scrollToIndexProgrammatically 里
 * `rowMetrics.value[index]` 取到 undefined，**静默什么都不做**。
 * 程序滚动失效却不报错，正是最难查的那一类问题。
 *
 * @type {any}
 */
let injectedAuto = null

/** 由 StageView 在 setup 里调用（它才有 containerRef/trackRef） */
export function registerTappingAuto(auto) {
  injectedAuto = auto
}

export function useTapping() {
  const tapping = useTappingStore()
  const lyrics = useLyricsStore()
  const player = usePlayerStore()
  const engine = useAudioEngine()
  const ui = useUiStore()

  /**
   * 取滚动控制器。
   *
   * 用函数而不是常量，是因为注册方（StageView）与使用方
   * （useKeyboard / PlayerBar）的 setup 顺序不保证；
   * 早创建时常量还拿不到注册的实例，函数才能在**调用时**取到最新的。
   * @returns {any}
   */
  function getAuto() {
    return injectedAuto ?? useAutoScroll()
  }

  /**
   * 把某一"目标行"滚进视野。
   *
   * 【为什么要分两种情况】
   * 目标数组可能是 lines（在 .stage__track 里，靠 transform 滚动）
   * 或 droppedLines（在 .stage__untimed 里，靠原生 overflow 滚动）。
   * 前者必须用 auto.scrollToIndexProgrammatically（它知道行几何），
   * 后者用元素的 scrollIntoView 即可 —— 它是个独立滚动容器。
   *
   * 【滚动策略：完全可见就不动，否则居中】
   * 用户明确要求不要用 `nearest`：
   *   - 已经**完全可见**时不动（避免每打一行整块跳一下）
   *   - 有任何部分被挡住就滚到 **center**（而不是"刚好露一点"），
   *     保证编辑行周围有上下文可看，打轴时不用来回瞄
   *
   * @param {number} index 目标数组里的下标
   */
  function scrollTargetIntoView(index) {
    if (tapping.tapTargetKind === 'lines') {
      getAuto().scrollToIndexProgrammatically(index)
      return
    }
    // droppedLines：找 .stage__untimed-line 里对应的那个
    if (typeof document === 'undefined') return
    const el = document.querySelectorAll('.stage__untimed-line')[index]
    if (!el) return
    const container = el.closest('.stage__untimed')
    if (!container) return

    const er = el.getBoundingClientRect()
    const cr = container.getBoundingClientRect()
    const fullyVisible = er.top >= cr.top && er.bottom <= cr.bottom
    if (fullyVisible) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  /**
   * 模式开关。开启时：
   * - 关闭"3 秒自动跳回"（否则打轴时画面会被拽回播放头）
   * - 按**目标行数组**预填 tapped（有没时间的行就打它们）
   * @param {boolean} on
   */
  /**
   * 模式开关。开启时：
   * - 关闭"3 秒自动跳回"（否则打轴时画面会被拽回播放头）
   * - 按**目标行数组**预填 tapped（有没时间的行就打它们）
   *
   * 【所有打轴 toast 都集中在这里，别处不要重复推】
   * 进入/退出、草稿重置、草稿保留这几种提示都需要读 store 的最新状态，
   * 只有这里拿得到。之前 PlayerBar 也推了一条"已进入/已退出"，
   * 结果退出时用户看到**两条**提示（实测）。
   *
   * @param {boolean} on
   */
  function setEnabled(on) {
    getAuto().setAutoResumeDisabled(on)
    if (on) {
      tapping.restore()
      const didReset = tapping.enable()
      if (didReset && tapping.totalCount > 0) {
        // 目标数组变了（换过歌词）→ 草稿被重置，必须告诉用户，
        // 否则他会以为"我上次打的东西丢了/坏了"
        ui.push({
          level: 'info',
          message: '歌词已更换，打轴草稿已重置',
          hint: `当前有 ${tapping.totalCount} 行待打轴`,
        })
      } else if (tapping.totalCount === 0) {
        // 没有任何行可打（空文件）—— 说清楚，别让用户对着空格猛按
        ui.push({
          level: 'warn',
          message: '当前没有可打轴的行',
          hint: '请先导入歌词文本（.lrc 或 .txt）',
        })
      } else {
        ui.push({
          level: 'info',
          message: '已进入打轴模式',
          hint: `空格给当前编辑行打时间点 · 共 ${tapping.totalCount} 行`,
        })
      }
    } else {
      // 关闭时**保留** editingIndex / tapped / undoStack
      // （需求：退出打轴模式后撤销栈保留）
      const n = tapping.tappedCount
      tapping.disable()
      // 打了草稿却毫无提示的话，用户会以为白打了
      if (n > 0) {
        ui.push({
          level: 'info',
          message: `已退出打轴模式 · 已打 ${n} 行草稿（已自动保存）`,
          hint: '目前只是草稿 —— 下次进来可以继续，但还不会影响歌词滚动',
        })
      } else {
        ui.push({ level: 'info', message: '已退出打轴模式' })
      }
    }
  }

  function toggle() {
    setEnabled(!tapping.enabled)
    return tapping.enabled
  }

  /**
   * 空格：给当前编辑行打时间 + 编辑行 +1 + 滚到编辑行。
   *
   * 【不打乱播放头】
   * 打完之后**不**自动 seek —— 需求没要求，而且自动跳播放头
   * 会把"多行时间相同"变成"多行时间递增"，那是替用户做决定。
   * 用户想连续打点就自己拖进度条（打轴模式允许拖）。
   *
   * @returns {{index:number, t:number, nextIndex:number, isNew:boolean}|null}
   */
  function tap() {
    if (!tapping.enabled) return null
    // 目标数组或行数变化（换歌词）时先对齐
    tapping.ensureSize()
    const t = player.currentTime
    const r = tapping.record(t)
    if (r.index < 0) return null

    // 把编辑行滚进视野（程序滚动，不算用户翻看，不会触发 3 秒倒计时）
    scrollTargetIntoView(r.nextIndex)
    return r
  }

  /**
   * Z：撤销一步 + 播放头固定回滚 5 秒。
   *
   * 需求已把 N4 的"回滚到被撤销行前 1 秒"作废，
   * 改为"固定 5 秒，基准 = 当前播放头"，多次撤销就多次减。
   *
   * @returns {{index:number, t:number|null, newTime:number}|null}
   */
  function undo() {
    if (!tapping.enabled) return null
    const r = tapping.undo()
    if (!r) return null

    // 固定回滚 5 秒，clamp 到 0
    const newTime = Math.max(0, player.currentTime - ROLLBACK_SEC)
    engine.seek(newTime)

    // 视野回到被撤销的那一行
    scrollTargetIntoView(r.index)
    return { ...r, newTime }
  }

  /**
   * ←/→：微调**刚打完那行**（lastTappedIndex）的时间。
   * 微调过的行标 locked，之后的吸附不得覆盖。
   *
   * @param {number} deltaMs 毫秒（负=提前）
   * @returns {{index:number, t:number}|null}
   */
  function nudge(deltaMs) {
    if (!tapping.enabled) return null
    return tapping.nudge(deltaMs)
  }

  /**
   * 把打轴结果应用到歌词。
   *
   * 【与 Z 键撤销是两套东西，不要混】
   *   Z 键撤销：改 tapped（单个打轴点），不碰 lines
   *   应用撤销：还原 lines + droppedLines + tapped（整次应用）
   * 应用后草稿被清空，所以 Z 键自然无反应 —— 靠数据成立，
   * 不需要给 Z 键加"应用后禁用"的分支。
   *
   * @returns {{applied:number, remaining:number}|null}
   */
  function apply() {
    if (!tapping.enabled) return null
    const n = tapping.tappedCount
    if (n === 0) {
      ui.push({ level: 'warn', message: '还没有打任何时间点', hint: '按空格给当前编辑行打时间' })
      return null
    }

    // 快照必须深拷贝：lines 的元素含 duplicateOf 数组，浅拷贝还原不回去。
    // 且必须绕开 Proxy（见 snapshotClone 的注释）
    applySnapshot = snapshotClone({
      lines: lyrics.lines,
      droppedLines: lyrics.droppedLines,
      tapped: tapping.tapped,
      tappedKind: tapping.tappedKind,
      undoStack: tapping.undoStack,
      editingIndex: tapping.editingIndex,
      lastTappedIndex: tapping.lastTappedIndex,
    })

    const r = lyrics.applyTapped(tapping.tapped)
    tapping.consumeAll()

    if (applyTimer) clearTimeout(applyTimer)
    applyTimer = setTimeout(() => {
      applySnapshot = null
      applyTimer = 0
    }, APPLY_UNDO_MS)

    ui.push({
      level: 'info',
      message: `已应用 ${r.applied} 行到歌词`,
      hint:
        r.remaining > 0
          ? `还有 ${r.remaining} 行没打时间，已保留 · ${APPLY_UNDO_MS / 1000} 秒内可按 Ctrl+Z 撤销`
          : `全部行都已打上时间 · ${APPLY_UNDO_MS / 1000} 秒内可按 Ctrl+Z 撤销`,
    })
    return r
  }

  /**
   * 撤销整次应用（仅 3 秒内有效）。
   * @returns {boolean} 是否真的撤销了
   */
  function undoApply() {
    if (!applySnapshot) return false
    lyrics.restoreSnapshot(applySnapshot)
    tapping.restoreSnapshot(applySnapshot)
    applySnapshot = null
    if (applyTimer) {
      clearTimeout(applyTimer)
      applyTimer = 0
    }
    ui.push({ level: 'info', message: '已撤销应用', hint: '歌词与打轴草稿都已还原' })
    return true
  }

  /**
   * Ctrl+Z 的统一入口：应用撤销优先，其次才是 Z 的打点撤销。
   *
   * 【为什么必须在这里分流】
   * 两者语义不同但用户只按同一个组合键：应用后草稿已空，
   * Z 的打点撤销必然无反应，此时该走应用撤销。
   * 放在 useKeyboard 里判断会让键盘层知道太多应用细节。
   *
   * @returns {'apply'|'tap'|null} 实际执行了哪一种
   */
  function undoAny() {
    if (applySnapshot && undoApply()) return 'apply'
    if (tapping.enabled && tapping.undoStack.length > 0) {
      undo()
      return 'tap'
    }
    return null
  }

  /*
   * 歌词换了（新导入）时重新对齐 tapped 数组。
   *
   * 【必须同时监听 droppedLines.length】
   * 目标数组是二选一的：纯 lrc 用 lines、纯 txt 用 droppedLines。
   * 只监听 lines.length 的话，"导入纯 txt → 导入纯 lrc"这类切换
   * （lines 从 0 变 N、dropped 从 M 变 0）有可能被漏掉。
   * 两个长度一起监听，覆盖所有会改变"目标是谁"的情况。
   */
  watch(
    () => [lyrics.lines.length, lyrics.droppedLines.length],
    () => {
      tapping.ensureSize()
    },
  )

  // 模式开关时同步"是否禁用 3 秒自动跳回"
  watch(
    () => tapping.enabled,
    (on) => getAuto().setAutoResumeDisabled(on),
  )

  return {
    tapping,
    setEnabled,
    toggle,
    tap,
    undo,
    nudge,
    apply,
    undoApply,
    undoAny,
    NUDGE_STEP_MS,
    NUDGE_STEP_BIG_MS,
    APPLY_UNDO_MS,
  }
}

/**
 * 全局单例。
 *
 * 【为什么需要单例】
 * 打轴动作有三个发起方：useKeyboard（空格/Z/←→）、PlayerBar（开关按钮）、
 * 以及未来的应用/导出动作。各自 new 一个的话，setEnabled 里的
 * "关闭 3 秒自动跳回"会各干一次，auto 引用也可能不一致。
 *
 * @type {{current: ReturnType<typeof useTapping>|null}}
 */
const singleton = { current: /** @type {any} */ (null) }

/**
 * 取得全局唯一的打轴控制器（首次调用时创建）。
 * @returns {ReturnType<typeof useTapping>}
 */
export function useTappingShared() {
  if (!singleton.current) {
    singleton.current = useTapping()
  }
  return singleton.current
}
