// @ts-check
/**
 * 拖动进度条回归测试（真实鼠标 / 真实触摸输入）。
 *
 * 覆盖用户要求的 4 项：
 *  A. 连续拖动 5 次，每次落点都正确
 *  B. 拖到 50% → 松手 → 20% → 松手 → 80%，三次都正确
 *  C. 拖动过程中暂停/播放状态切换，不影响落点
 *  D. 触摸设备与鼠标各测一遍
 *
 * 另外：
 *  E. 回归防护：pointercancel（无坐标）不得改变落点
 *  F. 回归防护：NaN 坐标不得让进度跳回 0
 *  G. 拖出元素外松手也能正确落点（监听器已挂到 window）
 *  H. 真实拖动过程中实际触发了哪些指针事件（把真相记录下来）
 *
 * 用法：node scripts/e2e-drag.mjs [页面URL] [调试端口]
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
      }, 40000)
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
  console.log(`\n拖动进度条回归 —— ${PAGE_URL}\n`)

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

  const loadAudio = `(async () => {
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
    return window.__lrcDiag.player.duration;
  })()`

  /** 重新载入页面并准备音频 */
  async function reset() {
    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(1200)
    await cdp.eval(`(() => { try { localStorage.clear(); localStorage.setItem('lrc-scroller:tutorial-seen:v1','1'); } catch (e) {} return true; })()`)
    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(2600)
    const dur = await cdp.eval(loadAudio)
    // 记录真实拖动过程中会触发哪些指针事件
    await cdp.eval(`(() => {
      if (window.__evLog) return true;
      window.__evLog = [];
      const el = document.querySelector('[role=slider][aria-label="播放进度"]');
      for (const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','gotpointercapture']) {
        el.addEventListener(type, (e) => {
          window.__evLog.push({ t: type, x: e.clientX, id: e.pointerId, btn: e.buttons });
        }, true);
        window.addEventListener(type, (e) => {
          if (e.target !== el) window.__evLog.push({ t: 'win:' + type, x: e.clientX, id: e.pointerId, btn: e.buttons });
        }, true);
      }
      return true;
    })()`)
    return dur
  }

  const boxOf = () =>
    cdp.eval(`(() => {
      const r = document.querySelector('[role=slider][aria-label="播放进度"]').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, cy: r.top + r.height / 2 };
    })()`)

  const stateOf = () =>
    cdp.eval(`(() => {
      const d = window.__lrcDiag;
      return {
        t: Number(d.player.currentTime.toFixed(3)),
        dur: Number(d.player.duration.toFixed(2)),
        playing: d.player.playing,
        scrubbing: d.engine.diagnostics.scrubbing,
      };
    })()`)

  /** 鼠标拖动（可选：松手位置在元素外） */
  async function dragMouse(box, fromRatio, toRatio, { releaseOutside = false, steps = 5 } = {}) {
    // fromRatio 允许省略：默认从当前位置对应的比例起步
    const from =
      typeof fromRatio === 'number' && Number.isFinite(fromRatio)
        ? fromRatio
        : Math.min(1, Math.max(0, (await stateOf()).t / (await stateOf()).dur))
    const x0 = box.left + box.width * from
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
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: x1,
      y: releaseOutside ? box.top - 80 : y,
      button: 'left',
      clickCount: 1,
      buttons: 0,
    })
    await sleep(320)
  }

  /** 触摸拖动 */
  async function dragTouch(box, fromRatio, toRatio, { steps = 5 } = {}) {
    const x0 = box.left + box.width * fromRatio
    const x1 = box.left + box.width * toRatio
    const y = box.cy
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] })
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x0 + ((x1 - x0) * i) / steps, y }],
      })
      await sleep(20)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(320)
  }

  const tol = 1.6 // 允许 1.6 秒误差（约占 60 秒的 2.7%，覆盖键盘/亚像素差异）

  // ══════════════════════════════════════════════
  group('A. 连续拖动 5 次，每次落点都正确（鼠标）')
  {
    const dur = await reset()
    const box = await boxOf()
    const targets = [0.2, 0.5, 0.8, 0.35, 0.65]
    let allOk = true
    const results = []
    for (let i = 0; i < targets.length; i++) {
      await dragMouse(box, i === 0 ? 0.05 : targets[i - 1], targets[i])
      const st = await stateOf()
      const expect = dur * targets[i]
      const ok = Math.abs(st.t - expect) < tol
      if (!ok) allOk = false
      results.push(`${(targets[i] * 100).toFixed(0)}%→${st.t}s${ok ? '' : '✗'}`)
      check(
        `第 ${i + 1} 次拖到 ${(targets[i] * 100).toFixed(0)}%（期望 ${expect.toFixed(1)}s）`,
        ok,
        `实际 ${st.t}s`,
      )
    }
    console.log(`      落点序列: ${results.join('  ')}`)
    check('连续 5 次全部正确（无回滚到 0）', allOk)
    const st = await stateOf()
    check('结束后 scrubbing 已复位', st.scrubbing === false, `scrubbing=${st.scrubbing}`)

    // 真实事件日志：看清楚浏览器到底发了什么
    const evLog = await cdp.eval(`window.__evLog ? window.__evLog.slice(-20) : []`)
    const types = [...new Set(evLog.map((e) => e.t))]
    console.log(`      真实指针事件类型: ${types.join(', ')}`)
  }

  // ══════════════════════════════════════════════
  group('B. 50% → 20% → 80% 三次都正确（鼠标）')
  {
    const dur = await reset()
    const box = await boxOf()
    const seq = [0.5, 0.2, 0.8]
    for (const r of seq) {
      // 起点省略 → 自动从"当前播放位置"起步，模拟用户连续操作的实际情况
      await dragMouse(box, undefined, r)
      const st = await stateOf()
      const expect = dur * r
      check(`拖到 ${(r * 100).toFixed(0)}%（期望 ${expect.toFixed(1)}s）`, Math.abs(st.t - expect) < tol, `实际 ${st.t}s`)
    }
  }

  // ══════════════════════════════════════════════
  group('C. 拖动过程中暂停/播放状态切换，不影响落点')
  {
    const dur = await reset()
    const box = await boxOf()

    // C1：播放中 → 拖动中暂停 → 松手
    await cdp.eval(`document.querySelector('.playerbar__play').click()`) // 开始播放
    await sleep(600)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.left + box.width * 0.15,
      y: box.cy,
      button: 'left',
      clickCount: 1,
      buttons: 1,
    })
    await sleep(60)
    await cdp.eval(`document.querySelector('.playerbar__play').click()`) // 拖动中暂停
    await sleep(60)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: box.left + box.width * 0.6,
      y: box.cy,
      button: 'left',
      buttons: 1,
    })
    await sleep(60)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.left + box.width * 0.6,
      y: box.cy,
      button: 'left',
      clickCount: 1,
      buttons: 0,
    })
    await sleep(400)
    let st = await stateOf()
    check(
      '拖动中暂停 → 落点为 60%',
      Math.abs(st.t - dur * 0.6) < tol,
      `实际 ${st.t}s（期望 ${(dur * 0.6).toFixed(1)}s）`,
    )

    // C2：暂停中 → 拖动中开始播放 → 松手
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.left + box.width * 0.7,
      y: box.cy,
      button: 'left',
      clickCount: 1,
      buttons: 1,
    })
    await sleep(60)
    await cdp.eval(`document.querySelector('.playerbar__play').click()`) // 拖动中开始播放
    await sleep(60)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: box.left + box.width * 0.25,
      y: box.cy,
      button: 'left',
      buttons: 1,
    })
    await sleep(60)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.left + box.width * 0.25,
      y: box.cy,
      button: 'left',
      clickCount: 1,
      buttons: 0,
    })
    await sleep(500)
    st = await stateOf()
    check(
      '拖动中开始播放 → 落点为 25%',
      Math.abs(st.t - dur * 0.25) < tol + 0.8,
      `实际 ${st.t}s（期望约 ${(dur * 0.25).toFixed(1)}s，播放中会略前进）`,
    )
    check('播放状态确实被切换为播放中', st.playing === true, `playing=${st.playing}`)
    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(200)
  }

  // ══════════════════════════════════════════════
  group('D. 触摸设备拖动')
  {
    const dur = await reset()
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await sleep(500)
    const box = await boxOf()

    await dragTouch(box, 0.1, 0.5)
    let st = await stateOf()
    check('触摸拖到 50%', Math.abs(st.t - dur * 0.5) < tol, `实际 ${st.t}s`)

    await dragTouch(box, 0.5, 0.2)
    st = await stateOf()
    check('触摸再拖到 20%', Math.abs(st.t - dur * 0.2) < tol, `实际 ${st.t}s`)

    await dragTouch(box, 0.2, 0.8)
    st = await stateOf()
    check('触摸第三次拖到 80%', Math.abs(st.t - dur * 0.8) < tol, `实际 ${st.t}s`)

    const evLog = await cdp.eval(`window.__evLog ? window.__evLog.filter(e => e.t.includes('pointer')).slice(-12) : []`)
    const types = [...new Set(evLog.map((e) => e.t))]
    console.log(`      触摸拖动触发的指针事件: ${types.join(', ') || '(无)'}`)

    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await sleep(300)
  }

  // ══════════════════════════════════════════════
  group('E. 回归防护：pointercancel（无坐标）不得改变落点')
  {
    const dur = await reset()
    const box = await boxOf()
    const r = await cdp.eval(`(async () => {
      const el = document.querySelector('[role=slider][aria-label="播放进度"]');
      const rect = el.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerId:11, pointerType:'mouse', clientX: rect.left + rect.width*0.05, clientY: y, buttons:1 }));
      await new Promise(x=>setTimeout(x,50));
      el.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, cancelable:true, pointerId:11, pointerType:'mouse', clientX: rect.left + rect.width*0.65, clientY: y, buttons:1 }));
      await new Promise(x=>setTimeout(x,60));
      const peak = Number(window.__lrcDiag.player.currentTime.toFixed(3));
      // 真实浏览器的 pointercancel 不带有效坐标（clientX=0）
      el.dispatchEvent(new PointerEvent('pointercancel', { bubbles:true, cancelable:true, pointerId:11, pointerType:'touch', clientX:0, clientY:0, buttons:0 }));
      await new Promise(x=>setTimeout(x,350));
      return { peak, after: Number(window.__lrcDiag.player.currentTime.toFixed(3)) };
    })()`)
    check('pointercancel 后时间不跳回 0', r.after > 1, `peak=${r.peak}s → after=${r.after}s`)
    check('pointercancel 后落点保持（约 65%）', Math.abs(r.after - dur * 0.65) < tol, `实际 ${r.after}s`)
    const st = await stateOf()
    check('pointercancel 后 scrubbing 已复位', st.scrubbing === false, `scrubbing=${st.scrubbing}`)
  }

  // ══════════════════════════════════════════════
  group('F. 回归防护：NaN 坐标不得让进度跳回 0')
  {
    const dur = await reset()
    const r = await cdp.eval(`(async () => {
      const el = document.querySelector('[role=slider][aria-label="播放进度"]');
      const rect = el.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, pointerId:12, pointerType:'mouse', clientX: rect.left + rect.width*0.45, clientY: y, buttons:1 }));
      await new Promise(x=>setTimeout(x,60));
      const mid = Number(window.__lrcDiag.player.currentTime.toFixed(3));
      const up = new PointerEvent('pointerup', { bubbles:true, cancelable:true, pointerId:12, pointerType:'mouse' });
      Object.defineProperty(up, 'clientX', { value: NaN });
      el.dispatchEvent(up);
      await new Promise(x=>setTimeout(x,350));
      return { mid, after: Number(window.__lrcDiag.player.currentTime.toFixed(3)) };
    })()`)
    check('clientX=NaN 的 pointerup 不让时间跳回 0', r.after > 1, `mid=${r.mid}s → after=${r.after}s`)
    check('NaN 时沿用当前落点（约 45%）', Math.abs(r.after - dur * 0.45) < tol, `实际 ${r.after}s`)
  }

  // ══════════════════════════════════════════════
  group('G. 拖出元素外松手也能正确落点')
  {
    const dur = await reset()
    const box = await boxOf()
    await dragMouse(box, 0.1, 0.7, { releaseOutside: true })
    const st = await stateOf()
    check(
      '松手在元素外 → 落点仍为 70%',
      Math.abs(st.t - dur * 0.7) < tol,
      `实际 ${st.t}s（期望 ${(dur * 0.7).toFixed(1)}s）`,
    )
    check('结束后 scrubbing 复位（监听器无残留）', st.scrubbing === false, `scrubbing=${st.scrubbing}`)

    // 紧接着再拖一次，验证没有被上一次的残留监听干扰
    await dragMouse(box, 0.7, 0.3)
    const st2 = await stateOf()
    check('紧接着再拖到 30% 仍正确', Math.abs(st2.t - dur * 0.3) < tol, `实际 ${st2.t}s`)
  }

  // ══════════════════════════════════════════════
  group('H. 全程无异常')
  {
    check('无未捕获异常', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '))
  }

  console.log(`\n${'─'.repeat(54)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed) console.log(`\n失败项：\n  - ${failures.join('\n  - ')}`)
  console.log('─'.repeat(54))

  cdp.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n脚本异常: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
})
