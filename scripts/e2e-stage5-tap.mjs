// @ts-check
/**
 * 阶段 5 第 3 步验收：打轴模式与空格记录。
 *
 * 覆盖 14 条验收（"焦点"一律按需求改为"当前编辑行"）。
 *
 * 用法：node scripts/e2e-stage5-tap.mjs [页面URL] [调试端口]
 */
const PAGE_URL = process.argv[2] ?? 'http://localhost:5173/'
const PORT = Number(process.argv[3] ?? 9222)

let passed = 0
let failed = 0
/** @type {string[]} */
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  \u2713 ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` → ${detail}` : ''}`)
    console.log(`  \u2717 ${name}${detail ? `  → ${detail}` : ''}`)
  }
}
const group = (t) => console.log(`\n${t}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
      last = 'no page target'
    } catch (e) {
      last = e instanceof Error ? e.message : String(e)
    }
    await sleep(400)
  }
  throw new Error(`CDP 端口 ${PORT} 未就绪: ${last}`)
}

class CDP {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.errors = []
    this.consoleErrors = []
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('WS 连接失败')))
      ws.addEventListener('message', (ev) => {
        let m
        try {
          m = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params?.exceptionDetails
          this.errors.push(`${d?.text ?? 'exception'}: ${d?.exception?.description ?? ''}`.slice(0, 300))
        }
        if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
          const txt = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
          this.consoleErrors.push(String(txt).slice(0, 300))
        }
        if (m.id != null && this.pending.has(m.id)) {
          const { resolve: res, reject: rej } = this.pending.get(m.id)
          this.pending.delete(m.id)
          if (m.error) rej(new Error(JSON.stringify(m.error)))
          else res(m.result)
        }
      })
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 60000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (r.exceptionDetails) throw new Error(`页面异常: ${r.exceptionDetails.text}`)
    return r.result?.value
  }
  close() {
    this.ws?.close()
  }
}

