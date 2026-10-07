// @ts-check
/**
 * 阶段 3 验收（CDP 驱动真实浏览器）。
 *
 * 重点验证用户点名的 6 项：
 *  1. 当前行居中误差 ≤2px（有音频 / 模拟时钟 两种模式各测一次）
 *  2. 放大到 2.0 时相邻行位置不动
 *  3. 滚轮回看时播放继续但不被拉回，3 秒后自动恢复跟随
 *  4. RGB 调色盘与 HSL 色相环拖动实时变色；HEX 非法值标红且不生效
 *  5. 刷新后设置原样恢复；重置后 localStorage 被清空
 *  6. 2000 行歌词播放 30 秒帧率 ≥ 55fps
 *
 * 用法：node scripts/e2e-stage3.mjs <页面URL> [调试端口]
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
          // 记录完整描述而不只是 text（text 往往只有 "Uncaught"，无法定位）
          this.errors.push(
            `${d?.text ?? 'exception'}: ${d?.exception?.description ?? d?.exception?.value ?? ''}`.slice(0, 300),
          )
        }
        if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
          this.errors.push((m.params.args ?? []).map((a) => a.value ?? a.description).join(' '))
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
    if (r.exceptionDetails) {
      throw new Error(`页面异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
    }
    return r.result?.value
  }
  close() {
    this.ws?.close()
  }
}

async function main() {
  console.log(`\n阶段 3 验收 —— ${PAGE_URL}\n`)

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
  // 设置已持久化：从干净状态开始。
  // 只清一次（不用 addScriptToEvaluateOnNewDocument），
  // 否则会破坏验证 5 的"刷新后设置恢复"用例。
  await cdp.eval(`(() => { try { localStorage.clear(); } catch (e) {} return true; })()`)
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(2600)

  /** 注入测试音频 */
  async function importAudio() {
    return cdp.eval(`(async () => {
      const b64 = ${JSON.stringify(audioB64)};
      const bin = atob(b64);
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
    })()`)
  }

  /**
   * 测量当前行中心与容器中心的偏差（像素）。
   * 用 getBoundingClientRect 实测，而不是读我们自己的计算值 ——
   * 后者只能证明"我们算对了"，前者才能证明"屏幕上真的居中"。
   */
  const measureCentering = `(() => {
    const stage = document.querySelector('.stage');
    const active = document.querySelector('.lyric-line.is-active');
    if (!stage || !active) return null;
    const sr = stage.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    const stageCenter = sr.top + sr.height / 2;
    const lineCenter = ar.top + ar.height / 2;
    return {
      deviation: Math.abs(lineCenter - stageCenter),
      signed: lineCenter - stageCenter,
      stageHeight: Math.round(sr.height),
      lineCenter: Math.round(lineCenter),
      stageCenter: Math.round(stageCenter),
      activeText: active.textContent.trim().slice(0, 20),
    };
  })()`

  // ══════════════════════════════════════════════
  group('验证 1a · 居中误差 ≤2px（模拟时钟模式）')
  {
    check('调试钩子含自动滚动控制器', await cdp.eval(`!!window.__lrcDiag?.auto`) === true)

    // 让模拟时钟跑起来，取多个时刻测量
    await cdp.eval(`window.__lrcDiag.lyrics.loadDemo()`)
    await sleep(600)
    await cdp.eval(`window.__lrcDiag.engine.play()`)
    await sleep(500)

    /** @type {number[]} */
    const devs = []
    for (let i = 0; i < 6; i++) {
      await sleep(1400)
      const m = await cdp.eval(measureCentering)
      if (m) devs.push(m.deviation)
    }

    const maxDev = Math.max(...devs)
    const avgDev = devs.reduce((a, b) => a + b, 0) / devs.length
    check(
      '模拟时钟模式：当前行居中误差 ≤2px',
      maxDev <= 2,
      `最大 ${maxDev.toFixed(2)}px，平均 ${avgDev.toFixed(2)}px（样本 ${devs.length}）`,
    )

    const offscreen = await cdp.eval(`window.__lrcDiag.auto.activeOffscreen.value`)
    check('居中时未被判定为"离开视野"', offscreen === false, `activeOffscreen=${offscreen}`)
  }

  // ══════════════════════════════════════════════
  group('验证 1b · 居中误差 ≤2px（真实音频模式）')
  {
    const dur = await importAudio()
    check('音频已载入', dur > 0, `duration=${dur}`)

    // 播放并多次采样
    await cdp.eval(`window.__lrcDiag.engine.seek(20); window.__lrcDiag.engine.play()`)
    await sleep(600)

    /** @type {number[]} */
    const devs = []
    for (let i = 0; i < 6; i++) {
      await sleep(1300)
      const m = await cdp.eval(measureCentering)
      if (m) devs.push(m.deviation)
    }

    const maxDev = Math.max(...devs)
    const avgDev = devs.reduce((a, b) => a + b, 0) / devs.length
    check(
      '真实音频模式：当前行居中误差 ≤2px',
      maxDev <= 2,
      `最大 ${maxDev.toFixed(2)}px，平均 ${avgDev.toFixed(2)}px（样本 ${devs.length}）`,
    )

    // 找到与"模拟模式"不同的当前行，证明确实在跟随
    const m = await cdp.eval(measureCentering)
    check('正在跟随播放推进（当前行有内容）', m !== null && m.activeText.length > 0, JSON.stringify(m))

    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(400)
  }

  // ══════════════════════════════════════════════
  group('验证 2 · 放大到 2.0 时相邻行位置不动')
  {
    await cdp.eval(`window.__lrcDiag.engine.seek(20)`)
    await sleep(700)

    const measure = `(() => {
      const lines = [...document.querySelectorAll('.lyric-line')];
      const i = lines.findIndex(el => el.classList.contains('is-active'));
      const rect = (el) => el ? { top: Math.round(el.getBoundingClientRect().top), h: Math.round(el.getBoundingClientRect().height) } : null;
      const active = lines[i];
      return {
        index: i,
        prev: rect(lines[i-1]),
        next: rect(lines[i+1]),
        activeOffsetHeight: active ? active.offsetHeight : null,
        activeOffsetWidth: active ? active.offsetWidth : null,
        activeTransform: active ? getComputedStyle(active).transform : null,
      };
    })()`

    const before = await cdp.eval(measure)

    // 把放大比例设为 2.0
    await cdp.eval(`window.__lrcDiag.settings.set('font.scale', 2)`)
    await sleep(900)

    const after = await cdp.eval(measure)

    check(
      '放大到 2.0 后上一行位置不变',
      before.prev && after.prev && before.prev.top === after.prev.top,
      `${before.prev?.top} → ${after.prev?.top}`,
    )
    check(
      '放大到 2.0 后下一行位置不变',
      before.next && after.next && before.next.top === after.next.top,
      `${before.next?.top} → ${after.next?.top}`,
    )
    check(
      '当前行 offsetHeight 未变（放大不占布局）',
      before.activeOffsetHeight === after.activeOffsetHeight,
      `${before.activeOffsetHeight} → ${after.activeOffsetHeight}`,
    )
    check(
      '当前行 offsetWidth 未变',
      before.activeOffsetWidth === after.activeOffsetWidth,
      `${before.activeOffsetWidth} → ${after.activeOffsetWidth}`,
    )
    check(
      '放大确实通过 transform 生效（matrix 含 2 倍缩放）',
      /matrix\(2,/.test(after.activeTransform ?? ''),
      `transform=${after.activeTransform}`,
    )

    // 测量放大后是否仍然居中（放大不该破坏居中）
    await sleep(700)
    const c = await cdp.eval(measureCentering)
    check('放大到 2.0 后当前行仍居中（≤2px）', c && c.deviation <= 2, `偏差 ${c?.deviation?.toFixed(2)}px`)

    // 恢复
    await cdp.eval(`window.__lrcDiag.settings.set('font.scale', 1.35)`)
    await sleep(500)
  }

  // ══════════════════════════════════════════════
  group('验证 3 · 滚轮回看：播放继续、不被拉回、3 秒后恢复')
  {
    await cdp.eval(`window.__lrcDiag.engine.seek(25); window.__lrcDiag.engine.play()`)
    await sleep(900)

    const t0 = await cdp.eval(`Number(window.__lrcDiag.player.currentTime.toFixed(2))`)
    const offset0 = await cdp.eval(`window.__lrcDiag.auto.currentOffset.value`)

    // 模拟向上滚动 400px（回看）
    await cdp.eval(`(() => {
      const stage = document.querySelector('.stage');
      const ev = new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true });
      stage.dispatchEvent(ev);
      return true;
    })()`)
    await sleep(400)

    const afterScroll = await cdp.eval(`({
      userScrolling: window.__lrcDiag.auto.userScrolling.value,
      offset: window.__lrcDiag.auto.currentOffset.value,
      playing: window.__lrcDiag.player.playing,
      time: Number(window.__lrcDiag.player.currentTime.toFixed(2)),
    })`)

    check('滚轮后进入"用户滚动"状态', afterScroll.userScrolling === true, JSON.stringify(afterScroll))
    check('视图确实被移动了', Math.abs(afterScroll.offset - offset0) > 100, `${offset0.toFixed(1)} → ${afterScroll.offset.toFixed(1)}`)
    check('回看时播放仍在继续', afterScroll.playing === true, `playing=${afterScroll.playing}`)
    check('回看时播放时间继续推进', afterScroll.time > t0, `${t0} → ${afterScroll.time}`)

    // 关键：等待 1 秒，视图不应被自动拉回
    const holdOffset = afterScroll.offset
    await sleep(1000)
    const held = await cdp.eval(`({
      offset: window.__lrcDiag.auto.currentOffset.value,
      userScrolling: window.__lrcDiag.auto.userScrolling.value,
    })`)
    check(
      '1 秒内视图未被强行拉回（核心体验要求）',
      Math.abs(held.offset - holdOffset) < 2,
      `${holdOffset.toFixed(1)} → ${held.offset.toFixed(1)}`,
    )
    check('仍在用户滚动状态', held.userScrolling === true)

    // "回到当前行"按钮出现
    const resumeBtn = await cdp.eval(`!!document.querySelector('.stage__resume')`)
    check('出现"回到当前行"按钮', resumeBtn === true)

    // 等 3 秒自动恢复跟随
    await sleep(2400)
    const resumed = await cdp.eval(`({
      userScrolling: window.__lrcDiag.auto.userScrolling.value,
      offset: window.__lrcDiag.auto.currentOffset.value,
    })`)
    check('3 秒后自动恢复跟随', resumed.userScrolling === false, JSON.stringify(resumed))

    // 恢复后应重新居中
    await sleep(900)
    const c = await cdp.eval(measureCentering)
    check('恢复跟随后重新居中（≤2px）', c && c.deviation <= 2, `偏差 ${c?.deviation?.toFixed(2)}px`)

    // 手动点击"回到当前行"也应立即恢复
    await cdp.eval(`(() => {
      const stage = document.querySelector('.stage');
      stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true, cancelable: true }));
      return true;
    })()`)
    await sleep(300)
    const manualOffset = await cdp.eval(`window.__lrcDiag.auto.currentOffset.value`)
    await cdp.eval(`document.querySelector('.stage__resume')?.click()`)
    await sleep(700)
    const afterClick = await cdp.eval(`({
      userScrolling: window.__lrcDiag.auto.userScrolling.value,
      offset: window.__lrcDiag.auto.currentOffset.value,
    })`)
    check('点击"回到当前行"立即恢复跟随', afterClick.userScrolling === false, JSON.stringify(afterClick))
    check('点击后视图位置被纠正', Math.abs(afterClick.offset - manualOffset) > 20, `${manualOffset.toFixed(1)} → ${afterClick.offset.toFixed(1)}`)

    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(300)
  }

  // ══════════════════════════════════════════════
  group('验证 4 · RGB 调色盘 / HSL 色相环 / HEX 非法值')
  {
    // 打开设置面板并展开"当前行颜色"
    await cdp.eval(`(() => {
      const s = window.__lrcDiag.settings;
      if (!s.drawerOpen) s.openDrawer();
      return true;
    })()`)
    await sleep(700)

    // 拖 RGB 的 R 通道。
    // 注意默认色是纯白 #ffffff，把 R 拖到 255 属于"原地不动"，测不出变化；
    // 必须先取一个非极值颜色，或把 R 拖到 0 —— 这里选后者（白 → 青），变化明确。
    const rgbResult = await cdp.eval(`(async () => {
      const picker = document.querySelector('.cp');
      if (!picker) return { error: '调色盘未渲染' };
      const sliders = [...picker.querySelectorAll('input[type=range]')];
      // 先设成一个非极值色，确保后续拖动一定产生变化
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(sliders[0], '128');
      sliders[0].dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const mid = window.__lrcDiag.settings.settings.color.active;

      // 再把 R 拖到 0（应明显变青）
      setter.call(sliders[0], '0');
      sliders[0].dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 350));
      return {
        mid,
        color: window.__lrcDiag.settings.settings.color.active,
        rendered: getComputedStyle(document.querySelector('.lyric-line.is-active')).color,
      };
    })()`)
    check('拖动 RGB 的 R 通道后颜色实时变化', rgbResult.mid === '#80ffff' && rgbResult.color === '#00ffff', JSON.stringify(rgbResult))
    check(
      '舞台当前行颜色随之实时更新',
      rgbResult.rendered === 'rgb(0, 255, 255)',
      `rendered=${rgbResult.rendered}`,
    )

    // 拖动 HSL 色相环
    const hueResult = await cdp.eval(`(async () => {
      const ring = document.querySelector('.cp__ring');
      if (!ring) return { error: '色相环未渲染' };
      const rect = ring.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // 拖到环的右侧（应为 90 度附近，偏青绿）
      const ev = (type, x, y) => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse',
        clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1,
      });
      const targetX = cx + rect.width * 0.45;
      ring.dispatchEvent(ev('pointerdown', targetX, cy));
      await new Promise(r => setTimeout(r, 250));
      const after1 = window.__lrcDiag.settings.settings.color.active;

      // 再拖到下方（180 度）
      ring.dispatchEvent(ev('pointermove', cx, cy + rect.height * 0.45));
      await new Promise(r => setTimeout(r, 250));
      const after2 = window.__lrcDiag.settings.settings.color.active;
      ring.dispatchEvent(ev('pointerup', cx, cy + rect.height * 0.45));
      await new Promise(r => setTimeout(r, 200));
      return { after1, after2 };
    })()`)
    check('拖动 HSL 色相环实时变色', hueResult.after1 && hueResult.after1 !== rgbResult.color, JSON.stringify(hueResult))
    check('继续拖动色相环颜色继续变化', hueResult.after2 && hueResult.after2 !== hueResult.after1, JSON.stringify(hueResult))

    // HEX 非法值：标红且不生效
    const hexResult = await cdp.eval(`(async () => {
      const input = document.querySelector('.cp__hex-input');
      const before = window.__lrcDiag.settings.settings.color.active;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '#zzz');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 350));
      const after = window.__lrcDiag.settings.settings.color.active;
      const cls = input.className;
      const ariaInvalid = input.getAttribute('aria-invalid');
      const errShown = !!document.querySelector('.cp__error');
      return { before, after, cls, ariaInvalid, errShown };
    })()`)
    check('HEX 非法值不生效（颜色未被改动）', hexResult.before === hexResult.after, `${hexResult.before} → ${hexResult.after}`)
    check('HEX 非法值输入框标红', hexResult.cls.includes('is-invalid'), hexResult.cls)
    check('HEX 非法值设置 aria-invalid（无障碍）', hexResult.ariaInvalid === 'true')
    check('HEX 非法值给出错误提示', hexResult.errShown === true)

    // HEX 合法值应生效
    const hexOk = await cdp.eval(`(async () => {
      const input = document.querySelector('.cp__hex-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '#00ff00');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 350));
      return {
        color: window.__lrcDiag.settings.settings.color.active,
        invalid: input.className.includes('is-invalid'),
      };
    })()`)
    check('HEX 合法值生效', hexOk.color === '#00ff00', `→ ${hexOk.color}`)
    check('合法值不再标红', hexOk.invalid === false)

    await cdp.eval(`window.__lrcDiag.settings.closeDrawer()`)
    await sleep(400)
  }

  // ══════════════════════════════════════════════
  group('验证 5 · 刷新后设置恢复 / 重置清空 localStorage')
  {
    // 改几项有代表性的设置
    await cdp.eval(`(() => {
      const s = window.__lrcDiag.settings;
      s.set('font.size', 72);
      s.set('font.letterSpacing', 0.2);
      s.set('font.lineHeight', 2.2);
      s.set('font.scale', 1.8);
      s.set('color.active', '#ff00aa');
      s.set('color.normal', '#00ffcc');
      s.set('layout.align', 'left');
      s.set('motion.transitionMs', 500);
      s.set('motion.reduceMotion', true);
      return true;
    })()`)
    // 等防抖写入（300ms）
    await sleep(900)

    const stored = await cdp.eval(`window.__lrcDiag.storedSettings()`)
    check('设置已写入 localStorage', typeof stored === 'string' && stored.length > 0, `长度 ${stored?.length}`)

    const parsed = stored ? JSON.parse(stored) : null
    check('localStorage 中保存的值正确', parsed?.font?.size === 72 && parsed?.color?.active === '#ff00aa', JSON.stringify(parsed?.font))

    // 刷新页面
    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(2600)

    const restored = await cdp.eval(`(() => {
      const s = window.__lrcDiag.settings.settings;
      return {
        size: s.font.size,
        letterSpacing: s.font.letterSpacing,
        lineHeight: s.font.lineHeight,
        scale: s.font.scale,
        active: s.color.active,
        normal: s.color.normal,
        align: s.layout.align,
        transitionMs: s.motion.transitionMs,
        reduceMotion: s.motion.reduceMotion,
      };
    })()`)

    const expect = {
      size: 72,
      letterSpacing: 0.2,
      lineHeight: 2.2,
      scale: 1.8,
      active: '#ff00aa',
      normal: '#00ffcc',
      align: 'left',
      transitionMs: 500,
      reduceMotion: true,
    }
    const mismatches = Object.entries(expect).filter(([k, v]) => restored[k] !== v)
    check(
      '刷新后全部设置原样恢复',
      mismatches.length === 0,
      mismatches.length ? mismatches.map(([k, v]) => `${k}: 期望 ${v} 实际 ${restored[k]}`).join('; ') : '',
    )

    // CSS 变量也应恢复（证明真的作用到界面）
    const cssVar = await cdp.eval(
      `getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--lrc-font-size').trim()`,
    )
    check('刷新后 CSS 变量同步恢复', cssVar === '72px', `--lrc-font-size=${cssVar}`)

    const reduceClass = await cdp.eval(`document.querySelector('.app-shell').classList.contains('reduce-motion')`)
    check('刷新后"减少动态效果"开关状态恢复', reduceClass === true)

    // ── 重置 ──
    await cdp.eval(`window.__lrcDiag.settings.openDrawer()`)
    await sleep(600)

    const beforeReset = await cdp.eval(`window.__lrcDiag.storedSettings()`)
    check('重置前 localStorage 有内容', typeof beforeReset === 'string' && beforeReset.length > 0)

    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('#settings-drawer button')].find(b => b.textContent.trim() === '重置');
      if (!btn) return false;
      btn.click();
      return true;
    })()`)
    await sleep(800)

    const afterResetStored = await cdp.eval(`window.__lrcDiag.storedSettings()`)
    check('重置后 localStorage 被清空', afterResetStored === null, `实际: ${afterResetStored}`)

    const afterReset = await cdp.eval(`(() => {
      const s = window.__lrcDiag.settings.settings;
      return { size: s.font.size, active: s.color.active, align: s.layout.align, reduceMotion: s.motion.reduceMotion };
    })()`)
    check(
      '重置后设置回到默认值',
      afterReset.size === 40 && afterReset.active === '#ffffff' && afterReset.align === 'center' && afterReset.reduceMotion === false,
      JSON.stringify(afterReset),
    )

    const cssAfterReset = await cdp.eval(
      `getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--lrc-font-size').trim()`,
    )
    check('重置后 CSS 变量回到默认', cssAfterReset === '40px', `--lrc-font-size=${cssAfterReset}`)

    await cdp.eval(`window.__lrcDiag.settings.closeDrawer()`)
    await sleep(400)
  }

  // ══════════════════════════════════════════════
  group('验证 6 · 2000 行歌词播放 30 秒帧率 ≥55fps')
  {
    // 注入 2000 行合成歌词
    const inject = await cdp.eval(`(() => {
      const lines = [];
      for (let i = 0; i < 2000; i++) {
        const t = i * 0.4;
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = (t % 60).toFixed(2).padStart(5, '0');
        lines.push('[' + mm + ':' + ss + ']第 ' + (i + 1) + ' 行测试歌词内容');
      }
      const text = '[ti:压力测试]\\n' + lines.join('\\n');
      window.__lrcDiag.lyrics.loadFromText(text, { fileName: 'stress-2000.lrc' });
      return window.__lrcDiag.lyrics.count;
    })()`)
    check('已注入 2000 行歌词', inject === 2000, `实际 ${inject}`)

    await sleep(2500)

    // 实测结论：不虚拟化也不会掉帧，因此这里不断言"必须虚拟化"，
    // 而是断言真正的性能目标（帧率、长任务），并记录 DOM 规模作为参考数据。
    const rendered = await cdp.eval(`document.querySelectorAll('.lyric-line').length`)
    const trackHeight = await cdp.eval(`document.querySelector('.stage__track')?.scrollHeight ?? 0`)
    console.log(`      DOM 行数 ${rendered}，轨道高度 ${trackHeight}px`)
    check('2000 行歌词已完整渲染', rendered === 2000, `实际 ${rendered}`)

    // 开始播放并测量 30 秒帧率
    await cdp.eval(`window.__lrcDiag.engine.seek(0); window.__lrcDiag.engine.play()`)
    await sleep(800)

    const fps = await cdp.eval(`(async () => {
      const frames = [];
      let last = performance.now();
      const start = last;
      let rafId = 0;
      let longTasks = 0;

      // 同时统计长任务（>50ms），这是"无长任务"验收项的判据
      let observer = null;
      if (typeof PerformanceObserver !== 'undefined') {
        try {
          observer = new PerformanceObserver((list) => { longTasks += list.getEntries().length; });
          observer.observe({ entryTypes: ['longtask'] });
        } catch (e) { observer = null; }
      }

      await new Promise((resolve) => {
        const loop = (now) => {
          frames.push(now - last);
          last = now;
          if (now - start >= 30000) { resolve(); return; }
          rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);
      });
      if (observer) observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);

      // 去掉第一帧（rAF 首次间隔不准）
      const dts = frames.slice(1).filter(d => d > 0);
      const elapsed = dts.reduce((a, b) => a + b, 0);
      const avgFps = dts.length / (elapsed / 1000);
      const sorted = [...dts].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
      const worst = sorted[sorted.length - 1] || 0;
      const slowFrames = dts.filter(d => d > 33.4).length;

      return {
        totalFrames: dts.length,
        elapsedSec: Number((elapsed / 1000).toFixed(2)),
        avgFps: Number(avgFps.toFixed(2)),
        p95FrameMs: Number(p95.toFixed(2)),
        worstFrameMs: Number(worst.toFixed(2)),
        slowFrames,
        slowPct: Number(((slowFrames / dts.length) * 100).toFixed(2)),
        longTasks,
        renderedLines: document.querySelectorAll('.lyric-line').length,
        currentTime: Number(window.__lrcDiag.player.currentTime.toFixed(2)),
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      };
    })()`)

    console.log(`      实测数据：${JSON.stringify(fps)}`)

    check(
      '2000 行播放 30 秒平均帧率 ≥55fps',
      fps.avgFps >= 55,
      `实际 ${fps.avgFps}fps（${fps.totalFrames} 帧 / ${fps.elapsedSec}s）`,
    )
    check(
      'p95 帧耗时 ≤25ms（无明显卡顿）',
      fps.p95FrameMs <= 25,
      `p95=${fps.p95FrameMs}ms，最差=${fps.worstFrameMs}ms`,
    )
    check('30 秒播放期间确实在推进', fps.currentTime > 25, `currentTime=${fps.currentTime}`)

    console.log(`      长任务（>50ms）数量：${fps.longTasks}，慢帧 ${fps.slowFrames} 个（${fps.slowPct}%）`)

    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(300)

    // 加到 10000 行再压一次，确认余量（覆盖"超长歌词"场景）
    await cdp.eval(`(() => {
      const lines = [];
      for (let i = 0; i < 10000; i++) {
        const t = i * 0.3;
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = (t % 60).toFixed(2).padStart(5, '0');
        lines.push('[' + mm + ':' + ss + ']第 ' + (i + 1) + ' 行超长测试歌词');
      }
      window.__lrcDiag.lyrics.loadFromText('[ti:极压测试]\\n' + lines.join('\\n'), { fileName: 'stress-10000.lrc' });
      return window.__lrcDiag.lyrics.count;
    })()`)
    await sleep(3000)

    const fps10k = await cdp.eval(`(async () => {
      window.__lrcDiag.engine.seek(0);
      window.__lrcDiag.engine.play();
      await new Promise(r => setTimeout(r, 800));
      const frames = []; let last = performance.now(); const start = last;
      await new Promise((resolve) => {
        const loop = (now) => {
          frames.push(now - last); last = now;
          if (now - start >= 10000) { resolve(); return; }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      window.__lrcDiag.engine.pause();
      const dts = frames.slice(1).filter(d => d > 0);
      const elapsed = dts.reduce((a, b) => a + b, 0);
      return {
        avgFps: Number((dts.length / (elapsed / 1000)).toFixed(2)),
        worstMs: Number(Math.max(...dts).toFixed(1)),
        domRows: document.querySelectorAll('.lyric-line').length,
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      };
    })()`)
    console.log(`      10000 行实测：${JSON.stringify(fps10k)}`)
    check(
      '10000 行超长歌词仍能保持 ≥55fps（余量验证）',
      fps10k.avgFps >= 55,
      `实际 ${fps10k.avgFps}fps，最差帧 ${fps10k.worstMs}ms，堆 ${fps10k.heapMB}MB`,
    )
  }

  // ══════════════════════════════════════════════
  group('验证 7 · 移除「调试 · 跳行」胶囊')
  {
    const capsuleGone = await cdp.eval(`document.querySelector('.stage__preview') === null`)
    check('右下角调试胶囊已被移除', capsuleGone === true)

    const noStageBadge = await cdp.eval(`!document.body.innerText.includes('调试 · 跳行')`)
    check('页面上不再出现"调试 · 跳行"字样', noStageBadge === true)

    // 自动滚动存在（它就是取代调试工具的功能）
    const autoWorks = await cdp.eval(`(() => {
      const s = window.__lrcDiag.lyrics;
      s.loadDemo();
      return true;
    })()`)
    await sleep(600)
    await cdp.eval(`window.__lrcDiag.engine.seek(20)`)
    await sleep(900)
    const c = await cdp.eval(measureCentering)
    check('自动滚动已取代手动跳行（当前行自动居中）', c && c.deviation <= 2, `偏差 ${c?.deviation?.toFixed(2)}px`)
    void autoWorks
  }

  // ══════════════════════════════════════════════
  group('通用 · 控制台无错误')
  {
    check('全程无未捕获异常 / console.error', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '))
  }

  console.log(`\n${'─'.repeat(56)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed) console.log(`\n失败项：\n  - ${failures.join('\n  - ')}`)
  console.log('─'.repeat(56))

  cdp.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n脚本异常: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
})
