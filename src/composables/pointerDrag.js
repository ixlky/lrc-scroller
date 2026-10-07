// @ts-check
/**
 * 指针拖动助手 —— 全项目唯一的"按住拖动"实现。
 *
 * 【这个文件的历史：围绕"指针捕获"栽了三次跟头】
 *
 * 1) `pointercancel` 没有有效坐标（clientX 为 0），却被当成落点 →
 *    进度条跳回 0:00。真实场景中第一次拖动常以 pointercancel 结束。
 * 2) `addEventListener` 加在 window、`removeEventListener` 却从元素移除 →
 *    监听器永久残留 → 松手后进度条仍跟着鼠标走、无法取消。
 * 3) **当前版本删除了 setPointerCapture / releasePointerCapture**：
 *    真机鼠标下"第一次拖动正常、之后再也拖不动"（笔和触摸却正常）。
 *    原因指向显式捕获引入的状态：鼠标的 pointerId 在整个会话里固定为 1，
 *    一旦某个环节留下未释放的捕获状态，后续该 pointerId 的 pointermove
 *    会被重定向到捕获元素，而我们的业务监听在 window 上，于是收不到。
 *
 * 【最新线索（尚未定论，正在按"先复现再改"的原则排查）】
 * 用户补充的关键观察：
 *   - 第一次拖动**缓慢移动、指针跟随 thumb** → 第二次拖动正常
 *   - 第一次拖动**快速移动、指针离开 thumb** → 第二次拖动卡死
 *   - 卡死状态下换数位板 → 立刻正常
 * 推断指向鼠标的**隐式指针捕获**（pointerdown 时浏览器自动对 pointerId 施加捕获）。
 * 注意：我们删掉的是**显式**捕获，隐式捕获仍由浏览器施加，且无法直接关闭。
 *
 * 【当前阶段的动作：只补日志，不改代码猜】
 * 已在诊断日志中补齐：
 *   - pointerdown / 收尾 时 el.hasPointerCapture(pointerId) 的值
 *   - pointermove 前 3 次的 rect 数值（排查"坐标算错"）、buttons、isPrimary
 *   - 独立的 gotpointercapture / lostpointercapture 事件时序记录
 *     （window.__lrcCaptureLog，installCaptureDiagnostics）
 * 等真机按"快速移动导致卡住"路径复现后，用日志判断是
 * 「事件没到」还是「坐标算错」，再决定是否需要主动释放/清空隐式捕获。
 *
 * 【为什么可以放心地不用捕获】
 *  - 监听器挂在 **window** 上：指针移到元素外、甚至移出窗口，事件照样到达。
 *    （已有实测覆盖：拖出元素外/窗口外松手，落点仍然正确。）
 *  - 数位板（pen）不带显式捕获也完全正常，反证捕获不是必需的。
 *  - 捕获会引入 gotpointercapture / lostpointercapture / 隐式捕获 一整套状态，
 *    而每个状态都是潜在的 bug 来源。**少一个状态，少一类 bug。**
 *
 * 【保留的设计要点（都是前两次 bug 换来的）】
 *  1. 监听目标统一为一个常量（window）；
 *  2. 用登记表记录 [type, handler]，收尾时按表移除，绝不手写第二份清单；
 *  3. 收尾函数幂等（pointerup 与 pointercancel 可能都到达）；
 *  4. 坐标换算非法时返回 null（"未知"），绝不静默当成 0。
 */

/**
 * 是否开启拖动诊断日志。
 *
 * 用途：万一"鼠标第二次拖不动"在真机上仍然复现，
 * 用户可直接访问 `?dragdebug=1` 复现一次，把控制台日志发来 —— 不必再靠猜。
 * 日志会记录：pointerdown（含 pointerType / pointerId）、
 * window 是否收到 pointermove、事件 target、以及收尾原因与收到的 move 次数。
 */
let diagnoseEnabled = (() => {
  try {
    return typeof location !== 'undefined' && /[?&]dragdebug=1/.test(location.search)
  } catch {
    return false
  }
})()

/** 供测试脚本开关诊断日志 */
export function setDragDiagnostics(on) {
  diagnoseEnabled = Boolean(on)
}

/**
 * 是否已安装捕获事件监听（gotpointercapture / lostpointercapture）。
 * 只装一次，挂在 window 上，把事件时序写进 window.__lrcCaptureLog。
 */
let captureListenersInstalled = false

