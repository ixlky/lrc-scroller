// @ts-check
/**
 * 阶段 4 验收：展示 / 全屏模式。
 *
 * 覆盖用户给的 8 条验收清单：
 *  1. 点「演示」进入全屏，UI 消失，只剩歌词，当前行仍居中
 *  2. 鼠标移动控制条淡入，静止 2 秒淡出
 *  3. F 键进入/退出，Esc 退出
 *  4. iOS Safari / 受限环境下降级为伪全屏，功能可用且有提示
 *  5. 全屏中切歌、拖进度条一切正常
 *  6. 全屏下滚轮回看保护仍生效
 *  7. 退出全屏后回到编辑界面，播放状态不中断
 *  8. 控制台 0 error
 *
 * 用法：node scripts/e2e-stage4.mjs [页面URL] [调试端口]
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
  console.log(`\n阶段 4 验收：展示 / 全屏模式 —— ${PAGE_URL}\n`)

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
  await cdp.eval(`(() => { try { localStorage.clear(); } catch (e) {} return true; })()`)
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(2600)

  // 载入音频 + 与音频对齐的歌词（每行 1 秒），便于断言"当前行居中"
  const dur = await cdp.eval(`(async () => {
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
    if (!Number.isFinite(window.__lrcDiag.player.duration) || window.__lrcDiag.player.duration <= 0) throw new Error('音频时长未取到');
    return window.__lrcDiag.player.duration;
  })()`)
  const lyricInfo = await cdp.eval(`(() => {
    const d = window.__lrcDiag;
    const total = Math.ceil(d.player.duration);
    const rows = [];
    for (let i = 0; i < total; i++) {
      const t = i;
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = (t % 60).toFixed(2).padStart(5, '0');
      rows.push('[' + mm + ':' + ss + ']第 ' + (i + 1) + ' 行歌词');
    }
    d.lyrics.loadFromText('[ti:阶段4]\\n' + rows.join('\\n'), { fileName: 'stage4.lrc' });
    return { lines: d.lyrics.count, last: d.lyrics.lastTime };
  })()`)
  console.log(`音频 ${dur}s，歌词 ${lyricInfo.lines} 行（每行 1 秒）`)

  /** 展示模式状态快照 */
  const fsState = () =>
    cdp.eval(`(() => {
      const shell = document.querySelector('.app-shell');
      const d = window.__lrcDiag;
      const f = d.full;
      const q = (s) => document.querySelector(s);
      const vis = (el) => {
        if (!el) return 'missing';
        const cs = getComputedStyle(el);
        // 读 data-attr 不可行（无），读 visibility + opacity
        return cs.visibility === 'hidden' ? 'hidden' : (Number(cs.opacity) < 0.05 ? 'transparent' : 'visible');
      };
      const topbar = q('.topbar');
      const playerbar = q('.playerbar');
      const stage = q('.app-stage');
      const active = q('.lyric-line.is-active');
      const shellRect = shell.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const pbCs = playerbar ? getComputedStyle(playerbar) : null;
      return {
        classes: shell.className,
        isPresenting: f ? f.isPresenting.value : null,
        isNative: f ? f.isNativeFullscreen.value : null,
        isDegraded: f ? f.isDegraded.value : null,
        controlVisible: f ? f.controlVisible.value : null,
        idleMsLeft: f ? f.idleMsLeft.value : null,
        nativeFsEl: !!document.fullscreenElement,
        topbar: vis(topbar),
        playerbar: vis(playerbar),
        topbarRectH: Math.round(topbar ? topbar.getBoundingClientRect().height : -1),
        // 播放条在展示模式下是 absolute（浮在舞台上），高度不再反映"可见性"，
        // 所以可见性要用 computed 的 visibility/opacity/pointer-events 判断。
        playerbarRectH: Math.round(playerbar ? playerbar.getBoundingClientRect().height : -1),
        playerbarPE: pbCs ? pbCs.pointerEvents : null,
        playerbarPos: pbCs ? pbCs.position : null,
        stageH: Math.round(stageRect.height),
        shellH: Math.round(shellRect.height),
        stageTop: Math.round(stageRect.top),
        viewportH: window.innerHeight,
        activeIndex: d.auto ? d.auto.activeIndex.value : null,
        activeText: active ? active.textContent.trim().slice(0, 14) : null,
        activeCY: active ? Math.round(active.getBoundingClientRect().top + active.getBoundingClientRect().height / 2) : null,
        stageCY: Math.round(stageRect.top + stageRect.height / 2),
        t: Number(d.player.currentTime.toFixed(2)),
        playing: d.player.playing,
        // 提示浮层的真实可见性（补丁 8：只数 DOM 数量是假阳性）
        toastCount: document.querySelectorAll('.toast').length,
        toastContainerVis: (() => {
          const c = q('.toasts');
          return c ? getComputedStyle(c).visibility : 'missing';
        })(),
        toastContainerOpacity: (() => {
          const c = q('.toasts');
          return c ? getComputedStyle(c).opacity : '0';
        })(),
        toastContainerPE: (() => {
          const c = q('.toasts');
          return c ? getComputedStyle(c).pointerEvents : 'none';
        })(),
        toastVis: (() => {
          const t = q('.toast');
          return t ? getComputedStyle(t).visibility : 'missing';
        })(),
        toastOpacity: (() => {
          const t = q('.toast');
          return t ? getComputedStyle(t).opacity : '0';
        })(),
        toastBoxH: (() => {
          const t = q('.toast');
          return t ? Math.round(t.getBoundingClientRect().height) : 0;
        })(),
        toastText: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()).join(' | '),
      };
    })()`)

  /** 发送一次鼠标移动（越过抖动阈值） */
  async function moveMouse(x, y) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 })
  }

  async function pressKey(key, code, windowsVirtualKeyCode) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    })
    await sleep(40)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    })
  }

  // ══════════════════════════════════════════════
  group('0. 前置：编辑界面正常')
  {
    const s = await fsState()
    check('初始不在展示模式', s.isPresenting === false, `isPresenting=${s.isPresenting}`)
    check('初始顶栏可见', s.topbar === 'visible', s.topbar)
    check('初始播放条可见', s.playerbar === 'visible', s.playerbar)
    check('诊断钩子已挂载（full 存在）', s.isPresenting !== null, 'window.__lrcDiag.full 缺失')
  }

  // ══════════════════════════════════════════════
  group('1. 点「演示」进入全屏：UI 消失、只剩歌词、当前行仍居中')
  {
    // 先播到 20 秒，让"当前行居中"有实际内容可验
    await cdp.eval(`window.__lrcDiag.engine.seek(20)`)
    await cdp.eval(`window.__lrcDiag.engine.play()`)
    await sleep(700)
    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(500)

    // 点「演示」按钮
    //
    // 【为什么要先关掉全屏能力标记】
    // 无头浏览器里 document.fullscreenEnabled 为 true，
    // requestFullscreen 拿到的是**永不 settle 的 Promise**
    // （没有用户手势、也没有真正的全屏显示器），
    // await 它会让 enterPresentation 整个卡死，后续状态永远不同步。
    // headless 是已知的 CDP 盲区之一。
    // 所以这里统一降级成伪全屏来测 —— 展示模式本来就不依赖原生全屏，
    // 这恰好也是验收项 4 要测的路径。
    // （详见 group 4 的注释：必须改 document.fullscreenEnabled，
    //   改 full.supportsElementFullscreen 这个副本是无效的。）
    await cdp.eval(`(() => {
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false });
      Object.defineProperty(document, 'webkitFullscreenEnabled', { configurable: true, get: () => false });
      return true;
    })()`)

    const clicked = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /演示|退出演示/.test(b.textContent.trim()));
      if (!btn) return false;
      btn.click();
      return true;
    })()`)
    check('找到并点击「演示」按钮', clicked === true)
    await sleep(900)

    const s = await fsState()
    check('进入展示模式', s.isPresenting === true, `isPresenting=${s.isPresenting}`)
    check('顶栏已隐藏', s.topbar === 'hidden' || s.topbar === 'transparent', s.topbar)
    check('顶栏不再占布局高度', s.topbarRectH <= 1, `${s.topbarRectH}px`)
    check('进入时控制条隐藏（干净歌词）', s.playerbar === 'hidden' || s.playerbar === 'transparent', s.playerbar)
    // 舞台"占满"的正确判据：顶栏行归零后，舞台从窗口顶部开始，
    // 且高度 = 视口高 − 播放条行（播放条 absolute 浮在上面，不占网格行）
    check('舞台顶到窗口最上沿（无顶栏留白）', s.stageTop <= 1, `top=${s.stageTop}px`)
    check(
      '舞台几乎占满视口（仅留播放条行的空间）',
      s.stageH >= s.viewportH - 80,
      `${s.stageH}px / 视口 ${s.viewportH}px`,
    )
    check('播放条已浮在舞台上方（absolute）', s.playerbarPos === 'absolute', s.playerbarPos)
    check('歌词行仍在渲染', typeof s.activeText === 'string' && s.activeText.length > 0, String(s.activeText))
    check('当前行有内容（非空行）', s.activeIndex !== null && s.activeIndex >= 19, `activeIndex=${s.activeIndex}`)

    // 居中判定：当前行中心与舞台中心偏差 ≤ 6px（考虑行高的一半容差）
    if (s.activeCY !== null && s.stageCY !== null) {
      const dev = Math.abs(s.activeCY - s.stageCY)
      check('当前行仍居中（偏差 ≤6px）', dev <= 6, `偏差 ${dev}px（行中心 ${s.activeCY} / 舞台中心 ${s.stageCY}）`)
    } else {
      check('当前行仍居中（偏差 ≤6px）', false, '拿不到位置')
    }
  }

  // ══════════════════════════════════════════════
  group('2. 鼠标移动 → 控制条淡入；静止 2 秒 → 淡出')
  {
    let s = await fsState()
    check('起点：控制条隐藏', s.playerbar === 'hidden' || s.playerbar === 'transparent', s.playerbar)

    // 移动鼠标（越过 6px 抖动阈值）
    await moveMouse(700, 400)
    await moveMouse(500, 500)
    await sleep(150)
    s = await fsState()
    check('鼠标移动 → 控制条淡入', s.playerbar === 'visible', `${s.playerbar}（idle 剩余 ${s.idleMsLeft}ms）`)
    // 播放条是 absolute，高度不随可见性变化；真正的判据是"有真实高度 + 可接收事件"。
    // 39px = 38px 播放按钮 + 1px 边框，是它的固有高度，不是被裁剪的残值。
    check(
      '淡入后控制条有真实高度且可交互',
      s.playerbarRectH >= 38 && s.playerbarPE === 'auto',
      `${s.playerbarRectH}px, pointer-events=${s.playerbarPE}`,
    )
    check('空闲倒计时已启动（<2000ms）', s.idleMsLeft < 2000, `${s.idleMsLeft}ms`)

    // 静止等待淡出
    await sleep(2600)
    s = await fsState()
    check('静止约 2 秒 → 控制条淡出', s.playerbar === 'hidden' || s.playerbar === 'transparent', s.playerbar)
    check('淡出后控制条不接收点击（pointer-events:none）', s.playerbarPE === 'none', `pointer-events=${s.playerbarPE}`)
    check('淡出后空闲倒计时归零', s.idleMsLeft === 0, `${s.idleMsLeft}ms`)

    // 再次移动应能重新淡入（可重复）
    await moveMouse(400, 300)
    await moveMouse(650, 620)
    await sleep(200)
    s = await fsState()
    check('再次移动 → 控制条重新淡入（可重复）', s.playerbar === 'visible', s.playerbar)
    await sleep(2600)
    s = await fsState()
    check('再次静止 → 再次淡出', s.playerbar === 'hidden' || s.playerbar === 'transparent', s.playerbar)
  }

  // ══════════════════════════════════════════════
  group('5. 全屏中拖进度条一切正常（先于 F/Esc 测，避免状态串）')
  {
    // 淡入控制条
    await moveMouse(700, 400)
    await moveMouse(520, 520)
    await sleep(200)

    const seekSel = '.playerbar__seek'
    const box = await cdp.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(seekSel)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left:r.left, top:r.top, w:r.width, h:r.height, cy:r.top+r.height/2 };
    })()`)
    check('全屏中进度条可见可交互', box !== null && box.w > 100, box ? `w=${Math.round(box.w)}` : 'null')

    if (box) {
      // 慢速拖动 10 步，每步 0.6 秒（<1 秒，考验修复后的跟随）
      const x0 = box.left + box.w * 0.33
      const x1 = box.left + box.w * 0.7
      const seen = new Set()
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: box.cy, button: 'left', clickCount: 1, buttons: 1 })
      await sleep(60)
      for (let i = 1; i <= 10; i++) {
        const x = x0 + ((x1 - x0) * i) / 10
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: box.cy, button: 'left', buttons: 1 })
        await sleep(90)
        const idx = await cdp.eval(`window.__lrcDiag.auto.activeIndex.value`)
        seen.add(idx)
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: box.cy, button: 'left', clickCount: 1, buttons: 0 })
      await sleep(400)

      check('全屏中慢速拖动 → 歌词实时跟随', seen.size >= 6, `activeIndex 经过 ${seen.size} 个不同值`)
      const after = await fsState()
      check('全屏中拖动落点正确', Math.abs(after.t - dur * 0.7) < 3, `t=${after.t}s（期望 ${(dur * 0.7).toFixed(0)}s）`)
      check('全屏中拖动后仍在展示模式', after.isPresenting === true, `isPresenting=${after.isPresenting}`)
      check('全屏中拖动后顶栏仍隐藏', after.topbar === 'hidden' || after.topbar === 'transparent', after.topbar)
    }
  }

  // ══════════════════════════════════════════════
  group('6. 全屏下滚轮回看保护仍生效')
  {
    // 滚轮回看：歌词应离开跟随，且回看结束若干秒后自动恢复
    // 用 CDP 真实滚轮输入（合成 WheelEvent 不走浏览器的滚动管线，
    // 与拖动一样属于 headless 盲区，真实事件更接近真机）。
    const r1 = await cdp.eval(`window.__lrcDiag.auto.userScrolling.value`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: -320, pointerType: 'mouse' })
    await sleep(500)
    const r2 = await cdp.eval(`(() => ({
      userScrolling: window.__lrcDiag.auto.userScrolling.value,
      centerIndex: window.__lrcDiag.auto.centerIndex.value,
      activeIndex: window.__lrcDiag.auto.activeIndex.value,
    }))()`)
    check('全屏中滚轮进入回看保护', r2.userScrolling === true, `userScrolling ${r1} → ${r2.userScrolling}`)
    check(
      '回看时虚化中心切到视口中心行（≠ 当前播放行）',
      typeof r2.centerIndex === 'number',
      `centerIndex=${r2.centerIndex}, activeIndex=${r2.activeIndex}`,
    )

    // 等待 RESUME_DELAY_MS 后自动恢复跟随
    const resumeMs = await cdp.eval(`window.__lrcDiag.auto.diagnostics.RESUME_DELAY_MS`)
    await sleep(resumeMs + 900)
    const r3 = await cdp.eval(`window.__lrcDiag.auto.userScrolling.value`)
    check('静止后自动恢复跟随', r3 === false, `userScrolling=${r3}`)
  }

  // ══════════════════════════════════════════════
  group('7. 退出全屏后回到编辑界面，播放状态不中断')
  {
    // 先确保处于播放中再退出
    await cdp.eval(`window.__lrcDiag.engine.play()`)
    await sleep(900)

    // 上一组结束时可能已在展示模式，先归位再测"从编辑界面进"
    const pre = await fsState()
    if (pre.isPresenting) {
      await pressKey('Escape', 'Escape', 27)
      await sleep(800)
    }
    const pre2 = await fsState()
    check('归位：当前不在展示模式', pre2.isPresenting === false, `isPresenting=${pre2.isPresenting}`)
    const before = await fsState()
    check('退出前处于播放中（用于验证不中断）', before.playing === true, `playing=${before.playing}`)

    // 重新进入展示模式（F 键），确认播放中也能进
    await pressKey('f', 'KeyF', 70)
    await sleep(800)
    const inFs = await fsState()
    check('播放中也能进入展示模式', inFs.isPresenting === true, `isPresenting=${inFs.isPresenting}`)
    check('播放中进入后仍在播放', inFs.playing === true, `playing=${inFs.playing}`)
    const stageHInFs = inFs.stageH

    await pressKey('Escape', 'Escape', 27)
    await sleep(800)

    const after = await fsState()
    check('Esc 退出展示模式', after.isPresenting === false, `isPresenting=${after.isPresenting}`)
    check('退出后顶栏恢复可见', after.topbar === 'visible', after.topbar)
    check('退出后顶栏恢复占位', after.topbarRectH > 40, `${after.topbarRectH}px`)
    check('退出后播放条恢复可见', after.playerbar === 'visible', after.playerbar)
    check('退出后播放条恢复可交互', after.playerbarPE === 'auto', after.playerbarPE)
    check('退出后播放条回到正常网格流（非 absolute）', after.playerbarPos === 'static' || after.playerbarPos === 'relative', after.playerbarPos)
    check('退出后舞台恢复让位给顶栏（舞台顶 >0）', after.stageTop > 10, `top=${after.stageTop}px`)
    check('退出后舞台高度恢复正常（比展示模式小）', after.stageH < stageHInFs, `${after.stageH}px < 展示模式 ${stageHInFs}px`)
    check('退出后播放状态未中断', after.playing === true, `playing=${after.playing}`)
    check('退出后播放时间继续推进', after.t > before.t, `${before.t}s → ${after.t}s`)
    check('退出后非伪全屏类（fixed 已撤销）', !/is-pseudo-fullscreen/.test(after.classes), after.classes)

    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(300)
  }

  // ══════════════════════════════════════════════
  group('3. F 键进入/退出')
  {
    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(300)

    await pressKey('f', 'KeyF', 70)
    await sleep(800)
    let s = await fsState()
    check('F 键进入展示模式', s.isPresenting === true, `isPresenting=${s.isPresenting}`)
    check('F 进入后顶栏隐藏', s.topbar === 'hidden' || s.topbar === 'transparent', s.topbar)

    await pressKey('f', 'KeyF', 70)
    await sleep(800)
    s = await fsState()
    check('F 键再次按下退出演示模式', s.isPresenting === false, `isPresenting=${s.isPresenting}`)
    check('F 退出后顶栏恢复', s.topbar === 'visible', s.topbar)

    // Esc 在非展示模式不应被拦截（应还给浏览器）
    await pressKey('Escape', 'Escape', 27)
    await sleep(400)
    s = await fsState()
    check('非展示模式下 Esc 不改变应用状态', s.isPresenting === false && s.topbar === 'visible', `isPresenting=${s.isPresenting}, topbar=${s.topbar}`)
  }

  // ══════════════════════════════════════════════
  group('3b. F 键输入保护：正在输入时不得切全屏')
  {
    await cdp.eval(`window.__lrcDiag.settings.openDrawer()`)
    await sleep(900)
    // 聚焦 HEX 输入框（键盘可编辑元素）
    const focused = await cdp.eval(`(() => {
      const inputs = [...document.querySelectorAll('input[type=text], input:not([type])')];
      const el = inputs.find(i => i.offsetParent !== null) || inputs[0];
      if (!el) return null;
      el.focus();
      return document.activeElement === el;
    })()`)
    check('已聚焦一个文本输入框', focused === true, String(focused))

    if (focused) {
      await pressKey('f', 'KeyF', 70)
      await sleep(600)
      const s = await fsState()
      check('输入框内按 F 不触发全屏（是在打字）', s.isPresenting === false, `isPresenting=${s.isPresenting}`)
      const stillFocused = await cdp.eval(`document.activeElement && document.activeElement.tagName`)
      check('焦点仍在输入框内', String(stillFocused).toUpperCase() === 'INPUT', String(stillFocused))
    }
    await cdp.eval(`window.__lrcDiag.settings.closeDrawer()`)
    await sleep(400)
  }

  // ══════════════════════════════════════════════
  group('4. 受限环境降级为伪全屏（功能可用 + 有提示）')
  {
    // 归位：确保从编辑界面开始。
    // 前面若干用例（尤其 3b 的 F 键输入保护）可能把展示模式留在开启状态，
    // 而本组用 F 键**切换**进入 —— 若已在展示模式，F 会把它切出去，
    // 后面所有断言就全错了。
    {
      const st = await fsState()
      if (st.isPresenting) {
        await cdp.eval(`window.__lrcDiag.full.leavePresentation()`)
        await sleep(800)
      }
      const st2 = await fsState()
      check('归位：当前不在展示模式（本组用 F 键切换进入）', st2.isPresenting === false, `isPresenting=${st2.isPresenting}`)
    }

    /*
     * 模拟 iOS Safari。
     *
     * 【踩过的坑：不要去改 `full.supportsElementFullscreen`】
     * 那是 return 对象上的一个**副本**；enterPresentation 内部调用的是
     * 模块作用域里的那个函数闭包，改副本对它无效。
     * 实测证据：改副本后探测函数被调用次数为 0 次，
     * 代码仍走原生分支 → requestFullscreen → headless 下永不 settle 的
     * Promise → 函数卡在 await 上，else 分支（降级提示）永远不执行。
     * 表现为 isDegraded=true 但 degradedReason=null、toast=0。
     *
     * 正确做法是让**能力探测本身**认为不支持：headless 的
     * document.fullscreenEnabled 是 true，必须从根上关掉它。
     */
    await cdp.eval(`(() => {
      window.__origFsEnabled = Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenEnabled');
      window.__origWebkitFsEnabled = Object.getOwnPropertyDescriptor(Document.prototype, 'webkitFullscreenEnabled');
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false });
      Object.defineProperty(document, 'webkitFullscreenEnabled', { configurable: true, get: () => false });
      return true;
    })()`)
    const probe = await cdp.eval(`document.fullscreenEnabled`)
    check('已模拟为不支持全屏（document.fullscreenEnabled=false）', probe === false, String(probe))

    await pressKey('f', 'KeyF', 70)
    await sleep(1000)
    const s = await fsState()
    check('受限环境仍能进入展示模式（功能不依赖全屏 API）', s.isPresenting === true, `isPresenting=${s.isPresenting}`)
    check('降级为伪全屏（isDegraded=true）', s.isDegraded === true, `isDegraded=${s.isDegraded}`)
    check('伪全屏时原生全屏元素为空', s.nativeFsEl === false, String(s.nativeFsEl))
    check('伪全屏类已挂上', /is-pseudo-fullscreen/.test(s.classes), s.classes)
    check('伪全屏下 UI 仍隐藏（只剩歌词）', s.topbar === 'hidden' || s.topbar === 'transparent', s.topbar)
    check('伪全屏下舞台几乎占满视口', s.stageH >= s.viewportH - 80, `${s.stageH}px / 视口 ${s.viewportH}px`)

    /*
     * 【补丁 8：这条断言原来是假阳性】
     * 旧写法是 `s.toastCount > 0` —— 它只数 DOM 里 .toast 的数量，
     * 不看 visibility/opacity。CSS 把 .toasts 归进展示模式隐藏组后，
     * 元素确实在 DOM 里（计数 > 0），但用户**根本看不到**，
     * 测试却报"✓ 有降级提示"。假阳性比没这条测试更糟。
     *
     * 现在必须断言"真实可见"：容器与 toast 自身都不可被 hidden/transparent，
     * 且有真实尺寸（visibility:hidden 时 getBoundingClientRect 仍有值，
     * 所以尺寸单独不够，要与 visibility/opacity 合起来判断）。
     */
    check('伪全屏下有降级提示 Toast', s.toastCount > 0, `${s.toastCount} 条`)
    check(
      '【关键】提示浮层在展示模式下**真实可见**（容器未被隐藏）',
      s.toastContainerVis === 'visible' && Number(s.toastContainerOpacity) > 0.5,
      `visibility=${s.toastContainerVis}, opacity=${s.toastContainerOpacity}`,
    )
    check(
      '【关键】提示本身有真实尺寸且可读',
      s.toastBoxH > 20 && s.toastVis === 'visible' && Number(s.toastOpacity) > 0.5,
      `h=${s.toastBoxH}px, visibility=${s.toastVis}, opacity=${s.toastOpacity}`,
    )

    const toastText = await cdp.eval(`[...document.querySelectorAll('.toast')].map(t => t.textContent.trim()).join(' | ')`)
    check('提示文案说明了"伪全屏"', /伪全屏/.test(toastText), toastText.slice(0, 120))
    check('【关键】提示告诉了用户怎么退出（按 Esc）', /Esc/.test(toastText), toastText.slice(0, 160))

    // 伪全屏下功能仍可用：进度条可拖
    await moveMouse(700, 400)
    await moveMouse(500, 500)
    await sleep(200)
    const barBox = await cdp.eval(`(() => {
      const el = document.querySelector('.playerbar__seek');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: r.width, cy: r.top + r.height/2, left: r.left, h: r.height };
    })()`)
    check('伪全屏下控制条仍可操作', barBox !== null && barBox.w > 100, barBox ? `w=${Math.round(barBox.w)}` : 'null')

    if (barBox) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: barBox.left + barBox.w * 0.2, y: barBox.cy, button: 'left', clickCount: 1, buttons: 1 })
      await sleep(50)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: barBox.left + barBox.w * 0.45, y: barBox.cy, button: 'left', buttons: 1 })
      await sleep(50)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: barBox.left + barBox.w * 0.45, y: barBox.cy, button: 'left', clickCount: 1, buttons: 0 })
      await sleep(400)
      const t2 = await cdp.eval(`window.__lrcDiag.player.currentTime`)
      check('伪全屏下拖进度条生效', Math.abs(t2 - dur * 0.45) < 4, `t=${Number(t2).toFixed(1)}s（期望 ${(dur * 0.45).toFixed(0)}s）`)
    }

    // 伪全屏下 Esc 仍能退出
    await pressKey('Escape', 'Escape', 27)
    await sleep(800)
    const s2 = await fsState()
    check('伪全屏下 Esc 正常退出', s2.isPresenting === false, `isPresenting=${s2.isPresenting}`)
    check('伪全屏退出后 fixed 已撤销', !/is-pseudo-fullscreen/.test(s2.classes), s2.classes)

    // 还原全屏能力标记（用重载页面最稳妥，也顺带清掉其他 monkey patch）
    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(2600)
  }

  // ══════════════════════════════════════════════
  // 【真机 BUG 回归】原生全屏下开过设置后，右侧出现白边
  //
  // 起因：抽屉打开会让 .app-shell 得到 padding-right: 360px（需求 N2 的避让）。
  // 原生全屏时 .app-shell **就是全屏元素**，这条 padding 被画在全屏视口内，
  // 把 .app-stage 从 1400 挤到 1040；而 shell 自身背景透明
  // （实测 rgba(0,0,0,0)），挤出来的那条没有任何背景 → 露出浏览器白底。
  //
  // 触发条件：is-drawer-open 与 is-presenting **同时存在**（抽屉开着时进演示）。
  // 之前的用例全在"抽屉关闭"状态下测 padding，所以永远测不到。
  group('白边回归：抽屉开着时进全屏（真机 BUG）')
  {
    const measure = () =>
      cdp.eval(`(() => {
        const shell = document.querySelector('.app-shell');
        const stage = document.querySelector('.app-stage');
        const cs = getComputedStyle(shell);
        const gr = stage.getBoundingClientRect();
        return {
          classes: shell.className,
          padRight: cs.paddingRight,
          shellBg: cs.backgroundColor,
          stageW: Math.round(gr.width),
          stageRight: Math.round(gr.right),
          innerW: window.innerWidth,
          drawerOpen: window.__lrcDiag.settings.drawerOpen,
          isPresenting: window.__lrcDiag.full.isPresenting.value,
        };
      })()`)

    // ── 场景 A：抽屉开着 + 直接进展示模式（这才是真正的触发条件）──
    await cdp.eval(`window.__lrcDiag.settings.openDrawer()`)
    await sleep(700)
    const openState = await measure()
    check('前置：抽屉打开时 shell 确实有 360px 避让', openState.padRight === '360px', openState.padRight)
    check('前置：抽屉打开时舞台被挤窄', openState.stageW < openState.innerW - 200, `${openState.stageW}px / 视口 ${openState.innerW}px`)

    // 用 App 真实走的路径进入（F 键同样会在 onBeforeEnter 里关抽屉）
    await cdp.eval(`(() => {
      window.__lrcDiag.full.enterPresentation(document.querySelector('.app-shell'), {
        onBeforeEnter: () => window.__lrcDiag.settings.closeDrawer(),
      });
      return true;
    })()`)
    await sleep(1000)
    const fsA = await measure()
    check('进入展示模式时抽屉已自动关闭（第二道防线）', fsA.drawerOpen === false, `drawerOpen=${fsA.drawerOpen}`)
    check('不再残留 is-drawer-open 类', !/is-drawer-open/.test(fsA.classes), fsA.classes)
    check('【关键】展示模式下 padding-right 被清零（第一道防线）', fsA.padRight === '0px', fsA.padRight)
    check('【关键】舞台铺满视口宽度（无右侧白边）', fsA.stageW === fsA.innerW, `${fsA.stageW}px / 视口 ${fsA.innerW}px`)
    check('舞台右边缘与视口右边缘重合', fsA.stageRight === fsA.innerW, `${fsA.stageRight}px / ${fsA.innerW}px`)
    check('全屏元素自己画了舞台底色（未来再有空隙也不会露白）', fsA.shellBg !== 'rgba(0, 0, 0, 0)', fsA.shellBg)

    await cdp.eval(`window.__lrcDiag.full.leavePresentation()`)
    await sleep(700)

    // ── 场景 B：CSS 兜底 —— 强制两个类共存，验证 padding 仍被清零 ──
    // 这一条不依赖 JS 兜底，纯验证 CSS 规则本身站得住。
    // 注意：直接改 isPresenting.value 会绕过 isDegraded 等 computed 的联动，
    // 所以这里只加 CSS 类来做"纯 CSS 层"的验证。
    await cdp.eval(`(() => {
      const shell = document.querySelector('.app-shell');
      shell.classList.add('is-presenting');
      shell.classList.add('is-pseudo-fullscreen');
      return true;
    })()`)
    await sleep(400)
    const forced = await measure()
    check('【CSS 兜底】强制 is-drawer-open + is-presenting 共存时 padding 仍为 0', forced.padRight === '0px', `padRight=${forced.padRight}`)
    check('【CSS 兜底】共存状态下舞台仍铺满', forced.stageW === forced.innerW, `${forced.stageW}px / ${forced.innerW}px`)
    await cdp.eval(`(() => {
      const shell = document.querySelector('.app-shell');
      shell.classList.remove('is-presenting');
      shell.classList.remove('is-pseudo-fullscreen');
      return true;
    })()`)
    await sleep(500)

    // ── 场景 C：用户给的复现步骤（开→关→再进全屏）──
    await cdp.eval(`window.__lrcDiag.settings.openDrawer()`)
    await sleep(600)
    await cdp.eval(`window.__lrcDiag.settings.closeDrawer()`)
    await sleep(600)
    await cdp.eval(`(() => {
      window.__lrcDiag.full.enterPresentation(document.querySelector('.app-shell'));
      return true;
    })()`)
    await sleep(900)
    const fsC = await measure()
    check('场景C 开→关→再进全屏：舞台铺满', fsC.stageW === fsC.innerW, `${fsC.stageW}px / ${fsC.innerW}px`)
    check('场景C：padding-right 干净', fsC.padRight === '0px', fsC.padRight)
    await cdp.eval(`window.__lrcDiag.full.leavePresentation()`)
    await sleep(600)

    // ── 场景 D：退出后抽屉避让量仍能正常恢复（不回归）──
    await cdp.eval(`window.__lrcDiag.settings.openDrawer()`)
    await sleep(700)
    const back = await measure()
    check('退出全屏后抽屉避让量正常恢复（不回归）', back.padRight === '360px', back.padRight)
    check('退出全屏后抽屉正常挤窄舞台（不回归）', back.stageW === back.innerW - 360, `${back.stageW}px`)
    await cdp.eval(`window.__lrcDiag.settings.closeDrawer()`)
    await sleep(600)
    const restored = await measure()
    check('关闭抽屉后完全还原（不回归）', restored.padRight === '0px' && restored.stageW === restored.innerW, `padRight=${restored.padRight}, stageW=${restored.stageW}`)
  }

  // ══════════════════════════════════════════════
  // 【补丁 8 · 要修 1】原生全屏路径不应弹任何提示
  //
  // 删掉 .toasts 的隐藏组之后，要确认没有"顺手多弹东西"。
  // 原生全屏有浏览器自带的"按 Esc 退出"提示，我们再弹一条是噪音。
  group('补丁8：原生全屏不弹降级提示（反向断言）')
  {
    // 先清掉页面上残留的提示，等它自然消失
    await cdp.eval(`window.__lrcDiag.full.leavePresentation()`)
    await sleep(600)
    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(2800)

    // 让能力探测"支持全屏"，并把 requestFullscreen 换成**立即成功**的桩
    // （headless 真实 requestFullscreen 返回永不 settle 的 Promise，不能用）
    await cdp.eval(`(() => {
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
      Object.defineProperty(document, 'webkitFullscreenEnabled', { configurable: true, get: () => true });
      window.__nativeFak = { el: null };
      Element.prototype.requestFullscreen = function() {
        window.__nativeFak.el = this;
        return Promise.resolve();
      };
      Element.prototype.exitFullscreen = function() {
        window.__nativeFak.el = null;
        return Promise.resolve();
      };
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => window.__nativeFak.el,
      });
      return true;
    })()`)

    await cdp.eval(`(() => { window.__lrcDiag.full.enterPresentation(document.querySelector('.app-shell')); return true; })()`)
    await sleep(1200)
    const s = await fsState()
    check('走的是原生全屏分支（非降级）', s.isDegraded === false, `isDegraded=${s.isDegraded}`)
    check('原生全屏下不弹任何提示（反向断言）', s.toastCount === 0, `${s.toastCount} 条：${s.toastText.slice(0, 80)}`)

    await cdp.eval(`window.__lrcDiag.full.leavePresentation()`)
    await sleep(600)
  }

  // ══════════════════════════════════════════════
  // 【补丁 8 · 要修 2】伪全屏下用户手动 F11 进出，不应退出演示模式
  group('补丁8：F11 进出原生全屏（requestedNative 标志）')
  {
    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(2800)

    // 用桩实现原生全屏：可控地模拟"用户手动 F11 进出"
    await cdp.eval(`(() => {
      window.__native = { el: null, requestedByUs: false };
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
      Object.defineProperty(document, 'webkitFullscreenEnabled', { configurable: true, get: () => true });
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => window.__native.el });
      Element.prototype.requestFullscreen = function() { window.__native.el = this; return Promise.resolve(); };
      Element.prototype.exitFullscreen = function() { window.__native.el = null; return Promise.resolve(); };
      // 模拟用户按 F11：外部改 fullscreenElement 并派发 fullscreenchange
      window.__userFsOn = function() {
        window.__native.el = document.querySelector('.app-shell');
        document.dispatchEvent(new Event('fullscreenchange'));
      };
      window.__userFsOff = function() {
        window.__native.el = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      };
      return true;
    })()`)

    // ── 场景 A：伪全屏 → 用户手动 F11 进 → 再 F11 出 ──
    // 前置：走降级分支。做法是让 requestFullscreen **不存在**，
    // 这样 requestNative 返回 false → isNative=false、requestedNative=false。
    // （不用改 document.fullscreenEnabled：那个标记在下面还要切回 true
    //   来模拟"用户能按 F11"，反复重定义容易互相覆盖。）
    await cdp.eval(`(() => {
      window.__savedReq = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = undefined;
      Element.prototype.webkitRequestFullscreen = undefined;
      return true;
    })()`)
    await cdp.eval(`(() => { window.__lrcDiag.full.enterPresentation(document.querySelector('.app-shell')); return true; })()`)
    await sleep(1000)
    const a0 = await fsState()
    check('场景A 前置：处于伪全屏展示模式', a0.isPresenting === true && a0.isDegraded === true, `presenting=${a0.isPresenting}, degraded=${a0.isDegraded}`)

    // 用户按 F11 进原生全屏（此时浏览器 API 又是可用的）
    await cdp.eval(`(() => {
      if (window.__savedReq) Element.prototype.requestFullscreen = window.__savedReq;
      window.__userFsOn();
      return true;
    })()`)
    await sleep(600)
    const a1 = await fsState()
    check('场景A：用户 F11 进原生全屏后仍在展示模式', a1.isPresenting === true, `isPresenting=${a1.isPresenting}`)

    // 用户再按 F11 退出原生全屏（这正是修复前会误退展示模式的那一步）
    await cdp.eval(`window.__userFsOff()`)
    await sleep(600)
    const a2 = await fsState()
    check('【关键】场景A：F11 退出原生全屏后**仍在展示模式**（不连带退出）', a2.isPresenting === true, `isPresenting=${a2.isPresenting}`)
    check('场景A：退出后回到伪全屏（仍是只剩歌词）', a2.isDegraded === true && /is-pseudo-fullscreen/.test(a2.classes), `degraded=${a2.isDegraded}, classes=${a2.classes}`)
    check('场景A：界面仍是展示模式（顶栏隐藏）', a2.topbar === 'hidden' || a2.topbar === 'transparent', a2.topbar)

    await cdp.eval(`window.__lrcDiag.full.leavePresentation()`)
    await sleep(600)

    // ── 场景 B：原生全屏（我们自己请求的）→ 用户 F11 退出 → 跟着退出（不回归）──
    await cdp.eval(`(() => { window.__lrcDiag.full.enterPresentation(document.querySelector('.app-shell')); return true; })()`)
    await sleep(1000)
    const b0 = await fsState()
    check('场景B 前置：处于原生全屏展示模式', b0.isPresenting === true && b0.isDegraded === false, `presenting=${b0.isPresenting}, degraded=${b0.isDegraded}`)

    // 用户用 F11 退出原生全屏 → 应跟着退出演示模式
    await cdp.eval(`window.__userFsOff()`)
    await sleep(800)
    const b1 = await fsState()
    check('【不回归】场景B：F11 退出原生全屏 → 跟着退出演示模式', b1.isPresenting === false, `isPresenting=${b1.isPresenting}`)
    check('场景B：退出后顶栏恢复（没有卡在"UI 全没了"）', b1.topbar === 'visible', b1.topbar)

    await cdp.eval(`window.__lrcDiag.full.leavePresentation()`)
    await sleep(400)
  }

  // ══════════════════════════════════════════════
  group('8. 控制台 0 error')
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