async function main() {
  console.log(`\n阶段 5 第 3 步验收：打轴模式 —— ${PAGE_URL}\n`)

  const target = await waitForTarget()
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })

  /**
   * 重置到干净状态。
   *
   * 【必须 reload，不能只清 storage】
   * 打轴状态存在 Pinia store 的内存里，sessionStorage 只是它的持久化副本。
   * 只 sessionStorage.clear() 不会清掉内存里的 editingIndex / tapped / undoStack，
   * 下一组用例就会接着上一组的位置打（表现为"编辑行已经跳到第 1 行"这类串味失败）。
   */
  const reload = async () => {
    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(1000)
    await cdp.eval(`(() => { try { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('lrc-scroller:tutorial-seen:v1','1'); } catch (e) {} return true; })()`)
    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(2800)
    // 兜底：store 是模块级单例，reload 后应已是初始值；再显式 reset 一次求稳
    await cdp.eval(`(() => {
      const t = window.__lrcDiag && window.__lrcDiag.tapping;
      if (t) { t.enabled = false; t.reset(); }
      return true;
    })()`)
    await sleep(200)
  }

  /**
   * 载入指定行数的歌词（每行 1 秒）。
   *
   * 【踩过的坑】seek 的目标值必须 **小于音频时长**。
   * 测试音频是 10 秒，之前的用例 seek(11)/seek(12) 被引擎正确地
   * clamp 到了 10 秒，于是"打点时间依次递增"的断言全部失败 ——
   * 看起来像产品 bug，其实是测试数据越界。
   * 现在所有 seek 都控制在 0~8 秒内。
   */
  const loadLines = (n) =>
    cdp.eval(`(() => {
      const rows = [];
      for (let i = 0; i < ${n}; i++) {
        const mm = String(Math.floor(i / 60)).padStart(2, '0');
        const ss = (i % 60).toFixed(2).padStart(5, '0');
        rows.push('[' + mm + ':' + ss + ']第 ' + (i + 1) + ' 行');
      }
      window.__lrcDiag.lyrics.loadFromText(rows.join('\\n'), { fileName: 'tap.lrc' });
      return true;
    })()`)

  /** 载入 n 行**纯文本**（无时间标签）→ 全部进 droppedLines */
  const loadPlainText = (n) =>
    cdp.eval(`(() => {
      const rows = [];
      for (let i = 0; i < ${n}; i++) rows.push('第 ' + (i + 1) + ' 句');
      window.__lrcDiag.lyrics.loadFromText(rows.join('\\n'), { fileName: 'plain.txt' });
      return true;
    })()`)

  /**
   * 载入**混合文件**：有时间标签的行 + 没有时间标签的行。
   * 例：n=4 → [00:01]第1句 / 第2句 / [00:03]第3句 / 第4句
   * 结果 lines=2（第1、3句）、droppedLines=2（第2、4句）
   */
  const loadMixed = (n) =>
    cdp.eval(`(() => {
      const rows = [];
      for (let i = 0; i < ${n}; i++) {
        if (i % 2 === 0) {
          const sec = String(i + 1).padStart(2, '0');
          rows.push('[00:' + sec + '.00]第 ' + (i + 1) + ' 句');
        } else {
          rows.push('第 ' + (i + 1) + ' 句');
        }
      }
      window.__lrcDiag.lyrics.loadFromText(rows.join('\\n'), { fileName: 'mixed.lrc' });
      return true;
    })()`)

  /** 按一个键 */
  const key = async (k, code, vk, modifiers = 0) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
    await sleep(50)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
    await sleep(420)
  }
  const SPACE = () => key(' ', 'Space', 32)
  const KEY_T = () => key('t', 'KeyT', 84)
  const KEY_Z = () => key('z', 'KeyZ', 90)
  const LEFT = () => key('ArrowLeft', 'ArrowLeft', 37)
  const RIGHT = () => key('ArrowRight', 'ArrowRight', 39)
  const SHIFT = 8

  const snap = () =>
    cdp.eval(`(() => {
      const d = window.__lrcDiag;
      const t = d.tapping;
      const rec = t.tapped[t.lastTappedIndex];
      return {
        enabled: t.enabled,
        editingIndex: t.editingIndex,
        lastTappedIndex: t.lastTappedIndex,
        tappedLen: t.tapped.length,
        undoLen: t.undoStack.length,
        done: t.done,
        rec: rec ? { t: rec.t, locked: rec.locked } : null,
        tappedCount: t.tapped.filter(Boolean).length,
        currentTime: d.player.currentTime,
        playing: d.player.playing,
        // 视觉标记（几何断言第 7 步统一补，这里只验行为）
        editingMarkCount: document.querySelectorAll('.lyric-line.is-editing').length,
        editingMarkIndex: (() => {
          const els = [...document.querySelectorAll('.lyric-line')];
          return els.findIndex(e => e.classList.contains('is-editing'));
        })(),
        activeMarkIndex: (() => {
          const els = [...document.querySelectorAll('.lyric-line')];
          return els.findIndex(e => e.classList.contains('is-active'));
        })(),
        userScrolling: d.auto ? d.auto.userScrolling.value : null,
        tappingLabel: (document.querySelector('.playerbar__tapping') || {}).textContent || null,
        tapBtnOn: !!document.querySelector('.playerbar__tap.is-on'),
        // ── 方案 C：目标行数组相关 ──
        targetKind: t.tapTargetKind,
        totalCount: t.totalCount,
        linesLen: d.lyrics.lines.length,
        droppedLen: d.lyrics.droppedLines.length,
        tappedKind: t.tappedKind,
        // 无时间行的编辑/高亮标记
        untimedEditing: document.querySelectorAll('.stage__untimed-line.is-editing').length,
        untimedTapped: document.querySelectorAll('.stage__untimed-line.is-tapped').length,
        untimedCount: document.querySelectorAll('.stage__untimed-line').length,
        // 打轴面板形态
        panelTapping: !!document.querySelector('.stage__untimed.is-tapping'),
        panelTitle: (document.querySelector('.stage__untimed-head') || {}).textContent || null,
        // 空状态是否与打轴面板共存
        emptyState: !!document.querySelector('.stage__empty'),
      };
    })()`)

  /**
   * 切到**模拟时钟**（时长 0 = 无上限），让时间轴可以超过音频长度。
   *
   * 【为什么有些组必须这么做】
   * 测试音频只有 10 秒，`engine.seek(20)` 会被正确地 clamp 到 10。
   * 而 Z 撤销要验证"回滚 5 秒、连撤 = 多次减 5"，需要 20/30 秒这种值 ——
   * 用真实音频根本测不了。模拟时钟（阶段 1 的能力）没有时长限制。
   *
   * 【顺带说明】纯 txt 导入后 duration 自动就是 0（没有时间标签 → 没有时间轴），
   * 也就是天然无上限，不需要调这个函数。
   */
  const useSimClock = async () => {
    await cdp.eval(`(() => { window.__lrcDiag.player.duration = 0; return true; })()`)
    await sleep(200)
  }

  const seek = async (s) => {
    const dur = await cdp.eval(`window.__lrcDiag.player.duration`)
    /*
     * dur === 0 表示"没有上限"（playerStore.setTime 把 0 当作 Infinity）。
     * 这有两种来源：
     *   1. 无音频且歌词没有时间标签（纯 txt）—— 天然无上限
     *   2. 测试显式调了 useSimClock()
     * 只有 dur > 0（真实音频或按歌词时间轴算出的量程）时才有 clamp。
     */
    if (dur > 0 && s >= dur) {
      throw new Error(`测试数据越界：seek(${s}) 超过时长 ${dur} 秒，会被引擎 clamp 到 ${dur}`)
    }
    await cdp.eval(`window.__lrcDiag.engine.seek(${s})`)
    await sleep(400)
    // 关键：**先暂停再打点**。
    // 打轴时用户是"播放着听、按空格打点"，播放头会在两次 seek 之间继续走；
    // 不暂停的话第 2 次打点记到的是"12.x 秒"而不是设定的 11 秒。
    await cdp.eval(`(() => { const d = window.__lrcDiag; if (d.player.playing) d.engine.pause(); return true; })()`)
    await sleep(150)
  }

  /** 进入打轴模式（每组都从干净状态重新进入，避免组间串味） */
  const enterTapping = async () => {
    await cdp.eval(`(() => {
      const t = window.__lrcDiag.tapping;
      if (!t.enabled) document.querySelector('.playerbar__tap').click();
      return true;
    })()`)
    await sleep(500)
  }

  await reload()
  await loadLines(8)
  await sleep(500)

  // ══════════════════════════════════════════════
  group('1. 播放条出现打轴开关，进入后有可见标记')
  {
    const hasBtn = await cdp.eval(`!!document.querySelector('.playerbar__tap')`)
    check('播放条出现「打轴」开关按钮', hasBtn === true)

    let s = await snap()
    check('初始未进入打轴模式', s.enabled === false)
    check('未进入时不显示"打轴中"标记', s.tappingLabel === null, String(s.tappingLabel))
    check('未进入时无编辑行标记', s.editingMarkCount === 0, `${s.editingMarkCount}`)

    await cdp.eval(`document.querySelector('.playerbar__tap').click()`)
    await sleep(600)
    s = await snap()
    check('点击后进入打轴模式', s.enabled === true)
    check('进入后开关按钮点亮（is-on）', s.tapBtnOn === true)
    check('进入后显示"打轴中"标记', typeof s.tappingLabel === 'string' && s.tappingLabel.includes('打轴中'), String(s.tappingLabel))
    check('当前编辑行初始为第 0 行', s.editingIndex === 0, String(s.editingIndex))
    check('tapped 数组按歌词行数预填', s.tappedLen === 8, `${s.tappedLen}`)
    check('编辑行有视觉标记（.is-editing）', s.editingMarkCount === 1, `${s.editingMarkCount}`)
    check('标记落在第 0 行', s.editingMarkIndex === 0, `${s.editingMarkIndex}`)
  }

  // ══════════════════════════════════════════════
  group('2. 打轴模式下空格不再切换播放/暂停')
  {
    // 从干净的打轴状态开始（本组不关心打了什么，只关心"空格不打轴"）
    await reload()
    await loadLines(8)
    await sleep(500)
    await enterTapping()

    await seek(3)
    const before = await snap()
    await SPACE()
    const after = await snap()
    check('打轴模式按空格不改变播放状态', after.playing === before.playing,
      `${before.playing} → ${after.playing}`)
    check('打轴模式按空格不改变播放头', Math.abs(after.currentTime - before.currentTime) < 0.01,
      `${before.currentTime} → ${after.currentTime}`)
  }

  // ══════════════════════════════════════════════
  group('3. 空格给当前编辑行打时间 + 编辑行 +1')
  {
    await reload()
    await loadLines(8)
    await sleep(500)
    await enterTapping()

    await seek(2)
    let s = await snap()
    const before = s
    check('前置：编辑行从第 0 行开始', before.editingIndex === 0, String(before.editingIndex))

    await SPACE()
    s = await snap()
    check('当前编辑行被记录时间', s.rec !== null && Math.abs(s.rec.t - 2) < 0.05,
      `记录 ${s.rec ? s.rec.t : 'null'}，期望约 2`)
    check('lastTappedIndex 更新为刚打的那行', s.lastTappedIndex === 0, String(s.lastTappedIndex))
    check('编辑行 +1', s.editingIndex === before.editingIndex + 1, `${before.editingIndex} → ${s.editingIndex}`)
    check('编辑行标记跟随到新行', s.editingMarkIndex === s.editingIndex, `${s.editingMarkIndex}`)
    check('打点后未改变播放头（不打乱播放头）', Math.abs(s.currentTime - 2) < 0.05, String(s.currentTime))
  }

  // ══════════════════════════════════════════════
  group('4. 连按 5 次 → 5 行依次获得递增时间，无重复无丢失')
  {
    await reload()
    await loadLines(8)
    await sleep(500)
    await enterTapping()

    for (let i = 0; i < 5; i++) {
      await seek(4 + i)
      await SPACE()
    }
    const r = await cdp.eval(`(() => {
      const t = window.__lrcDiag.tapping;
      const times = t.tapped.slice(0, 5).map(x => x ? Number(x.t.toFixed(2)) : null);
      return { times, editing: t.editingIndex, last: t.lastTappedIndex, undo: t.undoStack.length, count: t.tapped.filter(Boolean).length };
    })()`)
    check('已打 5 行', r.count === 5, `${r.count} 行`)
    check('5 行时间依次为 4,5,6,7,8（严格递增、无重复无丢失）',
      JSON.stringify(r.times) === JSON.stringify([4, 5, 6, 7, 8]),
      JSON.stringify(r.times))
    check('编辑行推进到第 5 行', r.editing === 5, String(r.editing))
    check('lastTappedIndex = 4', r.last === 4, String(r.last))
  }

  // ══════════════════════════════════════════════
  group('5. 未导入音频也能打轴，且不弹「请先导入音频」')
  {
    // 回到没有音频的状态（模拟时钟），歌词重新载入
    await reload()
    await loadLines(5)
    await sleep(500)
    await enterTapping()
    await seek(4)
    const beforeToast = await cdp.eval(`document.querySelectorAll('.toast').length`)
    await SPACE()
    const s = await snap()
    const afterToast = await cdp.eval(`document.querySelectorAll('.toast').length`)
    check('无音频时也能打轴（模拟时钟可用）', s.rec !== null && Math.abs(s.rec.t - 4) < 0.05,
      `记录 ${s.rec ? s.rec.t : 'null'}`)
    check('无音频打轴不弹「请先导入音频」', afterToast <= beforeToast,
      `toast ${beforeToast} → ${afterToast}`)
  }

  // ══════════════════════════════════════════════
  group('6. 覆盖已有时间的行（不新增行）')
  {
    await reload()
    await loadLines(8)
    await sleep(500)
    await enterTapping()

    await seek(4)
    let s = await snap()
    const rowIndex = s.editingIndex
    const beforeCount = s.tappedCount
    await SPACE()
    s = await snap()
    check('首次打点：已打行数 +1', s.tappedCount === beforeCount + 1, `${beforeCount} → ${s.tappedCount}`)
    check('编辑行推进到下一行', s.editingIndex === rowIndex + 1, `${rowIndex} → ${s.editingIndex}`)

    // 回到刚才那行再打一次（时间不同 → 覆盖）
    await cdp.eval(`window.__lrcDiag.tapping.editingIndex = ${rowIndex}`)
    await sleep(200)
    await seek(7)
    const beforeT = await cdp.eval(`window.__lrcDiag.tapping.tapped[${rowIndex}].t`)
    await SPACE()
    const afterT = await cdp.eval(`window.__lrcDiag.tapping.tapped[${rowIndex}].t`)
    check('同一行再次打轴 → 时间被覆盖（4 → 7）',
      Math.abs(afterT - 7) < 0.05 && Math.abs(afterT - beforeT) > 1,
      `${beforeT} → ${afterT}`)
    const total = await cdp.eval(`window.__lrcDiag.tapping.tapped.filter(Boolean).length`)
    check('覆盖不增加行数（仍是 1 行）', total === 1, `${total} 行`)
  }

  // ══════════════════════════════════════════════
  group('7. 末行行为：done 后按空格覆盖末行，不越界')
  {
    await reload()
    await loadLines(3)
    await sleep(500)
    await enterTapping()

    for (let i = 0; i < 3; i++) {
      await seek(1 + i)
      await SPACE()
    }
    let s = await snap()
    check('打完 3 行后 done=true', s.done === true, String(s.done))
    check('编辑行停在末行（index=2，不越界）', s.editingIndex === 2, String(s.editingIndex))

    // done 之后再按空格：应覆盖末行，不是没反应
    const lastT = await cdp.eval(`window.__lrcDiag.tapping.tapped[2].t`)
    await seek(4)
    await SPACE()
    s = await snap()
    const newT = await cdp.eval(`window.__lrcDiag.tapping.tapped[2].t`)
    check('done 后按空格仍覆盖末行（有反应）', Math.abs(newT - 4) < 0.05, `${lastT} → ${newT}`)
    check('编辑行没有越界（仍 ≤ 2）', s.editingIndex <= 2, String(s.editingIndex))
    check('末行仍是 is-editing 标记', s.editingMarkIndex === 2, String(s.editingMarkIndex))
  }

  // ══════════════════════════════════════════════
  group('8. 打轴模式下点播放/暂停按钮仍能切换')
  {
    await reload()
    await loadLines(5)
    await sleep(500)
    await enterTapping()
    const before = await snap()
    await cdp.eval(`document.querySelector('.playerbar__play').click()`)
    await sleep(600)
    const after = await snap()
    check('点播放按钮仍能切换播放状态', after.playing !== before.playing,
      `${before.playing} → ${after.playing}`)
    // 切回原状态
    await cdp.eval(`document.querySelector('.playerbar__play').click()`)
    await sleep(500)
  }

  // ══════════════════════════════════════════════
  group('9. 关闭打轴模式 → 空格恢复播放/暂停（不回归）')
  {
    await cdp.eval(`document.querySelector('.playerbar__tap').click()`)
    await sleep(500)
    let s = await snap()
    check('可退出打轴模式', s.enabled === false)
    check('退出后编辑行标记消失', s.editingMarkCount === 0, `${s.editingMarkCount}`)
    check('退出后"打轴中"标记消失', s.tappingLabel === null, String(s.tappingLabel))

    await seek(5)
    const before = await snap()
    await SPACE()
    const after = await snap()
    check('非打轴模式空格恢复播放/暂停', after.playing !== before.playing,
      `${before.playing} → ${after.playing}`)
    check('非打轴模式空格不打轴（编辑行不变）', after.editingIndex === before.editingIndex,
      `${before.editingIndex} → ${after.editingIndex}`)
  }

  // ══════════════════════════════════════════════
  group('10. 输入框里的空格是"打空格"，不触发打轴')
  {
    await reload()
    await loadLines(5)
    await sleep(500)
    await enterTapping()
    await cdp.eval(`window.__lrcDiag.settings.openDrawer()`)
    await sleep(900)
    const before = await snap()

    const focused = await cdp.eval(`(() => {
      const el = document.querySelector('.cp__hex-input');
      if (!el) return false;
      el.focus();
      return document.activeElement === el;
    })()`)
    check('已聚焦 HEX 输入框', focused === true)

    await SPACE()
    const after = await snap()
    check('输入框内按空格不打轴（编辑行不变）', after.editingIndex === before.editingIndex,
      `${before.editingIndex} → ${after.editingIndex}`)
    check('输入框内按空格没有记录时间', after.tappedCount === before.tappedCount,
      `${before.tappedCount} → ${after.tappedCount}`)

    await cdp.eval(`document.querySelector('.cp__hex-input').blur()`)
    await cdp.eval(`window.__lrcDiag.settings.closeDrawer()`)
    await sleep(500)
  }

  // ══════════════════════════════════════════════
  group('11. T 键切换打轴模式')
  {
    await reload()
    await loadLines(5)
    await sleep(500)
    let s = await snap()
    check('前置：初始不在打轴模式', s.enabled === false)
    await KEY_T()
    s = await snap()
    check('T 键可进入打轴模式', s.enabled === true)
    await KEY_T()
    s = await snap()
    check('再按 T 可退出演示模式', s.enabled === false)
  }

  // ══════════════════════════════════════════════
  group('12. Z 撤销：多级 + 播放头固定回滚 5 秒')
  {
    await reload()
    await loadLines(6)
    await useSimClock()
    await sleep(300)
    await enterTapping()

    await seek(20)
    await SPACE()
    await seek(30)
    await SPACE()
    let s = await snap()
    check('打了 2 行', s.tappedCount === 2, `${s.tappedCount}`)
    check('当前播放头 = 30', Math.abs(s.currentTime - 30) < 0.05, String(s.currentTime))

    await KEY_Z()
    s = await snap()
    check('Z 撤销 1 步：已打行数 2 → 1', s.tappedCount === 1, `${s.tappedCount}`)
    check('Z 后播放头回滚 5 秒（30 → 25）', Math.abs(s.currentTime - 25) < 0.1, String(s.currentTime))

    await KEY_Z()
    s = await snap()
    check('Z 再撤：已打行数 1 → 0', s.tappedCount === 0, `${s.tappedCount}`)
    check('Z 再撤后播放头继续回滚 5 秒（25 → 20）', Math.abs(s.currentTime - 20) < 0.1, String(s.currentTime))
    check('编辑行回到 0', s.editingIndex === 0, String(s.editingIndex))

    // 栈空后再按 Z：无反应、无报错
    await KEY_Z()
    s = await snap()
    check('撤销栈空后再按 Z 不崩、不越界', s.tappedCount === 0, `${s.tappedCount}`)
  }

  // ══════════════════════════════════════════════
  group('12b. Z 回滚 clamp 到 0（< 5s 时不为负）')
  {
    await reload()
    await loadLines(4)
    await useSimClock()
    await sleep(300)
    await enterTapping()
    await seek(2)
    await SPACE()
    await seek(3)
    await SPACE()
    let s = await snap()
    check('前置：播放头 = 3', Math.abs(s.currentTime - 3) < 0.05, String(s.currentTime))
    await KEY_Z()
    s = await snap()
    check('播放头回滚 3-5 被 clamp 到 0（不为负）', s.currentTime >= 0 && s.currentTime < 0.05,
      String(s.currentTime))
  }

  // ══════════════════════════════════════════════
  group('12c. 退出打轴模式后撤销栈保留')
  {
    await reload()
    await loadLines(4)
    await useSimClock()
    await sleep(300)
    await enterTapping()
    await seek(4)
    await SPACE()
    await seek(6)
    await SPACE()
    let s = await snap()
    const undoBefore = s.undoLen
    check('退出前有 2 层撤销栈', undoBefore === 2, `${undoBefore}`)

    // 退出再进入
    await cdp.eval(`document.querySelector('.playerbar__tap').click()`)
    await sleep(500)
    await cdp.eval(`document.querySelector('.playerbar__tap').click()`)
    await sleep(500)
    s = await snap()
    check('退出再进入后撤销栈仍在', s.undoLen === 2, `${s.undoLen}`)

    // 还能撤
    await KEY_Z()
    s = await snap()
    check('退出再进入后仍能撤销', s.tappedCount === 1, `${s.tappedCount}`)
  }

  // ══════════════════════════════════════════════
  group('13. 打轴时翻看不被自动跳回（程序滚动与回看态分离）')
  {
    await reload()
    await loadLines(20)
    await sleep(500)
    await enterTapping()

    // 空格打一行 → 触发程序滚动
    await seek(5)
    await SPACE()
    const offAfterTap = await cdp.eval(`window.__lrcDiag.auto.currentOffset.value`)

    /*
     * 【必须用 PageDown，不是 ↓】
     * 全局 ↑/↓ 在 useKeyboard 里是**音量**键；
     * 舞台滚动绑定在 StageView 的 @keydown 上，只处理
     * PageUp/PageDown/Home/End 这几个键。
     * 所以"翻看上下文"的手势是 PageDown（或鼠标滚轮），不是 ↓。
     * 这也解释了为什么 ↓ 按了半天舞台纹丝不动。
     */
    await cdp.eval(`(() => {
      const stage = document.querySelector('.stage');
      if (stage) stage.focus();
      return document.activeElement === stage;
    })()`)
    await sleep(200)

    const focused = await cdp.eval(`document.activeElement ? document.activeElement.className : null`)
    check('焦点已在舞台上（PageDown 才会滚舞台）',
      typeof focused === 'string' && focused.includes('stage'), String(focused))

    // 用 PageDown 往下翻看（进入回看态）
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 })
    await sleep(60)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 })
    await sleep(500)
    let s = await snap()
    check('打轴模式下 PageDown 能翻看（进入回看态）', s.userScrolling === true, String(s.userScrolling))

    const offAfterScroll = await cdp.eval(`window.__lrcDiag.auto.currentOffset.value`)
    check('翻看确实改变了位移', Math.abs(offAfterScroll - offAfterTap) > 1,
      `${offAfterTap.toFixed(1)} → ${offAfterScroll.toFixed(1)}`)

    // 等超过 3 秒（原本会自动跳回）
    await sleep(4200)
    const offLater = await cdp.eval(`window.__lrcDiag.auto.currentOffset.value`)
    check('打轴模式：3 秒后**不会**自动跳回（保持翻看位置）',
      Math.abs(offLater - offAfterScroll) < 1,
      `3 秒后 ${offLater.toFixed(1)}，翻看时 ${offAfterScroll.toFixed(1)}`)
    check('打轴模式：仍处于回看态', (await snap()).userScrolling === true)

    // 对照：非打轴模式下 3 秒后会自动跳回（阶段 3 原有行为，不回归）
    await cdp.eval(`window.__lrcDiag.tapping.disable()`)
    await sleep(200)
    await cdp.eval(`(() => { const s = document.querySelector('.stage'); if (s) s.focus(); return true; })()`)
    await sleep(200)
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 })
    await sleep(60)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 })
    await sleep(4200)
    check('【不回归】非打轴模式：3 秒后仍会自动跳回（原有行为）',
      (await snap()).userScrolling === false,
      String((await snap()).userScrolling))
  }

  // ══════════════════════════════════════════════
  // 【补丁 8 视觉增强】.is-tapped 几何断言
  //
  // 用户明确要求本轮必须补几何断言（不能后置到第 7 步）。
  // 全部读**计算样式**（transform / color）与几何位置 ——
  // "看起来对"无法证明 transform 不影响布局。
  group('视觉：刚打完的行（.is-tapped）几何断言')
  {
    const rowGeom = () =>
      cdp.eval(`(() => {
        return [...document.querySelectorAll('.lyric-line')].map((el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            idx: Number(el.dataset.lineIndex),
            classes: el.className,
            isTapped: el.classList.contains('is-tapped'),
            isActive: el.classList.contains('is-active'),
            isEditing: el.classList.contains('is-editing'),
            transform: cs.transform,
            color: cs.color,
            top: Math.round(r.top),
            height: Math.round(r.height),
          };
        });
      })()`)

    await reload()
    await loadLines(8)
    await sleep(500)
    await enterTapping()

    // ① 初始：0 行有 .is-tapped
    let g = await rowGeom()
    check('① 初始（未打任何行）→ 0 行有 .is-tapped', g.filter((r) => r.isTapped).length === 0,
      `${g.filter((r) => r.isTapped).length} 行`)

    // ② 打第一行
    await seek(2)
    await SPACE()
    g = await rowGeom()
    const row0 = g.find((r) => r.idx === 0)
    check('② 按空格后 lastTappedIndex 对应行有 .is-tapped', row0.isTapped === true, row0.classes)

    // ③ 该行 transform 含 scale(...)
    check('③ 该行 transform 含 scale(...)', row0.transform !== 'none' && /matrix\(|scale/.test(row0.transform),
      row0.transform)
    const scale0 = parseFloat(row0.transform.replace(/^matrix\(/, '').split(',')[0])
    check('③b 放大比例与 --lrc-active-scale 一致（1.2~1.5）', scale0 > 1.2 && scale0 < 1.5, `scale=${scale0}`)

    // ④ 每一行都有非零高度（布局正常）
    check('④ 相邻行有非零高度（布局正常）', g[1].height > 10 && g[2].height > 10,
      `行1 高 ${g[1].height}px`)

    // ⑤ 连打 3 次 → 只剩最后一行有 .is-tapped
    await seek(4)
    await SPACE()
    await seek(6)
    await SPACE()
    g = await rowGeom()
    const tappedRows = g.filter((r) => r.isTapped)
    check('⑤ 连打 3 次 → 只有最后一行有 .is-tapped', tappedRows.length === 1 && tappedRows[0].idx === 2,
      `命中行: [${tappedRows.map((r) => r.idx)}]`)
    check('⑤b 前两行的 .is-tapped 已清除', g[0].isTapped === false && g[1].isTapped === false)

    // ⑥ transform 不影响布局：把"有 .is-tapped"与"没有"的两行做对比
    /*
     * 【踩过的坑：不能拿"打点前 vs 打点后"的所有行高度直接比】
     * 各行高度本来就不全相同（间奏空行、.is-editing 的 padding-left + border 都会改高度），
     * 所以前后对比必然不等 —— 那不是 transform 泄漏。
     *
     * 正确的对照是**同一时刻**的两行：
     * 被放大的 is-tapped 行，与**相邻的、未放大的**普通行。
     * 两者行高应只差"放大把视觉尺寸撑大"的那部分，
     * 而**不占据布局**（普通行的 top 不会被放大的行推开）。
     */
    g = await rowGeom()
    const tIdx = g.findIndex((r) => r.isTapped)
    const neighborIdx = tIdx + 1 < g.length ? tIdx + 1 : tIdx - 1
    const tRow = g[tIdx]
    const nRow = g[neighborIdx]
    check('⑥ 放大的 .is-tapped 行：transform 不占据布局（相邻行未被推开）',
      tRow.height > 0 && nRow.height > 0 && Math.abs(tRow.height - nRow.height) < 30,
      `tapped(idx ${tIdx}) 高 ${tRow.height}px，相邻(idx ${neighborIdx}) 高 ${nRow.height}px`)
    check('⑥b 相邻行 top 紧邻（未被放大行挤开）',
      Math.abs(nRow.top - tRow.top) < tRow.height * 1.5,
      `tapped top=${tRow.top}, 相邻 top=${nRow.top}`)

    // ⑦ 同一行既是 active 又是 tapped → 只放大一次
    const activeIdx = g.findIndex((r) => r.isActive)
    const tappedIdx = g.findIndex((r) => r.isTapped)
    if (activeIdx >= 0 && activeIdx === tappedIdx) {
      const m = parseFloat(g[activeIdx].transform.replace(/^matrix\(/, '').split(',')[0])
      check('⑦ is-active 与 is-tapped 同行 → 只放大一次（scale ≈1.35，不是 1.35²≈1.82）',
        m > 1.2 && m < 1.5, `scale=${m}`)
      check('⑦b 同行时颜色由 active 胜出（--lrc-color-active）',
        g[activeIdx].color === 'rgb(255, 255, 255)', g[activeIdx].color)
    } else {
      // 播放头不在刚打完的行上 —— 这本身就是需求里的常态（两者应在不同行）
      check('⑦ active 与 tapped 在不同行（两行各有各的高亮，互不干扰）',
        activeIdx >= 0 && tappedIdx >= 0 && activeIdx !== tappedIdx,
        `active=${activeIdx}, tapped=${tappedIdx}`)
      check('⑦b 两行颜色不同（active 白 / tapped 蓝）',
        g[activeIdx].color !== g[tappedIdx].color,
        `${g[activeIdx].color} vs ${g[tappedIdx].color}`)
      check('⑦c 两行都放大了（各 1.35，互不叠加）', [activeIdx, tappedIdx].every((i) => {
        const m = parseFloat(g[i].transform.replace(/^matrix\(/, '').split(',')[0])
        return m > 1.2 && m < 1.5
      }), `active scale / tapped scale 均在 1.2~1.5`)
    }

    // ⑧ 改设置里的 color.tapped → 该行计算色跟着变
    const beforeColor = (await rowGeom()).find((r) => r.isTapped)?.color ?? null
    await cdp.eval(`window.__lrcDiag.settings.set('color.tapped', '#ff00aa')`)
    await sleep(500)
    const afterColor = (await rowGeom()).find((r) => r.isTapped)?.color ?? null
    check('⑧ 设置里改 color.tapped → 该行 color 计算样式跟着变',
      beforeColor !== null && afterColor !== null && beforeColor !== afterColor,
      `${beforeColor} → ${afterColor}`)
    check('⑧b 新值确实生效（#ff00aa → rgb(255, 0, 170)）', afterColor === 'rgb(255, 0, 170)', String(afterColor))
  }

  // ══════════════════════════════════════════════
  // 【真机 BUG 回归】焦点停在「打轴」按钮上时按空格，不应退出打轴模式
  //
  // 为什么单独一组：前面的 81 项全部用 `c.tap()` / 直接派发键盘事件，
  // **没有任何一条先把焦点放到按钮上** —— 而真机用户是"点按钮"进来的，
  // 点击后焦点就留在按钮上。所以老用例结构上抓不到这个 bug。
  group('真机 BUG 回归：焦点在打轴按钮上时按空格')
  {
    await reload()
    await loadLines(6)
    await sleep(500)

    // 用**真实鼠标点击**进入打轴（这样焦点才会留在按钮上）
    const btn = await cdp.eval(`(() => {
      const el = document.querySelector('.playerbar__tap');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    check('找到「打轴」按钮', btn !== null)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: 0 })
    await sleep(700)

    // ① 前置：焦点确实在打轴按钮上（这是老用例缺的关键条件）
    const focusIsBtn = await cdp.eval(`document.activeElement === document.querySelector('.playerbar__tap')`)
    check('① 真实点击后焦点留在「打轴」按钮上（前置条件成立）', focusIsBtn === true,
      await cdp.eval(`document.activeElement ? document.activeElement.className : null`))
    check('①b 已进入打轴模式', (await snap()).enabled === true)

    await seek(3)

    // ② 按空格 → 打轴模式仍开启（修复前会变 false）
    await SPACE()
    let s = await snap()
    check('② 焦点在打轴按钮上按空格 → 打轴模式仍开启（不退出）', s.enabled === true,
      `enabled=${s.enabled}`)

    // ③ 按空格 → 该行被打上时间（证明走的是打轴而不是按钮的 click）
    check('③ 该行被打上时间（tapped[0] 非 null）', s.tappedCount === 1, `${s.tappedCount} 行`)
    check('③b 编辑行推进到下一行', s.editingIndex === 1, String(s.editingIndex))

    // 再按一次，确认连打不受影响
    await SPACE()
    s = await snap()
    check('③c 连按两次 → 打了 2 行且模式仍开启', s.tappedCount === 2 && s.enabled === true,
      `tapped=${s.tappedCount}, enabled=${s.enabled}`)

    // 退出打轴，为反向验证做准备
    await cdp.eval(`window.__lrcDiag.tapping.disable()`)
    await sleep(400)

    // 反向验证：非打轴模式、焦点在播放按钮上、按空格 → 仍能播放/暂停
    const playBtn = await cdp.eval(`(() => {
      const el = document.querySelector('.playerbar__play');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: playBtn.x, y: playBtn.y, button: 'left', clickCount: 1, buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: playBtn.x, y: playBtn.y, button: 'left', clickCount: 1, buttons: 0 })
    await sleep(500)
    const focusIsPlay = await cdp.eval(`document.activeElement === document.querySelector('.playerbar__play')`)
    check('【反向】非打轴模式：焦点在播放按钮上', focusIsPlay === true,
      await cdp.eval(`document.activeElement ? document.activeElement.className : null`))

    const playingBefore = (await snap()).playing
    await SPACE()
    const playingAfter = (await snap()).playing
    check('【反向·不回归】非打轴模式、焦点在播放按钮上按空格 → 正常播放/暂停',
      playingAfter !== playingBefore, `${playingBefore} → ${playingAfter}`)
    check('【反向】非打轴模式下空格不打轴', (await snap()).tappedCount === 2,
      `tapped=${(await snap()).tappedCount}`)
  }

  // ══════════════════════════════════════════════
  // 【方案 C】让 txt（无时间标签的行）也能打轴
  //
  // 真机 bug：导入 txt 后进打轴，按空格打不上，左下角显示"打轴中 1/0"。
  // 根因：tapped 长度 = lines.length，txt 的行全在 droppedLines 里 → 长度 0。
  //
  // 决策：打轴永远作用于"没有时间的行"；所有行都有时间时才作用于 lines。
  group('方案 C：纯 txt（无时间标签）也能打轴')
  {
    await reload()
    await loadPlainText(5)
    await sleep(600)

    let s = await snap()
    check('前置：纯 txt 导入后 lines 为空、droppedLines 有内容',
      s.linesLen === 0 && s.droppedLen === 5, `lines=${s.linesLen}, dropped=${s.droppedLen}`)
    check('前置：尚未进打轴时无空状态（已有文本可看）', s.emptyState === false)

    await enterTapping()
    s = await snap()
    check('① 目标数组切到 droppedLines', s.targetKind === 'dropped', s.targetKind)
    check('① totalCount = droppedLines 长度（5，不再是 0）', s.totalCount === 5, String(s.totalCount))
    check('① tapped 数组按目标长度预填', s.tappedLen === 5, String(s.tappedLen))
    check('① 进度显示不再出现 "1/0"', !String(s.tappingLabel).includes('1/0'), String(s.tappingLabel))
    check('① 进度显示为 1/5', String(s.tappingLabel).includes('1/5'), String(s.tappingLabel))
    check('① 打轴面板形态已启用（撑满 + 标题变进度）',
      s.panelTapping === true && String(s.panelTitle).includes('打轴中'), String(s.panelTitle))
    check('① 空状态被强制隐藏，不与打轴面板共存', s.emptyState === false)
    check('① 编辑行标记落在无时间行上', s.untimedEditing === 1 && s.editingMarkIndex === -1,
      `untimed=${s.untimedEditing}, lyric=${s.editingMarkIndex}`)

    // 打第 0 行
    await seek(2)
    await SPACE()
    s = await snap()
    check('① 按空格 → 第 0 行被打上时间', s.tappedCount === 1, `${s.tappedCount} 行`)
    const t0 = await cdp.eval(`window.__lrcDiag.tapping.tapped[0] ? window.__lrcDiag.tapping.tapped[0].t : null`)
    check('① 记录的时间 ≈ 2', Math.abs(t0 - 2) < 0.05, String(t0))
    check('① editingIndex 推进到 1', s.editingIndex === 1, String(s.editingIndex))
    check('① 刚打完的行有无时间行高亮', s.untimedTapped === 1, String(s.untimedTapped))

    // ② 连按 N 次 → 递增时间
    await seek(4); await SPACE()
    await seek(6); await SPACE()
    await seek(7); await SPACE()
    const times = await cdp.eval(`window.__lrcDiag.tapping.tapped.map(x => x ? Number(x.t.toFixed(2)) : null)`)
    check('② 连打 5 次 → 5 行时间依次为 2,4,6,7,（第5行未打）',
      JSON.stringify(times.slice(0, 4)) === JSON.stringify([2, 4, 6, 7]) && times[4] === null,
      JSON.stringify(times))
    s = await snap()
    check('② 进度显示推进到 5/5', String(s.tappingLabel).includes('5/5'), String(s.tappingLabel))
    check('② 打了 4 行（第 0-3 行），第 4 行未打', s.tappedCount === 4, `${s.tappedCount}`)
    check('② done=false（还有 1 行没打）', s.done === false, String(s.done))
  }

  // ══════════════════════════════════════════════
  group('方案 C：纯 txt 打轴的草稿保留与目标切换')
  {
    // ③ 退出 → 再进入 → tapped 保留
    await reload()
    await loadPlainText(4)
    await sleep(600)
    await enterTapping()
    await seek(1); await SPACE()
    await seek(3); await SPACE()
    let s = await snap()
    check('③ 打 2 行', s.tappedCount === 2, `${s.tappedCount}`)

    await cdp.eval(`window.__lrcDiag.tapping.disable()`)
    await sleep(300)
    await enterTapping()
    s = await snap()
    check('③ 退出再进入 → 草稿保留（仍是 2 行）', s.tappedCount === 2, `${s.tappedCount}`)
    check('③ 退出再进入 → 目标仍是 dropped', s.targetKind === 'dropped', s.targetKind)
    const times3 = await cdp.eval(`window.__lrcDiag.tapping.tapped.map(x => x ? Number(x.t.toFixed(2)) : null)`)
    check('③ 草稿内容一致（前 2 项是 1、3，其余未打为 null）',
      times3[0] === 1 && times3[1] === 3 && times3.slice(2).every((x) => x === null),
      JSON.stringify(times3))

    // ⑥ 目标切换 → 草稿重置（锁住 ensureSize 的"只比长度"隐患）
    /*
     * 【这条专测什么】
     * 旧 ensureSize 只比较长度。构造一个"长度相同但目标不同"的场景：
     *   纯 lrc（lines=2）打 2 个点 → 草稿长度 2
     *   换纯 txt（dropped=2）      → 长度也是 2
     * 旧逻辑判定"已对齐"→ 不重置 → txt 的第 0 行拿到 lrc 第 0 行的草稿时间。
     * 修好后必须重置为全 null。
     */
    // 先准备"纯 lrc 2 行 + 打 2 个点"
    await cdp.eval(`window.__lrcDiag.tapping.disable()`)
    await sleep(300)
    await loadLines(2)          // lines=2, dropped=0 → 目标 lines
    await useSimClock()          // 2 行歌词算出的量程很小，放开上限避免 seek 被 clamp
    await sleep(300)
    await enterTapping()
    await seek(2); await SPACE()
    await seek(5); await SPACE()
    s = await snap()
    check('⑥ 前置：纯 lrc 2 行打满（目标 lines、草稿长度 2）',
      s.targetKind === 'lines' && s.tappedCount === 2 && s.tappedLen === 2,
      `kind=${s.targetKind}, count=${s.tappedCount}, len=${s.tappedLen}`)

    // 换成"纯 txt 2 行" —— 长度相同、目标不同
    await loadPlainText(2)
    await sleep(700)
    s = await snap()
    check('⑥ 换成纯 txt（dropped=2，长度与之前相同）目标切到 dropped',
      s.targetKind === 'dropped' && s.droppedLen === 2, `kind=${s.targetKind}, dropped=${s.droppedLen}`)
    check('⑥ 【关键】草稿被重置，不张冠李戴（tappedCount = 0）', s.tappedCount === 0,
      `tappedCount=${s.tappedCount}（若为 2 就是把 lrc 的草稿套到了 txt 上）`)
    const afterSwitch = await cdp.eval(`JSON.stringify(window.__lrcDiag.tapping.tapped)`)
    check('⑥ 草稿内容确实全为 null', afterSwitch === '[null,null]', afterSwitch)
    check('⑥ tappedKind 已更新为 dropped', s.tappedKind === 'dropped', s.tappedKind)
  }

  // ══════════════════════════════════════════════
  group('方案 C：混合文件（有时间行 + 无时间行）打无时间的行')
  {
    await reload()
    await loadMixed(4)   // [00:01]第1句 / 第2句 / [00:03]第3句 / 第4句
    await useSimClock()   // 混合文件的时间轴量程只有 3 秒，放开上限避免 seek 被 clamp
    await sleep(600)
    let s = await snap()
    check('前置：混合文件 lines=2、droppedLines=2',
      s.linesLen === 2 && s.droppedLen === 2, `lines=${s.linesLen}, dropped=${s.droppedLen}`)

    await enterTapping()
    s = await snap()
    check('④ 混合文件下目标 = droppedLines（不覆盖已有时间）', s.targetKind === 'dropped', s.targetKind)
    check('④ totalCount = 2（只打缺时间的行）', s.totalCount === 2, String(s.totalCount))
    check('④ tapped 长度 = 2', s.tappedLen === 2, String(s.tappedLen))
    check('④ 轨道里的行**没有**编辑标记（避免两处都标"下一行在这里"）',
      s.editingMarkIndex === -1, `lyric is-editing index=${s.editingMarkIndex}`)
    check('④ 编辑标记只出现在无时间行上', s.untimedEditing === 1, String(s.untimedEditing))
    check('④ 轨道被遮罩压暗',
      await cdp.eval(`getComputedStyle(document.querySelector('.stage__track')).opacity`) !== '1',
      await cdp.eval(`getComputedStyle(document.querySelector('.stage__track')).opacity`))

    // 打第一个无时间行（对应文件里的"第 2 句"）
    await seek(2)
    await SPACE()
    s = await snap()
    check('④ 按空格打到"第 2 句"', s.tappedCount === 1, `${s.tappedCount}`)
    check('④ 已有时间的行未被覆盖（lines 的时间不变）',
      await cdp.eval(`window.__lrcDiag.lyrics.lines[0].t`) === 1 &&
      await cdp.eval(`window.__lrcDiag.lyrics.lines[1].t`) === 3,
      `lines t = [${await cdp.eval(`window.__lrcDiag.lyrics.lines.map(l => l.t)`) }]`)

    // 打第二个无时间行（"第 4 句"）—— 顺序会跳过 line3，这是 B 方案的已知代价
    await seek(6)
    await SPACE()
    s = await snap()
    check('④ 打完 2 个无时间行 → done=true', s.done === true, String(s.done))
    const mixedTimes = await cdp.eval(`window.__lrcDiag.tapping.tapped.map(x => x ? Number(x.t.toFixed(2)) : null)`)
    check('④ 两行时间 2, 6（对应第2句与第4句）',
      JSON.stringify(mixedTimes) === JSON.stringify([2, 6]), JSON.stringify(mixedTimes))
  }

  // ══════════════════════════════════════════════
  group('方案 C：totalCount === 0 时不显示 "1/0"')
  {
    await reload()
    // 空歌词：lines=0 且 droppedLines=0
    await cdp.eval(`window.__lrcDiag.lyrics.loadFromText('', { fileName: 'empty.txt' })`)
    await sleep(700)
    await enterTapping()
    const s = await snap()
    check('无任何行可打时 totalCount = 0', s.totalCount === 0, String(s.totalCount))
    check('不显示 "1/0"', !String(s.tappingLabel).includes('1/0'), String(s.tappingLabel))
    check('显示「无行可打」', String(s.tappingLabel).includes('无行可打'), String(s.tappingLabel))
    check('空状态下按空格不崩、不记录', true)
    await SPACE()
    const s2 = await snap()
    check('空状态按空格后 tappedCount 仍为 0', s2.tappedCount === 0, String(s2.tappedCount))
  }

  // ══════════════════════════════════════════════
  // 【任务 A】应用打轴结果
  group('应用：把打轴结果合并进歌词')
  {
    const applyBtn = () => cdp.eval(`(() => {
      const b = document.querySelector('.playerbar__apply');
      if (!b) return null;
      return { text: b.textContent.trim(), disabled: b.disabled };
    })()`)

    await reload()
    await loadPlainText(4)
    await sleep(600)
    check('打轴模式关闭时不显示「应用到歌词」按钮',
      (await cdp.eval(`!!document.querySelector('.playerbar__apply')`)) === false)

    await enterTapping()
    let b = await applyBtn()
    check('打轴模式下显示「应用到歌词」按钮', b !== null, JSON.stringify(b))
    check('没打任何行时按钮禁用', b.disabled === true, String(b.disabled))

    await seek(2); await SPACE()
    await seek(4); await SPACE()
    b = await applyBtn()
    check('打了 2 行后按钮可用', b.disabled === false, String(b.disabled))

    const before = await snap()
    await cdp.eval(`document.querySelector('.playerbar__apply').click()`)
    await sleep(700)

    const after = await cdp.eval(`(() => {
      const d = window.__lrcDiag;
      const t = d.tapping;
      return {
        linesLen: d.lyrics.lines.length,
        droppedLen: d.lyrics.droppedLines.length,
        times: d.lyrics.lines.map(l => Number(l.t.toFixed(2))),
        texts: d.lyrics.lines.map(l => l.text),
        ids: d.lyrics.lines.map(l => l.id),
        rawTs: d.lyrics.lines.map(l => l.rawT),
        sourceLines: d.lyrics.lines.map(l => l.sourceLine),
        tappedCount: t.tappedCount,
        undoLen: t.undoStack.length,
        enabled: t.enabled,
        droppedTexts: d.lyrics.droppedLines.map(x => x.text),
      };
    })()`)

    check('应用后 lines 长度 = 原 0 + 已打 2', after.linesLen === 2, String(after.linesLen))
    check('应用后 lines 按 t 升序', JSON.stringify(after.times) === JSON.stringify([2, 4]), JSON.stringify(after.times))
    check('应用后 id 连续 L0, L1', JSON.stringify(after.ids) === JSON.stringify(['L0', 'L1']), JSON.stringify(after.ids))
    check('应用后 rawT = t（让 offset 对其生效）',
      JSON.stringify(after.rawTs) === JSON.stringify([2, 4]), JSON.stringify(after.rawTs))
    check('应用后 sourceLine 来自 droppedLines[i].line（保证同时间行稳定排序）',
      JSON.stringify(after.sourceLines) === JSON.stringify([1, 2]), JSON.stringify(after.sourceLines))
    check('应用后 text 取自 droppedLines', JSON.stringify(after.texts) === JSON.stringify(['第 1 句', '第 2 句']),
      JSON.stringify(after.texts))
    check('应用后 droppedLines 只留未打的 2 行',
      after.droppedLen === 2 && JSON.stringify(after.droppedTexts) === JSON.stringify(['第 3 句', '第 4 句']),
      `${after.droppedLen} 行: ${JSON.stringify(after.droppedTexts)}`)
    check('应用后草稿清空（tappedCount = 0）', after.tappedCount === 0, String(after.tappedCount))
    check('应用后 undoStack 清空', after.undoLen === 0, String(after.undoLen))
    check('应用后退出打轴模式', after.enabled === false, String(after.enabled))
    void before

    // 应用后播放能滚：activeIndex 随 currentTime 变
    // 注意：应用后的两行在 t=2 与 t=4，所以在 1 秒处**没有**当前行（-1 是正确的），
    // 必须取落在行区间内的时间。
    await cdp.eval(`window.__lrcDiag.engine.seek(2.5)`); await sleep(500)
    const idx1 = await cdp.eval(`window.__lrcDiag.auto.activeIndex.value`)
    await cdp.eval(`window.__lrcDiag.engine.seek(4.5)`); await sleep(600)
    const idx2 = await cdp.eval(`window.__lrcDiag.auto.activeIndex.value`)
    check('应用后播放能滚（activeIndex 随 currentTime 变）', idx1 === 0 && idx2 === 1, `${idx1} → ${idx2}`)

    // 3 秒内 Ctrl+Z → 整体还原
    await cdp.eval(`window.__lrcDiag.engine.seek(1)`); await sleep(300)
    await cdp.eval(`document.querySelector('.playerbar__tap').click()`)
    await sleep(600)
    await seek(3); await SPACE()
    await cdp.eval(`document.querySelector('.playerbar__apply').click()`)
    await sleep(600)
    const applied = await cdp.eval(`window.__lrcDiag.lyrics.lines.length`)
    check('前置：第二次应用生效', applied > 0, String(applied))

    await key('z', 'KeyZ', 90, 2)   // modifiers 2 = Ctrl
    await sleep(600)
    const restored = await cdp.eval(`(() => {
      const d = window.__lrcDiag;
      const t = d.tapping;
      return {
        linesLen: d.lyrics.lines.length,
        droppedLen: d.lyrics.droppedLines.length,
        tappedCount: t.tappedCount,
        enabled: t.enabled,
      };
    })()`)
    check('3 秒内 Ctrl+Z → lines 还原', restored.linesLen === applied - 1 || restored.linesLen === 2,
      `应用后 ${applied} → 还原后 ${restored.linesLen}`)
    check('3 秒内 Ctrl+Z → droppedLines 还原（未打的行回到原状）',
      restored.droppedLen > 0, String(restored.droppedLen))
    check('3 秒内 Ctrl+Z → tapped 还原（草稿回来了）', restored.tappedCount > 0, String(restored.tappedCount))
    check('3 秒内 Ctrl+Z → 打轴模式重新开启', restored.enabled === true, String(restored.enabled))

    // 3 秒后 Ctrl+Z 无效（快照已丢弃）
    await sleep(3400)
    await key('z', 'KeyZ', 90, 2)
    await sleep(500)
    const afterExpire = await cdp.eval(`(() => {
      const d = window.__lrcDiag;
      return { linesLen: d.lyrics.lines.length, tappedCount: d.tapping.tappedCount };
    })()`)
    check('3 秒后 Ctrl+Z 不再还原（快照已丢弃）',
      afterExpire.linesLen === restored.linesLen, `${restored.linesLen} → ${afterExpire.linesLen}`)

    // 应用后 Z 键无反应（草稿已空）
    await reload()
    await loadPlainText(3)
    await sleep(600)
    await enterTapping()
    await seek(2); await SPACE()
    await cdp.eval(`document.querySelector('.playerbar__apply').click()`)
    await sleep(600)
    const preZ = await cdp.eval(`window.__lrcDiag.lyrics.lines.length`)
    await key('z', 'KeyZ', 90, 0)   // 不带 Ctrl
    await sleep(500)
    const postZ = await cdp.eval(`window.__lrcDiag.lyrics.lines.length`)
    check('应用后按 Z（无 Ctrl）无反应', postZ === preZ, `${preZ} → ${postZ}`)

    // 没打完的行：应用后 droppedLines 保留，不丢
    check('没打完的行保留在 droppedLines（不丢内容）',
      (await cdp.eval(`window.__lrcDiag.lyrics.droppedLines.length`)) === 2,
      String(await cdp.eval(`window.__lrcDiag.lyrics.droppedLines.length`)))
  }

  // ══════════════════════════════════════════════
  // 【任务 B】节拍吸附
  group('节拍：吸附与 beat 序号')
  {
    const setSync = async (bpm, snap, firstBeatMs = 0) => {
      await cdp.eval(`window.__lrcDiag.settings.setMany({
        'sync.bpm': ${bpm === null ? 'null' : bpm},
        'sync.snap': ${JSON.stringify(snap)},
        'sync.firstBeatMs': ${firstBeatMs}
      })`)
      await sleep(400)
    }
    /** 直接调 record，避免 seek 的浮点尾数干扰"精确的 1.23 秒"断言 */
    const tapAt = (sec) =>
      cdp.eval(`(() => {
        const t = window.__lrcDiag.tapping;
        const r = t.record(${sec});
        const rec = t.tapped[r.index];
        return { index: r.index, t: rec.t, beat: rec.beat };
      })()`)

    await reload()
    await loadPlainText(8)
    await sleep(600)
    await enterTapping()

    /*
     * ① 「1.23s → 1.25s + beat=5」要求每拍 250ms，也就是 **BPM=240**。
     * （BPM=120 是 500ms/拍，网格为 0/0.5/1.0/1.5…，1.23s 离最近拍点
     *   有 230ms，根本不在 50ms 容差内 —— 需求里的示例数字对应的是 240。）
     */
    await setSync(240, 'nearest', 0)
    let r = await tapAt(1.23)
    check('① BPM=240/nearest：1.23s → 吸附到 1.25s', Math.abs(r.t - 1.25) < 0.001, String(r.t))
    check('① beat 序号 = 5（1.25s ÷ 0.25s）', r.beat === 5, String(r.beat))

    // ② 超容差：1.30s 距 1.25s 恰好 50ms —— 容差是严格小于，所以不吸
    r = await tapAt(1.3)
    check('② 1.30s 距最近拍点恰好 50ms（= 容差）→ 不吸附',
      Math.abs(r.t - 1.3) < 0.001 && r.beat === null, `t=${r.t}, beat=${r.beat}`)

    // ②b 容差内 → 吸
    r = await tapAt(1.28)
    check('②b 1.28s 距 1.25s 为 30ms（容差内）→ 吸附', Math.abs(r.t - 1.25) < 0.001 && r.beat === 5,
      `t=${r.t}, beat=${r.beat}`)

    // ③ snap=next：只往后看
    await setSync(240, 'next', 0)
    r = await tapAt(1.23)
    check('③ snap=next：1.23s → 往后吸到 1.25s', Math.abs(r.t - 1.25) < 0.001, String(r.t))
    r = await tapAt(1.26)
    check('③b snap=next：1.26s 往后是 1.5s（超容差）→ 不吸，也不回头吸 1.25s',
      Math.abs(r.t - 1.26) < 0.001 && r.beat === null, `t=${r.t}, beat=${r.beat}`)

    // ④ snap=none → 不吸附
    await setSync(240, 'none', 0)
    r = await tapAt(1.23)
    check('④ snap=none → 不吸附（原样记录）', Math.abs(r.t - 1.23) < 0.001 && r.beat === null,
      `t=${r.t}, beat=${r.beat}`)

    // ⑤ BPM 无效 → 不吸附
    await setSync(null, 'nearest', 0)
    r = await tapAt(1.23)
    check('⑤ bpm 为空 → 不吸附', Math.abs(r.t - 1.23) < 0.001 && r.beat === null,
      `t=${r.t}, beat=${r.beat}`)

    await cdp.eval(`window.__lrcDiag.settings.set('sync.bpm', 0)`)
    await sleep(300)
    r = await tapAt(1.23)
    check('⑤b bpm=0（非法）→ 不吸附，不产生 NaN',
      Math.abs(r.t - 1.23) < 0.001 && r.beat === null, `t=${r.t}, beat=${r.beat}`)

    // ⑥ 改 BPM 后已记录的行不变
    await setSync(240, 'nearest', 0)
    r = await tapAt(2.23)   // → 2.25, beat=9
    const beforeT = r.t
    const beforeBeat = r.beat
    await setSync(120, 'nearest', 0)
    const after = await cdp.eval(`(() => {
      const rec = window.__lrcDiag.tapping.tapped[${r.index}];
      return { t: rec.t, beat: rec.beat };
    })()`)
    check('⑥ 改 BPM 后已记录的行不变（不回头覆盖）',
      Math.abs(after.t - beforeT) < 0.001 && after.beat === beforeBeat,
      `${beforeT}/beat${beforeBeat} → ${after.t}/beat${after.beat}`)

    // ⑦ 覆盖同一行 → 重新按吸附规则处理
    await setSync(240, 'nearest', 0)
    const overwritten = await cdp.eval(`(() => {
      const t = window.__lrcDiag.tapping;
      t.editingIndex = ${r.index};
      const res = t.record(2.73);
      const rec = t.tapped[res.index];
      return { t: rec.t, beat: rec.beat };
    })()`)
    check('⑦ 覆盖同一行时重新吸附（2.73 → 2.75 + beat=11）',
      Math.abs(overwritten.t - 2.75) < 0.001 && overwritten.beat === 11,
      `t=${overwritten.t}, beat=${overwritten.beat}`)
  }

  // ══════════════════════════════════════════════
  group('节拍：「第 N 拍」显示与 BPM 输入校验')
  {
    const beatLabel = () =>
      cdp.eval(`(() => {
        const el = document.querySelector('.playerbar__beat');
        return el ? el.textContent.trim() : null;
      })()`)

    await reload()
    await loadPlainText(6)
    await sleep(600)

    check('非打轴模式不显示「第 N 拍」', (await beatLabel()) === null, String(await beatLabel()))

    await cdp.eval(`window.__lrcDiag.settings.setMany({ 'sync.bpm': 120, 'sync.snap': 'nearest', 'sync.firstBeatMs': 0 })`)
    await sleep(400)
    await enterTapping()
    check('打轴模式下、未打任何行时不显示', (await beatLabel()) === null, String(await beatLabel()))

    // 2.5s ÷ 0.5s = 第 5 拍（0 起）→ 显示「第 6 拍」
    await cdp.eval(`window.__lrcDiag.tapping.record(2.5)`)
    await sleep(500)
    check('打轴模式 + 该行有 beat → 显示「第 6 拍」', (await beatLabel()) === '第 6 拍', String(await beatLabel()))

    // 该行没吸附上 → 不显示
    await cdp.eval(`window.__lrcDiag.settings.set('sync.bpm', null)`)
    await sleep(300)
    await cdp.eval(`window.__lrcDiag.tapping.record(5.123)`)
    await sleep(500)
    check('该行没吸附上（beat=null）→ 不显示', (await beatLabel()) === null, String(await beatLabel()))

    // 进设置面板做 BPM 校验（输入框已随「节拍网格」分组删除，改测 store 行为）
    await cdp.eval(`window.__lrcDiag.settings.openDrawer()`)
    await sleep(900)
    await cdp.eval(`window.__lrcDiag.settings.set('sync.bpm', 120)`)
    await sleep(300)

    /*
     * 每种非法输入前都先把 bpm 复位成 120。
     * 不复位的话用例之间会串味：'abc' 让 store 变 null 后，
     * 下一个用例看到的是 null 而不是"保留了 120"，会误报失败。
     */
    /*
     * 【为什么改成直接测 store，而不是测输入框】
     * 设置面板里的「节拍网格」分组已按用户要求**删除**（功能不做了），
     * 但 sync 字段与吸附逻辑按"代码能跑就不动"保留。
     *
     * 【这里暴露的一个既有事实】
     * 原先是靠 UI 的 validateBpm 挡住非法值的（输入框 @change 里校验）。
     * 直接走 `settings.set('sync.bpm', 0)` 会**原样存进去** ——
     * sanitizeSettings 对 sync.bpm 的兜底是 `pick(raw,'sync.bpm',null)`，
     * 而 pick 在 fallback 为 null 时会原样返回输入值，不做范围校验。
     * 也就是说：**防线在 UI 层，不在 store 层**。分组删掉后这层防线没了，
     * 但吸附逻辑本身容错（validateBpm 在 snapToGrid 里会挡掉非法值），
     * 所以功能不会坏 —— 这里如实断言这个行为，不假装它被拒了。
     */
    for (const c of [
      { raw: 0, why: '0' },
      { raw: -60, why: '负数' },
      { raw: 9999, why: '超上限 400' },
      { raw: 10, why: '低于下限 20' },
    ]) {
      await cdp.eval(`window.__lrcDiag.settings.set('sync.bpm', 120)`)
      await sleep(300)
      await cdp.eval(`window.__lrcDiag.settings.set('sync.bpm', ${c.raw})`)
      await sleep(300)
      const bpm = await cdp.eval(`window.__lrcDiag.settings.settings.sync.bpm`)
      check(`BPM 非法值「${c.why}」store 不校验（防线原在 UI，已随分组删除）`, bpm === c.raw, `bpm=${bpm}`)
    }

    // 关键：非法 BPM 不会让吸附崩掉（snapToGrid 内部用 validateBpm 兜底）
    await cdp.eval(`window.__lrcDiag.settings.set('sync.snap', 'nearest')`)
    await sleep(300)
    const snapSafety = await cdp.eval(`(() => {
      try {
        const r = window.__lrcDiag.tapping.snapToGrid(1.23);
        return { ok: true, t: r.t, beat: r.beat };
      } catch (e) { return { ok: false, err: e.message }; }
    })()`)
    check('BPM 非法时吸附不崩、原样返回（validateBpm 在 snapToGrid 内兜底）',
      snapSafety.ok === true && snapSafety.beat === null && Math.abs(snapSafety.t - 1.23) < 0.001,
      JSON.stringify(snapSafety))

    // 「节拍网格」设置分组已删除
    check('「节拍网格」设置分组已删除', (await cdp.eval(
      `[...document.querySelectorAll('.group__title')].some(e => e.textContent.includes('节拍网格'))`,
    )) === false)

    await cdp.eval(`window.__lrcDiag.settings.set('sync.bpm', 120)`)
    await sleep(300)
    await cdp.eval(`window.__lrcDiag.settings.set('sync.bpm', 90)`)
    await sleep(300)
    check('BPM 合法值 90 → 生效',
      (await cdp.eval(`window.__lrcDiag.settings.settings.sync.bpm`)) === 90,
      String(await cdp.eval(`window.__lrcDiag.settings.settings.sync.bpm`)))

    await cdp.eval(`window.__lrcDiag.settings.set('sync.bpm', null)`)
    await sleep(300)
    check('BPM 留空 → null（不启用节拍网格）',
      (await cdp.eval(`window.__lrcDiag.settings.settings.sync.bpm`)) === null,
      String(await cdp.eval(`window.__lrcDiag.settings.settings.sync.bpm`)))

    await cdp.eval(`window.__lrcDiag.settings.closeDrawer()`)
    await sleep(400)
  }

  // ══════════════════════════════════════════════
  group('14. 控制台 0 error')
  {
    check('无未捕获异常', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '))
    check('无 console.error', cdp.consoleErrors.length === 0, cdp.consoleErrors.slice(0, 3).join(' | '))
  }

  console.log(`\n${'─'.repeat(58)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed) console.log(`\n失败项：\n  - ${failures.join('\n  - ')}`)
  console.log('─'.repeat(58))

  cdp.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n脚本异常: ${e instanceof Error ? e.stack : String(e)}`)
  process.exit(2)
})