/**
 * 安装捕获事件的记录器。
 *
 * 【用途】排查真机鼠标"第二次拖不动"时，用户明确要求看
 * gotpointercapture / lostpointercapture 的事件时序 —— 这能直接看出
 * 捕获是否残留、或被谁抢走。
 *
 * 只在开启诊断时才真正记录，避免常驻开销。
 */
export function installCaptureDiagnostics() {
  if (captureListenersInstalled || typeof window === 'undefined') return
  captureListenersInstalled = true

  /** @type {Array<any>} */
  const log = []
  try {
    window.__lrcCaptureLog = log
  } catch {
    /* 忽略 */
  }

  const rec = (type) => (e) => {
    if (!diagnoseEnabled) return
    log.push({
      seq: log.length,
      type,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      target: describeTarget(e.target),
      t: Math.round(performance.now()),
    })
    diag('capture', type, { pointerId: e.pointerId, pointerType: e.pointerType, target: describeTarget(e.target) })
  }

  window.addEventListener('gotpointercapture', rec('gotpointercapture'), true)
  window.addEventListener('lostpointercapture', rec('lostpointercapture'), true)
}

/**
 * 输出诊断日志。
 * @param {string} label @param {string} event @param {Record<string, any>} [data]
 */
function diag(label, event, data) {
  if (!diagnoseEnabled) return
  console.debug(`[drag:${label}] ${event}`, data ?? '')
}

/**
 * 把事件目标描述成简短字符串（诊断日志用）。
 * @param {any} t @returns {string}
 */
function describeTarget(t) {
  if (!t) return 'null'
  if (typeof t.getAttribute === 'function') {
    const aria = t.getAttribute('aria-label')
    if (aria) return `${t.tagName}[${aria}]`
  }
  const cls = typeof t.className === 'string' ? t.className : ''
  if (cls) return `${t.tagName}.${cls.split(/\s+/).slice(0, 2).join('.')}`
  return t.tagName ?? String(t)
}

/**
 * @typedef {Object} PointerDragOptions
 * @property {HTMLElement} el 用于几何测量（getBoundingClientRect）
 * @property {(ratio:number, ev:PointerEvent)=>void} onMove 拖动中的回调，ratio 为 0~1
 * @property {(ratio:number|undefined, ev:PointerEvent)=>void} [onEnd]
 *   正常松手时回调落点；坐标为 undefined 表示"不可用"（应沿用当前值）
 * @property {()=>void} [onCancel] 拖动被取消（pointercancel）时的回调
 * @property {(ev:PointerEvent)=>void} [onResume]
 *   【防卡死体验】pointercancel 后用户在 200ms 内继续移动指针时回调。
 *   调用方应借此**重新开启一次拖动会话**（从当前指针位置继续），
 *   这样即使浏览器抢走一次指针，用户也不会感觉到中断。
 * @property {string} [label] 诊断日志里标识这是哪个拖动（进度条/音量/色相环）
 */

/**
 * 绑定一次按住拖动。
 *
 * @param {PointerEvent} e 触发拖动的 pointerdown 事件
 * @param {PointerDragOptions} options
 * @returns {() => void} 手动解绑函数（一般不需要调用，收尾会自动解绑）
 */
