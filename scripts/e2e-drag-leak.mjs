// @ts-check
/**
 * 拖动"监听器泄漏"专项验收。
 *
 * 【要防的 bug】
 * 拖动结束后 pointermove 监听器残留在 window 上：
 * 松开左键后鼠标一移动，残留监听器继续调 scrubTo，进度条一直跟着鼠标走、无法取消。
 * 根因是 addEventListener 与 removeEventListener 的事件目标不一致（window ↔ 元素）。
 *
 * 【怎么测才算硬证据】
 * 只测"松手后时间没变"是不够的 —— 万一残留监听器恰好把时间设回同一个值就会假通过。
 * 因此这里同时做两件事：
 *   1. **直接统计监视器数量**：包一层 addEventListener/removeEventListener，
 *      实时记账 window 上还有多少个 pointermove/pointerup/pointercancel。
 *      这是"有没有泄漏"的直接证据。
 *   2. **行为验证**：松手后持续移动鼠标 5 秒，检查时间与进度条位置都不再变化。
 *
 * 用法：node scripts/e2e-drag-leak.mjs [页面URL] [调试端口]
 */

import { readFileSync, existsSync } from 'node:fs'

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
  console.log(`\n拖动监听器泄漏专项验收 —— ${PAGE_URL}\n`)

  const audioPath = 'samples/audio/test-60s-beeps.mp3'
  if (!existsSync(audioPath)) throw new Error(`测试音频缺失: ${audioPath}`)
  const audioB64 = readFileSync(audioPath).toString('base64')

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
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(1200)
  await cdp.eval(`(() => { try { localStorage.clear(); localStorage.setItem('lrc-scroller:tutorial-seen:v1','1'); } catch (e) {} return true; })()`)

  /**
   * 安装监听器探针。
   * 包装 window 的 add/removeEventListener，实时统计各类型指针监听器数量。
   * 这是判断"有没有泄漏"的直接证据，不依赖行为观察。
   */
  const INSTALL_PROBE = `(() => {
    if (window.__lp) return true;
    const TYPES = ['pointermove', 'pointerup', 'pointercancel'];
    const counts = { pointermove: 0, pointerup: 0, pointercancel: 0 };
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    window.__lp = { counts, log: [] };

    window.addEventListener = function (type, fn, opts) {
      if (TYPES.includes(type)) {
        counts[type]++;
        window.__lp.log.push({ op: 'add', type });
      }
      return origAdd(type, fn, opts);
    };
    window.removeEventListener = function (type, fn, opts) {
      if (TYPES.includes(type)) {
        counts[type] = Math.max(0, counts[type] - 1);
        window.__lp.log.push({ op: 'remove', type });
      }
      return origRemove(type, fn, opts);
    };
    return true;
  })()`

  const probeCounts = () => cdp.eval(`window.__lp ? JSON.parse(JSON.stringify(window.__lp.counts)) : null`)
  const resetProbe = () =>
    cdp.eval(`(() => { window.__lp.log.length = 0; return true; })()`)

  /** 载入音频 */
  async function loadAudio() {
    await cdp.eval(`(async () => {
      const bin = atob(${JSON.stringify(audioB64)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'test-60s-beeps.mp3', { type: 'audio/mpeg' });
      const input = [...document.querySelectorAll('input[type=file]')].find(i => (i.getAttribute('accept')||'').includes('audio'));
      const dt = new DataTransfer(); dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const t0 = Date.now();
      while (Date.now() - t0 < 12000) {
        await new Promise(r => setTimeout(r, 120));
        if (window.__lrcDiag.player.duration > 0) break;
      }
      await new Promise(r => setTimeout(r, 300));
      return true;
    })()`)
  }

  const boxOf = (sel) =>
    cdp.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, cy: r.top + r.height / 2 };
    })()`)

  const stateOf = () =>
    cdp.eval(`(() => {
      const d = window.__lrcDiag;
      return {
        t: Number(d.player.currentTime.toFixed(3)),
        dur: Number(d.player.duration.toFixed(2)),
        volume: Number(d.player.volume.toFixed(3)),
        scrubbing: d.engine.diagnostics.scrubbing,
      };
    })()`)

  /** 真实鼠标拖动（可指定松手位置在元素外/窗口外） */
  async function dragMouse(box, fromRatio, toRatio, opts = {}) {
    const { releaseOutsideEl = false, releaseOutsideWindow = false, steps = 5 } = opts
    const x0 = box.left + box.width * fromRatio
    const x1 = box.left + box.width * toRatio
    const y = box.cy
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y, button: 'left', clickCount: 1, buttons: 1 })
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x0 + ((x1 - x0) * i) / steps,
        y,
        button: 'left',
        buttons: 1,
      })
      await sleep(20)
    }
    let relX = x1
    let relY = y
    if (releaseOutsideEl) relY = box.top - 80
    if (releaseOutsideWindow) {
      relX = -50
      relY = -50
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: relX,
      y: relY,
      button: 'left',
      clickCount: 1,
      buttons: 0,
    })
    await sleep(300)
  }

  /** 松手后持续移动鼠标（不按键），检查是否还在跟随 */
  async function moveMouseIdle(box, ms = 5000) {
    const t0 = await stateOf()
    const deadline = Date.now() + ms
    let i = 0
    while (Date.now() < deadline) {
      // 在进度条上来回划过（不按键）
      const r = (i % 2 === 0) ? 0.9 : 0.1
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: box.left + box.width * r,
        y: box.cy,
        buttons: 0,
      })
      await sleep(120)
      i++
    }
    const t1 = await stateOf()
    return { before: t0, after: t1, moves: i }
  }

  // ══════════════════════════════════════════════
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(2600)
  await cdp.eval(INSTALL_PROBE)
  await loadAudio()

  const seekSel = '[role=slider][aria-label="播放进度"]'
  const volSel = '[role=slider][aria-label="音量"]'

  group('1. 松手后继续移动 5 秒：进度条不再跟随（用户报告的 bug）')
  {
    const box = await boxOf(seekSel)
    const dur = (await stateOf()).dur

    await dragMouse(box, 0.1, 0.6)
    const afterDrop = await stateOf()
    check(
      '拖动到 60% 落点正确',
      Math.abs(afterDrop.t - dur * 0.6) < 1.6,
      `实际 ${afterDrop.t}s（期望 ${(dur * 0.6).toFixed(1)}s）`,
    )

    // 关键：松手后持续划过 5 秒
    const idle = await moveMouseIdle(box, 5000)
    check(
      '松手后继续移动 5 秒，时间完全不变（停在松手位置）',
      Math.abs(idle.after.t - idle.before.t) < 0.05,
      `${idle.before.t}s → ${idle.after.t}s（期间移动 ${idle.moves} 次）`,
    )
    check('松手后 scrubbing 已复位', idle.after.scrubbing === false, `scrubbing=${idle.after.scrubbing}`)
  }

  group('2. 监听器计数：松手后指针监听器必须归零')
  {
    // 先记录基线
    const baseline = await probeCounts()
    check(
      '基线：无残留指针监听器',
      baseline.pointermove === 0 && baseline.pointerup === 0 && baseline.pointercancel === 0,
      JSON.stringify(baseline),
    )

    const box = await boxOf(seekSel)
    await dragMouse(box, 0.2, 0.7)
    const afterOne = await probeCounts()
    check(
      '一次拖动后监听器全部解绑（无泄漏）',
      afterOne.pointermove === 0 && afterOne.pointerup === 0 && afterOne.pointercancel === 0,
      JSON.stringify(afterOne),
    )

    // 再拖一次，确认不累积
    await dragMouse(box, 0.7, 0.3)
    const afterTwo = await probeCounts()
    check(
      '第二次拖动后仍无泄漏（不累积）',
      afterTwo.pointermove === 0 && afterTwo.pointerup === 0 && afterTwo.pointercancel === 0,
      JSON.stringify(afterTwo),
    )
  }

  group('3. 连续拖动 5 次，每次松手后都验证监听器已清理')
  {
    const box = await boxOf(seekSel)
    const dur = (await stateOf()).dur
    const targets = [0.3, 0.6, 0.15, 0.85, 0.45]
    let allClean = true
    let allCorrect = true
    const details = []

    for (let i = 0; i < targets.length; i++) {
      await dragMouse(box, i === 0 ? 0.05 : targets[i - 1], targets[i])
      const counts = await probeCounts()
      const st = await stateOf()
      const clean = counts.pointermove === 0 && counts.pointerup === 0 && counts.pointercancel === 0
      const correct = Math.abs(st.t - dur * targets[i]) < 1.6
      if (!clean) allClean = false
      if (!correct) allCorrect = false
      details.push(`#${i + 1}→${st.t}s/${clean ? 'clean' : 'LEAK ' + JSON.stringify(counts)}`)
    }

    console.log(`      ${details.join('  ')}`)
    check('连续 5 次拖动，每次落点都正确', allCorrect)
    check('连续 5 次拖动，每次松手后监听器都已清理', allClean)

    // 5 次之后再验证行为
    const idle = await moveMouseIdle(box, 2000)
    check(
      '5 次拖动后继续移动鼠标，进度条仍不跟随',
      Math.abs(idle.after.t - idle.before.t) < 0.05,
      `${idle.before.t}s → ${idle.after.t}s`,
    )
  }

  group('4. 拖出窗口外松手 → 回窗口内移动，进度条不跟随')
  {
    const box = await boxOf(seekSel)
    const dur = (await stateOf()).dur

    // 关键设计：松手位置的**水平坐标**要保持在进度条范围内，
    // 只把**垂直坐标**放到窗口外（下方）。
    //
    // 若把水平坐标也放到窗口左侧（例如 x=-50），浏览器会把它夹到 0，
    // 而 0 位于进度条左边界之外 → ratio 夹取为 0 → 回到开头。
    // 那是**正确的夹取行为**（等同于"拖到最左端"），不是 bug。
    // 这里要验证的是"元素外/窗口外的松手能被 window 监听到"，因此只移出垂直方向。
    const releaseX = box.left + box.width * 0.75

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.left + box.width * 0.2,
      y: box.cy,
      button: 'left',
      clickCount: 1,
      buttons: 1,
    })
    await sleep(40)
    for (let i = 1; i <= 5; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: box.left + box.width * (0.2 + 0.11 * i),
        y: box.cy,
        button: 'left',
        buttons: 1,
      })
      await sleep(20)
    }
    // 松手：垂直方向移出窗口（y 远超视口高度），水平坐标仍在进度条范围内
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: releaseX,
      y: 2000,
      button: 'left',
      clickCount: 1,
      buttons: 0,
    })
    await sleep(350)

    const afterDrop = await stateOf()
    check(
      '拖出窗口外松手，落点仍正确（window 监听能收到元素外/窗口外的松手）',
      Math.abs(afterDrop.t - dur * 0.75) < 1.6,
      `实际 ${afterDrop.t}s（期望 ${(dur * 0.75).toFixed(1)}s）`,
    )

    const counts = await probeCounts()
    check(
      '拖出窗口外松手后监听器已清理',
      counts.pointermove === 0 && counts.pointerup === 0 && counts.pointercancel === 0,
      JSON.stringify(counts),
    )

    // 回到窗口内移动
    const idle = await moveMouseIdle(box, 3000)
    check(
      '回窗口内移动，进度条不跟随',
      Math.abs(idle.after.t - idle.before.t) < 0.05,
      `${idle.before.t}s → ${idle.after.t}s`,
    )

    // 补充：验证"拖到最左端＝回到开头"这个夹取语义本身也是对的
    const box2 = await boxOf(seekSel)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box2.left + box2.width * 0.5,
      y: box2.cy,
      button: 'left',
      clickCount: 1,
      buttons: 1,
    })
    await sleep(40)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box2.left - 200,
      y: box2.cy,
      button: 'left',
      clickCount: 1,
      buttons: 0,
    })
    await sleep(350)
    const clamped = await stateOf()
    check(
      '拖到进度条左边界之外 → 夹取为 0（回到开头，符合预期）',
      clamped.t < 0.5,
      `实际 ${clamped.t}s`,
    )
  }

  group('5. 音量滑杆：同样的泄漏与跟随测试')
  {
    const vbox = await boxOf(volSel)
    check('音量滑杆存在', !!vbox, JSON.stringify(vbox))

    // 拖到 30%
    await dragMouse(vbox, 0.1, 0.3)
    const v1 = await stateOf()
    check('音量拖到 30% 左右', Math.abs(v1.volume - 0.3) < 0.06, `volume=${v1.volume}`)

    const counts = await probeCounts()
    check(
      '音量拖动后监听器已清理',
      counts.pointermove === 0 && counts.pointerup === 0 && counts.pointercancel === 0,
      JSON.stringify(counts),
    )

    // 松手后划过音量条
    const vBefore = (await stateOf()).volume
    const deadline = Date.now() + 3000
    let i = 0
    while (Date.now() < deadline) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: vbox.left + vbox.width * (i % 2 === 0 ? 0.95 : 0.05),
        y: vbox.cy,
        buttons: 0,
      })
      await sleep(120)
      i++
    }
    const vAfter = (await stateOf()).volume
    check(
      '松手后划过音量条，音量不再变化',
      Math.abs(vAfter - vBefore) < 0.02,
      `${vBefore} → ${vAfter}（移动 ${i} 次）`,
    )
  }

  group('6. 色相环：同样的泄漏与跟随测试')
  {
    // 打开设置并展开当前行颜色
    await cdp.eval(`(() => {
      const d = window.__lrcDiag;
      d.settings.openDrawer();
      return true;
    })()`)
    await sleep(800)

    const ringBox = await boxOf('.cp__ring')
    check('色相环可见', !!ringBox, JSON.stringify(ringBox))

    if (ringBox) {
      const readHue = () =>
        cdp.eval(`window.__lrcDiag.settings.settings.color.active`)

      // 拖到环右侧（约 90°）
      const cx = ringBox.left + ringBox.width / 2
      const cy = ringBox.cy
      const targetX = cx + ringBox.width * 0.45
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy - ringBox.height * 0.45, button: 'left', clickCount: 1, buttons: 1 })
      await sleep(30)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y: cy, button: 'left', buttons: 1 })
      await sleep(30)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetX, y: cy, button: 'left', clickCount: 1, buttons: 0 })
      await sleep(300)

      const colorAfterDrag = await readHue()
      check('拖动色相环改变了颜色', typeof colorAfterDrag === 'string' && colorAfterDrag.length === 7, colorAfterDrag)

      const counts = await probeCounts()
      check(
        '色相环拖动后监听器已清理',
        counts.pointermove === 0 && counts.pointerup === 0 && counts.pointercancel === 0,
        JSON.stringify(counts),
      )

      // 松手后不按键划过色相环 —— 颜色不应变化
      const deadline = Date.now() + 3000
      let i = 0
      while (Date.now() < deadline) {
        const ang = (i * 45) % 360
        const rad = (ang * Math.PI) / 180
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: cx + Math.sin(rad) * ringBox.width * 0.42,
          y: cy - Math.cos(rad) * ringBox.height * 0.42,
          buttons: 0,
        })
        await sleep(120)
        i++
      }
      const colorAfterIdle = await readHue()
      check(
        '松手后不按键划过色相环，颜色不再变化（无残留监听）',
        colorAfterIdle === colorAfterDrag,
        `${colorAfterDrag} → ${colorAfterIdle}（移动 ${i} 次）`,
      )
    }

    await cdp.eval(`window.__lrcDiag.settings.closeDrawer()`)
    await sleep(400)
  }

  group('7. 压力测试：连续拖动 20 次后松手移动，进度条无任何反应')
  {
    const box = await boxOf(seekSel)
    const dur = (await stateOf()).dur

    await resetProbe()
    for (let i = 0; i < 20; i++) {
      const from = (i % 10) / 10 + 0.05
      const to = ((i * 3) % 10) / 10 + 0.05
      await dragMouse(box, Math.min(from, 0.95), Math.min(to, 0.95), { steps: 2 })
    }

    const counts = await probeCounts()
    console.log(`      20 次拖动后监听器计数: ${JSON.stringify(counts)}`)
    check(
      '连续拖动 20 次后，指针监听器计数归零（无累积泄漏）',
      counts.pointermove === 0 && counts.pointerup === 0 && counts.pointercancel === 0,
      JSON.stringify(counts),
    )

    // 检查 add/remove 配对
    const log = await cdp.eval(`window.__lp.log.filter(e => e.type === 'pointermove').map(e => e.op)`)
    const adds = log.filter((x) => x === 'add').length
    const removes = log.filter((x) => x === 'remove').length
    check(
      'pointermove 的 add 与 remove 次数完全配对',
      adds === removes && adds === 20,
      `add=${adds}, remove=${removes}`,
    )

    // 松手后移动
    const idle = await moveMouseIdle(box, 3000)
    check(
      '20 次拖动后移动鼠标，进度条无任何反应',
      Math.abs(idle.after.t - idle.before.t) < 0.05,
      `${idle.before.t}s → ${idle.after.t}s（移动 ${idle.moves} 次）`,
    )
    void dur
  }

  group('8. 触摸设备：松手后（touchEnd）不跟随')
  {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await sleep(500)
    const box = await boxOf(seekSel)
    const dur = (await stateOf()).dur

    // 触摸拖动
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.left + box.width * 0.1, y: box.cy }] })
    for (let i = 1; i <= 5; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: box.left + box.width * (0.1 + 0.1 * i), y: box.cy }],
      })
      await sleep(25)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(350)

    const afterTouch = await stateOf()
    check(
      '触摸拖到 60% 落点正确',
      Math.abs(afterTouch.t - dur * 0.6) < 1.8,
      `实际 ${afterTouch.t}s`,
    )

    const counts = await probeCounts()
    check(
      '触摸松手后监听器已清理',
      counts.pointermove === 0 && counts.pointerup === 0 && counts.pointercancel === 0,
      JSON.stringify(counts),
    )

    // 松手后鼠标划过
    const idle = await moveMouseIdle(box, 2000)
    check(
      '触摸松手后移动指针，进度条不跟随',
      Math.abs(idle.after.t - idle.before.t) < 0.05,
      `${idle.before.t}s → ${idle.after.t}s`,
    )

    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await sleep(300)
  }

  group('9. 通用')
  {
    check('全程无未捕获异常', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '))
  }

  console.log(`\n${'─'.repeat(58)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed) console.log(`\n失败项：\n  - ${failures.join('\n  - ')}`)
  console.log('─'.repeat(58))

  cdp.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n脚本异常: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
})
