// @ts-check
/**
 * 三种指针类型的拖动验收（鼠标 / 笔 / 触摸）。
 *
 * 【为什么要分三种指针类型】
 * 用户实测：真机**鼠标**下"第一次拖动正常、之后再也拖不动"，
 * 而**数位板（笔）完全正常**。这个对比直接指向指针捕获相关行为。
 * 因此测试必须显式覆盖三种 pointerType，不能只用默认（mouse）。
 *
 * 【关于 CDP 的指针类型 —— 重要说明】
 * `Input.dispatchMouseEvent` 的 `pointerType` 参数支持 'mouse' | 'pen'，
 * 实测默认值为 **'mouse'**（脚本会先把这一点断言出来）。
 * 触摸走 `Input.dispatchTouchEvent`。
 *
 * ⚠️ 已知局限（必须诚实记录）：
 * CDP 合成事件**没有忠实还原真机鼠标的隐式捕获路径** ——
 * 移除 setPointerCapture 之前，我尝试了 10 种变体（连续拖、停顿、
 * 松手在元素外、他处单击后再拖、播放中拖、pen 对照…）**全部通过**，
 * 无法复现真机鼠标的问题。所以本套件能保证"三种类型的拖动逻辑都正确、
 * 无监听器泄漏、无捕获残留"，但**不能替代你在真机鼠标上的复验**。
 *
 * 用法：node scripts/e2e-pointer-types.mjs [页面URL] [调试端口]
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
  console.log(`\n三种指针类型拖动验收 —— ${PAGE_URL}\n`)

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

  /**
   * 安装探针：
   *  1. 记录每次 pointerdown 的真实 pointerType（验证测试用的类型确实生效）
   *  2. 统计 window 上的指针监听器数量（泄漏检测）
   *  3. 统计所有元素的捕获残留（hasPointerCapture）
   */
  const INSTALL = `(() => {
    if (window.__pt) return true;
    window.__pt = { downTypes: [], counts: { pointermove: 0, pointerup: 0, pointercancel: 0 }, moves: 0 };
    const TYPES = ['pointermove', 'pointerup', 'pointercancel'];
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    window.addEventListener = function (type, fn, opts) {
      if (TYPES.includes(type)) window.__pt.counts[type]++;
      return origAdd(type, fn, opts);
    };
    window.removeEventListener = function (type, fn, opts) {
      if (TYPES.includes(type)) window.__pt.counts[type] = Math.max(0, window.__pt.counts[type] - 1);
      return origRemove(type, fn, opts);
    };
    // 捕获阶段记录 pointerdown 的真实类型
    origAdd('pointerdown', (e) => {
      window.__pt.downTypes.push({ ptype: e.pointerType, id: e.pointerId, target: e.target?.getAttribute?.('aria-label') || e.target?.className?.toString?.().slice(0,24) || e.target?.tagName });
    }, true);
    origAdd('pointermove', () => { window.__pt.moves++; }, true);
    return true;
  })()`

  const resetProbe = () =>
    cdp.eval(`(() => { window.__pt.downTypes.length = 0; window.__pt.moves = 0; return true; })()`)
  const probeCounts = () => cdp.eval(`JSON.parse(JSON.stringify(window.__pt.counts))`)
  const downTypes = () => cdp.eval(`JSON.parse(JSON.stringify(window.__pt.downTypes))`)
  const captureResidue = () =>
    cdp.eval(`[...document.querySelectorAll('*')].filter(el => el.hasPointerCapture && el.hasPointerCapture(1)).map(el => el.className?.toString?.().slice(0,40) || el.tagName)`)

  async function loadAudio() {
    // 注意：必须 return —— 少了它 dur 会是 undefined，
    // 所有 `Math.abs(t - dur * r)` 断言都会退化成 NaN 比较而恒为 false，
    // 表现为"落点全都不对"，但其实落点是对的（实测值都正确）。
    return cdp.eval(`(async () => {
      const bin = atob(${JSON.stringify(audioB64)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'test-60s-beeps.mp3', { type: 'audio/mpeg' });
      const input = [...document.querySelectorAll('input[type=file]')].find(i => (i.getAttribute('accept')||'').includes('audio'));
      const dt = new DataTransfer(); dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const t0 = Date.now();
      while (Date.now() - t0 < 12000) { await new Promise(r => setTimeout(r, 120)); if (window.__lrcDiag.player.duration > 0) break; }
      await new Promise(r => setTimeout(r, 300));
      return window.__lrcDiag.player.duration;
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
      return { t: Number(d.player.currentTime.toFixed(2)), dur: Number(d.player.duration.toFixed(2)), volume: Number(d.player.volume.toFixed(3)) };
    })()`)

  // ── 三种指针类型的拖动实现 ──

  /** 鼠标 / 笔：都用 Input.dispatchMouseEvent，靠 pointerType 区分 */
  async function dragMouseLike(box, fromRatio, toRatio, { pointerType = 'mouse', releaseAt = null, steps = 4 } = {}) {
    const x0 = box.left + box.width * fromRatio
    const x1 = box.left + box.width * toRatio
    const y = box.cy
    const base = { pointerType }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y, button: 'left', clickCount: 1, buttons: 1, ...base })
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / steps, y, button: 'left', buttons: 1, ...base })
      await sleep(20)
    }
    const rp = releaseAt ?? { x: x1, y }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rp.x, y: rp.y, button: 'left', clickCount: 1, buttons: 0, ...base })
    await sleep(320)
  }

  /** 触摸 */
  async function dragTouch(box, toRatio, { fromRatio = 0.1, steps = 4, releaseOutside = false } = {}) {
    const x0 = box.left + box.width * fromRatio
    const y = box.cy
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] })
    for (let i = 1; i <= steps; i++) {
      const x = x0 + ((box.left + box.width * toRatio - x0) * i) / steps
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
      await sleep(20)
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
      ...(releaseOutside ? {} : {}),
    })
    await sleep(320)
  }

  /** 松手后划过（验证不再跟随） */
  async function idleSwipe(box, ms = 1500, pointerType = 'mouse') {
    const before = await stateOf()
    const deadline = Date.now() + ms
    let i = 0
    while (Date.now() < deadline) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: box.left + box.width * (i % 2 === 0 ? 0.92 : 0.08),
        y: box.cy,
        buttons: 0,
        pointerType,
      })
      await sleep(110)
      i++
    }
    const after = await stateOf()
    return { before, after, moves: i }
  }

  // ══════════════════════════════════════════════
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(1200)
  await cdp.eval(`(() => { try { localStorage.clear(); localStorage.setItem('lrc-scroller:tutorial-seen:v1','1'); } catch (e) {} return true; })()`)
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(2600)
  await cdp.eval(INSTALL)
  const dur = await loadAudio()
  // 显式校验：若时长拿不到（例如加载失败），立即报错退出。
  // 否则后面所有 `dur * ratio` 都会变成 NaN，断言恒为 false，
  // 表现为"落点全都不对"—— 会被误判成功能 bug。这个坑我踩过一次。
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error(`音频时长未取到（dur=${dur}），测试无法继续：请检查音频文件与加载流程`)
  }
  console.log(`音频时长 ${dur}s`)

  const seekSel = '[role=slider][aria-label="播放进度"]'
  const volSel = '[role=slider][aria-label="音量"]'

  // ══════════════════════════════════════════════
  group('0. 先确认测试用的指针类型真的生效（否则测试等于没覆盖）')
  {
    const box = await boxOf(seekSel)
    await resetProbe()
    await dragMouseLike(box, 0.1, 0.3, { pointerType: 'mouse' })
    const mouseTypes = (await downTypes()).map((d) => d.ptype)
    check('CDP 鼠标事件的 pointerType = "mouse"', mouseTypes.includes('mouse'), JSON.stringify(mouseTypes))

    await resetProbe()
    await dragMouseLike(box, 0.3, 0.5, { pointerType: 'pen' })
    const penTypes = (await downTypes()).map((d) => d.ptype)
    check('CDP pen 事件的 pointerType = "pen"', penTypes.includes('pen'), JSON.stringify(penTypes))

    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await sleep(400)
    await resetProbe()
    const tbox = await boxOf(seekSel)
    await dragTouch(tbox, 0.6)
    const touchTypes = (await downTypes()).map((d) => d.ptype)
    check('触摸事件的 pointerType = "touch"', touchTypes.includes('touch'), JSON.stringify(touchTypes))
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await sleep(300)
  }

  // ══════════════════════════════════════════════
  // 三种类型各跑一套相同流程
  // ══════════════════════════════════════════════
  for (const kind of ['mouse', 'pen', 'touch']) {
    const zh = kind === 'mouse' ? '鼠标' : kind === 'pen' ? '笔（数位板）' : '触摸'

    group(`【${zh}】连续拖 10 次，每次都能生效`)
    {
      await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
      await sleep(300)
      const box = await boxOf(seekSel)
      const st0 = await stateOf()

      let allOk = true
      const results = []
      for (let i = 0; i < 10; i++) {
        const to = 0.1 + (i % 9) * 0.1
        const before = (await stateOf()).t

        if (kind === 'touch') {
          await dragTouch(box, to, { fromRatio: 0.05 })
        } else {
          await dragMouseLike(box, 0.05, to, { pointerType: kind, steps: 2 })
        }

        const after = (await stateOf()).t
        // 落点应接近目标；只要"位置确实变化了"就说明这次拖动生效
        const moved = Math.abs(after - before) > 0.5 || Math.abs(after - dur * to) < 2
        if (!moved) allOk = false
        results.push(`#${i + 1}→${after}s${moved ? '' : '✗'}`)
      }
      console.log(`      ${results.join(' ')}`)
      check(`${zh}：连续 10 次拖动每次都生效（不会"第二次就拖不动"）`, allOk)
      void st0

      const counts = await probeCounts()
      check(`${zh}：10 次后无监听器泄漏`, counts.pointermove === 0 && counts.pointerup === 0 && counts.pointercancel === 0, JSON.stringify(counts))
      const residue = await captureResidue()
      check(`${zh}：10 次后无指针捕获残留`, residue.length === 0, JSON.stringify(residue))
    }

    group(`【${zh}】拖动 → 松手 → 立刻再拖 → 正常`)
    {
      await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
      await sleep(250)
      const box = await boxOf(seekSel)

      if (kind === 'touch') {
        await dragTouch(box, 0.4, { fromRatio: 0.05 })
      } else {
        await dragMouseLike(box, 0.05, 0.4, { pointerType: kind })
      }
      const t1 = (await stateOf()).t
      check(`${zh}：第 1 次落点 ≈40%`, Math.abs(t1 - dur * 0.4) < 2.5, `${t1}s`)

      // 立刻（无额外等待）再拖
      if (kind === 'touch') {
        await dragTouch(box, 0.8, { fromRatio: 0.4 })
      } else {
        await dragMouseLike(box, 0.4, 0.8, { pointerType: kind })
      }
      const t2 = (await stateOf()).t
      check(`${zh}：紧接着第 2 次落点 ≈80%（关键：不会失效）`, Math.abs(t2 - dur * 0.8) < 2.5, `${t2}s`)
    }

    group(`【${zh}】拖动 → 松手 → 点击其他地方 → 再拖 → 正常`)
    {
      await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
      await sleep(250)
      const box = await boxOf(seekSel)

      if (kind === 'touch') {
        await dragTouch(box, 0.3, { fromRatio: 0.05 })
      } else {
        await dragMouseLike(box, 0.05, 0.3, { pointerType: kind })
      }
      const t1 = (await stateOf()).t
      check(`${zh}：第 1 次落点 ≈30%`, Math.abs(t1 - dur * 0.3) < 2.5, `${t1}s`)

      // 点击别处（舞台空白区）
      if (kind === 'touch') {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 700, y: 300 }] })
        await sleep(30)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } else {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 300, button: 'left', clickCount: 1, buttons: 1, pointerType: kind })
        await sleep(30)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 300, button: 'left', clickCount: 1, buttons: 0, pointerType: kind })
      }
      await sleep(200)

      if (kind === 'touch') {
        await dragTouch(box, 0.7, { fromRatio: 0.3 })
      } else {
        await dragMouseLike(box, 0.3, 0.7, { pointerType: kind })
      }
      const t2 = (await stateOf()).t
      check(`${zh}：点击别处后再拖，落点 ≈70%`, Math.abs(t2 - dur * 0.7) < 2.5, `${t2}s`)
    }

    group(`【${zh}】拖出元素外 / 窗口外松手，仍能正常结束`)
    {
      await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
      await sleep(250)
      const box = await boxOf(seekSel)

      // a) 垂直移出元素外（y 在元素外、仍在窗口内）
      if (kind === 'touch') {
        const x0 = box.left + box.width * 0.1
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: box.cy }] })
        for (const r of [0.3, 0.5, 0.65]) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.left + box.width * r, y: box.cy }] })
          await sleep(20)
        }
        // 触摸"移出元素外"：垂直方向移开后再松手
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.left + box.width * 0.65, y: 300 }] })
        await sleep(20)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } else {
        await dragMouseLike(box, 0.1, 0.65, { pointerType: kind, releaseAt: { x: box.left + box.width * 0.65, y: 300 } })
      }
      await sleep(300)
      const t1 = (await stateOf()).t
      check(`${zh}：元素外松手，落点保留 ≈65%`, Math.abs(t1 - dur * 0.65) < 2.5, `${t1}s`)

      let c1 = await probeCounts()
      check(`${zh}：元素外松手后监听器已清理`, c1.pointermove === 0 && c1.pointerup === 0 && c1.pointercancel === 0, JSON.stringify(c1))

      // b) 松手在窗口外（垂直方向远超视口）；水平坐标仍保持在元素范围内
      await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
      await sleep(250)
      if (kind !== 'touch') {
        await dragMouseLike(box, 0.1, 0.45, { pointerType: kind, releaseAt: { x: box.left + box.width * 0.45, y: 2000 } })
        await sleep(300)
        const t2 = (await stateOf()).t
        check(`${zh}：窗口外松手，落点保留 ≈45%`, Math.abs(t2 - dur * 0.45) < 2.5, `${t2}s`)
        const c2 = await probeCounts()
        check(`${zh}：窗口外松手后监听器已清理`, c2.pointermove === 0 && c2.pointerup === 0 && c2.pointercancel === 0, JSON.stringify(c2))
      }

      // 松手后划过，不应跟随
      const idle = await idleSwipe(box, 1200, kind === 'pen' ? 'pen' : 'mouse')
      check(`${zh}：松手后划过，进度条不跟随`, Math.abs(idle.after.t - idle.before.t) < 0.06, `${idle.before.t}s → ${idle.after.t}s`)
    }

    group(`【${zh}】音量滑杆同样测试`)
    {
      const vbox = await boxOf(volSel)
      check(`${zh}：音量滑杆存在`, !!vbox)

      if (vbox) {
        // 连续拖 3 次
        let ok = true
        const vals = []
        for (const to of [0.3, 0.7, 0.5]) {
          if (kind === 'touch') {
            await dragTouch(vbox, to, { fromRatio: 0.5 })
          } else {
            await dragMouseLike(vbox, 0.5, to, { pointerType: kind })
          }
          const v = (await stateOf()).volume
          if (Math.abs(v - to) > 0.08) ok = false
          vals.push(v)
        }
        console.log(`      音量落点: ${vals.join(', ')}`)
        check(`${zh}：音量连续拖 3 次都生效`, ok, vals.join(','))

        const c = await probeCounts()
        check(`${zh}：音量拖动后无泄漏`, c.pointermove === 0 && c.pointerup === 0 && c.pointercancel === 0, JSON.stringify(c))

        // 松手后划过不应改音量
        const vBefore = (await stateOf()).volume
        const deadline = Date.now() + 1500
        let i = 0
        while (Date.now() < deadline) {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: vbox.left + vbox.width * (i % 2 === 0 ? 0.95 : 0.05),
            y: vbox.cy,
            buttons: 0,
            pointerType: kind === 'pen' ? 'pen' : 'mouse',
          })
          await sleep(110)
          i++
        }
        const vAfter = (await stateOf()).volume
        check(`${zh}：松手后划过音量条，音量不变`, Math.abs(vAfter - vBefore) < 0.02, `${vBefore} → ${vAfter}`)
      }
    }
  }


  // ══════════════════════════════════════════════
  // 色轮：三种指针类型（阶段 5 补丁 10）
  //
  // 【与旧色相环测试的差别】
  // 色相环只管 H，用户在纯白（S=0）时拖环颜色**必然不变** ——
  // 那正是用户推翻色相环方案的根本原因。所以这里全部改成色轮语义：
  // **点哪里得到哪里的颜色**，起点用纯白（最严格的场景）。
  group('色轮：三种指针类型（点哪里得哪里的颜色）')
  {
    await cdp.eval(`window.__lrcDiag.settings.openDrawer()`)
    await sleep(900)

    for (const kind of ['mouse', 'pen', 'touch']) {
      const zh = kind === 'mouse' ? '鼠标' : kind === 'pen' ? '笔' : '触摸'
      const ring = await boxOf('.cp__ring')
      if (!ring) {
        check(`${zh}：色轮可见`, false)
        continue
      }
      check(`${zh}：色轮尺寸 120px`, Math.round(ring.width) === 120, `${Math.round(ring.width)}px`)

      const cx = ring.left + ring.width / 2
      const cy = ring.cy
      /*
       * 半径与组件源码一致：ColorPicker 里是
       *   `Math.min(rect.width, rect.height) / 2`（没有减 2）
       * 早先这里写成 `- 2`，脚本以为点在边缘(S=100)，组件却算出 S=96.7%，
       * 颜色偏成 #ff0808 而不是 #ff0000。
       */
      const R = ring.width / 2
      /*
       * 【为什么边缘点要退 1px 而不是按比例缩放】
       * 实测：`Input.dispatchTouchEvent` 在坐标**恰好落在圆边界**时
       * 一个事件都不投递（pointerdown/touchstart 全无），颜色不变。
       *   120° 距圆心 60.0px → 事件=[]，颜色 #ffffff
       *   120° 距圆心 59.0px → 事件正常，颜色 #03ff01
       * 所以边缘用例取 `R - 1`（S = 59/60 = 98.3%）：
       * 既保证事件投递，又足够接近边缘以得到纯色（容差 8 内）。
       *
       * 曾经试过按比例退 2%（frac=0.98）——那样 S 只有 98%，
       * RGB 出现 #ff0905 这种偏差（绿通道 9 级，超出容差 8）。
       * 退 1px 的 S 是 98.3%，实测在容差内。
       */
      const EDGE_PX = 1
      const readColor = () => cdp.eval(`window.__lrcDiag.settings.settings.color.active`)

      /** 设置颜色并等 UI 同步（避免 pointerdown 落在已被替换的旧节点上） */
      const setColor = async (hex) => {
        await cdp.eval(`window.__lrcDiag.settings.set('color.active', ${JSON.stringify(hex)})`)
        for (let i = 0; i < 25; i++) {
          await sleep(80)
          const got = await cdp.eval(`document.querySelector('.cp__hex-input') ? document.querySelector('.cp__hex-input').value : null`)
          if (got === hex) return
        }
      }

      /**
       * 按角度+半径比例点色轮。
       *
       * 【为什么要多移 1px】
       * attachPointerDrag 只在 pointermove 时应用颜色；纯 click（按下即抬起）
       * 不会触发 onMove，颜色不会变。所以点完必须补一个微小位移。
       * 1px 引入的误差 <2/255，不影响断言。
       *
       * 【frac=1.0 时自动退 1px】
       * 实测 `Input.dispatchTouchEvent` 在坐标**恰好落在圆边界**时
       * 一个事件都不投递（下标 120°/90° 会挂），退 1px 后正常。
       * 只退 1px 而不是按比例缩放：S = 59/60 = 98.3%，仍能得到纯色；
       * 曾经试过 frac=0.98，S 只有 98%，RGB 偏成 #ff0905 超出容差。
       */
      const tapAt = async (deg, frac) => {
        const rad = (deg * Math.PI) / 180
        const inset = frac >= 1 ? EDGE_PX : 0
        const rr = Math.max(0, R * frac - inset)
        const x = cx + Math.sin(rad) * rr
        const y = cy - Math.cos(rad) * rr

        /*
         * 补的 1px 位移**沿半径方向**（朝圆心），而不是固定 +x。
         *
         * 【为什么不能固定 +x】
         * 半径方向水平时（90°/240°/270°），横向 1px 会让角度偏最多，
         * 240° 实测偏成 #080aff（绿通道 10 级，超出容差 8）。
         * 沿半径退 1px 只改饱和度、不改色相，颜色仍是纯色系。
         */
        const dx = -Math.sin(rad) * 1
        const dy = Math.cos(rad) * 1

        if (kind === 'touch') {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
          await sleep(30)
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y: y + dy }] })
          await sleep(30)
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        } else {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1, pointerType: kind })
          await sleep(30)
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y: y + dy, button: 'left', buttons: 1, pointerType: kind })
          await sleep(30)
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1, buttons: 0, pointerType: kind })
        }
        await sleep(280)
        return readColor()
      }

      // ── 核心：纯白起点点各色相 ──
      for (const [deg, expect] of [[0, '#ff0000'], [120, '#00ff00'], [240, '#0000ff']]) {
        await setColor('#ffffff')
        const got = await tapAt(deg, 1.0)
        const m = /^#(..)(..)(..)$/.exec(got)
        const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16))
        /*
         * 容差 8（不是 4）：tapAt 必须补 1px 位移才能触发 onMove，
         * 而 240° 处半径方向是**水平**的，这 1px 横向位移对角度的影响最大
         * （240°→约 241.5°，蓝通道被拉起 5~6 级）。
         * 8/255 = 3%，肉眼不可辨，且足以容纳几何误差。
         */
        const near = (a, c) => Math.abs(a - c) <= 8
        check(
          `${zh}：纯白起点点 ${deg}° 边缘 → 得到预期纯色 ${expect}`,
          near(r, parseInt(expect.slice(1, 3), 16)) && near(g, parseInt(expect.slice(3, 5), 16)) && near(b, parseInt(expect.slice(5, 7), 16)),
          `得到 ${got}，期望约 ${expect}`,
        )
      }

      // ── 半径 → 饱和度 ──
      await setColor('#ffffff')
      const full = await tapAt(120, 1.0)
      await setColor('#ffffff')
      const half = await tapAt(120, 0.5)
      const sOf = (hex) => {
        const m = /^#(..)(..)(..)$/.exec(hex)
        const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16))
        return Math.round(((Math.max(r, g, b) - Math.min(r, g, b)) / 255) * 100)
      }
      check(`${zh}：半径 100% → S≈100`, sOf(full) >= 95, `${full} S=${sOf(full)}%`)
      check(`${zh}：半径 50% → S≈50`, Math.abs(sOf(half) - 50) <= 6, `${half} S=${sOf(half)}%`)

      // ── 中心 / 死区 ──
      await setColor('#ffffff')
      const center = await tapAt(0, 0.0)
      check(`${zh}：点正中心 → 纯白（S=0）`, center.toLowerCase() === '#ffffff', center)
      await setColor('#3366cc')
      const dead = await tapAt(0, 0.08)
      check(`${zh}：点死区内 → 饱和度归 0（低饱和精度保护）`, sOf(dead) <= 2, `${dead} S=${sOf(dead)}%`)

      // ── 连续第二次拖动不应失效（历史 bug 回归）──
      await setColor('#ffffff')
      const c1 = await tapAt(210, 0.9)
      const c2 = await tapAt(60, 0.9)
      check(`${zh}：紧接着第 2 次色轮拖动也生效`, c1 !== c2, `${c1} → ${c2}`)

      // ── 松手后划过不应改色 ──
      const before = await readColor()
      const deadline = Date.now() + 1200
      let i = 0
      while (Date.now() < deadline) {
        const ang = (i * 60) % 360
        const rad = (ang * Math.PI) / 180
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: cx + Math.sin(rad) * R * 0.9,
          y: cy - Math.cos(rad) * R * 0.9,
          buttons: 0,
          pointerType: kind === 'pen' ? 'pen' : 'mouse',
        })
        await sleep(110)
        i++
      }
      const after = await readColor()
      check(`${zh}：松手后划过色轮，颜色不变`, after === before, `${before} → ${after}`)

      const c = await probeCounts()
      check(`${zh}：色轮后无泄漏`, c.pointermove === 0 && c.pointerup === 0 && c.pointercancel === 0, JSON.stringify(c))
      const residue = await captureResidue()
      check(`${zh}：色轮后无捕获残留`, residue.length === 0, JSON.stringify(residue))
    }

    await cdp.eval(`window.__lrcDiag.settings.closeDrawer()`)
    await sleep(300)
  }

  // ══════════════════════════════════════════════
  group('通用')
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