export function attachPointerDrag(e, options) {
  const { el, onMove, onEnd, onCancel, onResume, label = 'drag' } = options

  // 开启诊断时顺带安装捕获事件记录器（只装一次）
  if (diagnoseEnabled) installCaptureDiagnostics()

  /** 监听目标统一为 window：拖出元素外也能收到 pointerup/pointercancel */
  const target = window

  let finished = false
  /** window 实际收到的 pointermove 次数（诊断用：为 0 说明事件根本没到） */
  let moveSeen = 0

  /**
   * 坐标 → 0~1 比例。
   *
   * 返回 null 表示"无法确定"（坐标非有限、元素未布局、计算结果非法）。
   * **绝不在无法确定时返回 0**：0 是"拖到最左端"这个合法落点，
   * 两者语义不同，混用正是"进度莫名跳回开头"的根源。
   *
   * @param {PointerEvent} ev
   * @returns {number|null}
   */
  const ratioOf = (ev) => {
    const x = ev?.clientX
    if (!Number.isFinite(x)) return null
    const rect = el.getBoundingClientRect()
    if (!(rect.width > 0)) return null
    const raw = (x - rect.left) / rect.width
    if (!Number.isFinite(raw)) return null
    return Math.min(1, Math.max(0, raw))
  }

  const handleMove = (ev) => {
    if (finished) return
    moveSeen++
    const r = ratioOf(ev)
    if (moveSeen <= 3) {
      const rect = el.getBoundingClientRect()
      diag(label, `window 收到 pointermove #${moveSeen}`, {
        pointerType: ev.pointerType,
        pointerId: ev.pointerId,
        isPrimary: ev.isPrimary,
        target: describeTarget(ev.target),
        clientX: ev.clientX,
        clientY: ev.clientY,
        buttons: ev.buttons,
        ratio: r,
        // 坐标算错的排查需要 rect 数值本身（宽为 0 / 位置异常都能一眼看出来）
        rect: { left: Math.round(rect.left), width: Math.round(rect.width), top: Math.round(rect.top) },
        // 捕获状态残留的直接证据
        elHasCapture: typeof el.hasPointerCapture === 'function' ? el.hasPointerCapture(ev.pointerId) : null,
      })
    }
    // 坐标不可用时保留上一次的位置，不要当成 0
    if (r !== null) onMove(r, ev)
  }

  /**
   * 收尾。@param {PointerEvent} ev @param {'commit'|'cancel'} mode
   */
  const finish = (ev, mode) => {
    // 幂等：pointerup 与 pointercancel 有可能先后都到达。
    // 若不拦，第二次会把已确定的落点覆盖掉。
    if (finished) return
    finished = true

    diag(label, '收尾', {
      mode,
      pointerType: ev?.pointerType,
      pointerId: ev?.pointerId,
      window收到的move次数: moveSeen,
      clientX: ev?.clientX,
      target: describeTarget(ev?.target),
      // 捕获残留排查：收尾时该元素是否仍持有捕获
      elHasCaptureAtFinish:
        typeof el.hasPointerCapture === 'function' && ev?.pointerId != null
          ? el.hasPointerCapture(ev.pointerId)
          : null,
    })

    // 按登记表解绑 —— 与绑定时用的是同一份数据，target 必然一致
    for (const [type, handler] of listeners) {
      target.removeEventListener(type, handler)
    }
    listeners.length = 0

    if (mode === 'cancel') {
      // 取消也必须收尾（否则调用方可能卡在"拖动中"状态），
      // 但用 undefined 表明"坐标不可用"，由调用方沿用当前值。
      onCancel?.()
      onEnd?.(undefined, ev)
      armCancelResume(ev)
      return
    }

    const r = ratioOf(ev)
    onEnd?.(r === null ? undefined : r, ev)
  }

  const onUp = (ev) => finish(ev, 'commit')
  const onCancelEvent = (ev) => finish(ev, 'cancel')

  /**
   * 【防卡死体验】pointercancel 后的"无感续接"窗口。
   *
   * 背景：即使 preventDefault 挡住了选择拖拽，仍可能有其它原因触发
   * pointercancel（浏览器手势、设备切换等，无法穷举）。
   * 取消本身无法避免，但**用户不该感觉到"卡住"**。
   *
   * 做法：取消后开一个 200ms 的观察窗。用户若在这段时间内继续移动指针，
   * 视为"用户想继续拖"，回调 onResume —— 调用方借此**重新开启一次拖动会话**
   * （从当前指针位置继续，无缝衔接）。
   *
   * 200ms 的取值：覆盖"浏览器取消 → 用户手还没停"的间隙，
   * 又短到不会把"用户真的松手了然后随意晃鼠标"误判成继续拖动。
   */
  const armCancelResume = (ev) => {
    if (typeof onResume !== 'function') return
    const deadline = performance.now() + 200
    const onMoveResume = (e2) => {
      if (performance.now() > deadline) {
        window.removeEventListener('pointermove', onMoveResume)
        return
      }
      // 用户继续移动 → 视为"继续拖动"，立即重开会话
      window.removeEventListener('pointermove', onMoveResume)
      diag(label, '取消后 200ms 内检测到移动 → 无感续接新会话', {
        clientX: e2.clientX,
        clientY: e2.clientY,
      })
      onResume(e2)
    }
    window.addEventListener('pointermove', onMoveResume)
    // 防止观察窗本身泄漏：超时后必定移除
    setTimeout(() => window.removeEventListener('pointermove', onMoveResume), 260)
    void ev
  }

  /** @type {Array<[string, EventListener]>} 与绑定一一对应的登记表 */
  const listeners = [
    ['pointermove', handleMove],
    ['pointerup', onUp],
    ['pointercancel', onCancelEvent],
  ]

  diag(label, 'pointerdown → 开始拖动', {
    pointerType: e.pointerType,
    pointerId: e.pointerId,
    isPrimary: e.isPrimary,
    target: describeTarget(e.target),
    clientX: e.clientX,
    // 检查"按下时是否已隐式/显式持有捕获"（鼠标特有路径排查的关键数据）
    elHasCaptureAtDown:
      typeof el.hasPointerCapture === 'function' ? el.hasPointerCapture(e.pointerId) : null,
    defaultPrevented: e.defaultPrevented,
  })

  /**
   * 【本次修复的核心：pointerdown 必须 preventDefault】
   *
   * 【真机日志钉死的机制】（用户提供的完整时序）
   *   第 1 次拖动：pointerdown(clientX=115, target=seek-knob)
   *              → 71 次 pointermove → 收尾 mode=commit, clientX=1327   （正常）
   *   第 2 次拖动：pointerdown(clientX=1327, target=seek-knob)   ← 事件到了
   *              → window 收到 pointermove #1/#2/#3（1326/1324/1323）    ← 也到了
   *              → 收尾 mode='cancel', clientX=0                        ← 浏览器取消了
   *              → 之后 window **不再收到任何 pointermove**               ← 视觉"卡住"
   *
   * 也就是说：**既不是"事件没到"，也不是"坐标算错"，是浏览器主动独占了指针。**
   *
   * 【为什么浏览器会独占：文本选择拖拽】
   * 能让浏览器独占鼠标指针的机制只有一个 —— 原生拖拽。
   * 鼠标下最常见的触发方式就是**文本选择拖拽**：
   *   1. 进度条右端之后是可选中的文本（时长 "0:32"、"1×"、"模拟时钟" 徽标）
   *   2. 第一次**快速**拖动从 115 甩到 1327，指针扫过了这些文本
   *      → 浏览器把这段文字**选中**了（慢速拖动时 thumb 始终跟着指针、
   *        指针没扫过任何文本 → 没有选区 → 所以慢速路径一切正常）
   *   3. 松手后**选区残留**
   *   4. 第二次 pointerdown 落在 clientX=1327 —— 正好落在**刚才被选中的文本上**
   *      在已选中的内容上按下，浏览器启动「拖动这段选区」
   *   5. 移动 3 次（超过 Chrome 的拖拽启动阈值）→ pointercancel → 独占指针
   *
   * 【为什么笔/触摸免疫 —— 决定性佐证】
   * 规范原文："If the event is pointerdown, the associated device is a
   * direct manipulation device … then set pointer capture (implicit pointer capture)"
   * 笔和触摸是 direct manipulation device，浏览器自动施加**隐式捕获**，
   * 捕获状态下不会启动选择拖拽 → 没有选区残留 → 永远不触发。
   * 用户"换数位板立刻正常"正是这个机制的直接体现。
   *
   * 【为什么 preventDefault 是确定性手段（优于重新加捕获）】
   * Pointer Events 规范（pointerdown 事件定义）明文：
   *   "Authors can prevent the firing of certain compatibility mouse events
   *    by canceling the pointerdown event … This sets the PREVENT MOUSE EVENT flag
   *    on the pointer."
   * 取消 pointerdown → 兼容 mouse 事件**完全不发** → 没有 mousedown
   * → 浏览器无从启动选择/拖拽 → pointercancel 的触发条件被从源头消灭。
   * 而 setPointerCapture 只是**重定向**后续指针事件，不必然阻止
   * 由兼容 mouse 事件驱动的选择/拖拽启动 —— 这也是为什么它治标不治本。
   *
   * 影响范围：preventDefault 会一并取消该指针的兼容 mouse 事件
   * （mousedown/mousemove/mouseup/click 等）。对进度条/音量/色相环而言
   * 我们只用 pointer 事件，不依赖 click —— 实测三处的点击与拖动均正常。
   */
  if (e.cancelable) e.preventDefault()

  // 先立即响应一次，让"点一下"就能生效
  const initial = ratioOf(e)
  if (initial !== null) onMove(initial, e)

  for (const [type, handler] of listeners) {
    target.addEventListener(type, handler)
  }

  /** 手动解绑（幂等） */
  return () => finish(/** @type {any} */ ({ pointerId: e.pointerId, clientX: NaN }), 'cancel')
}
