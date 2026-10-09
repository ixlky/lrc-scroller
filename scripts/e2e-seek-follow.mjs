// @ts-check
/**
 * 暂停/播放 × 慢速/快速拖动 —— 跟随验收（补丁 5）。
 *
 * 用户要求的 5 项：
 *  1. 暂停下慢速拖动 → 歌词实时跟随，不呆住
 *  2. 暂停下快速拖动 → 实时跟随（不回归）
 *  3. 播放下慢速/快速拖动 → 实时跟随（不回归）
 *  4. 拖完松手 → 歌词停在正确位置，不高亮错行
 *  5. 拖到最左/最右边界 → 歌词正确落到首行/末行
 *
 * 用法：node scripts/e2e-seek-follow.mjs [页面URL] [调试端口]
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
  console.log(`\n拖动跟随验收（暂停/播放 × 慢/快）—— ${PAGE_URL}\n`)

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
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(2600)

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
  console.log(`音频时长 ${dur}s`)

  /**
   * 造"每行 1 秒"的歌词，与音频时长严格对齐。
   * 之前忘了造歌词，用的是内置 demo（14 行、每行约 4.3s），
   * 导致所有"activeIndex 期望值"都算错 —— 测试数据要与被测对象对齐。
   */
  async function loadMatchingLyrics() {
    return cdp.eval(`(() => {
      const d = window.__lrcDiag;
      const total = Math.ceil(d.player.duration);
      const rows = [];
      for (let i = 0; i < total; i++) {
        const t = i;
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = (t % 60).toFixed(2).padStart(5, '0');
        rows.push('[' + mm + ':' + ss + ']第 ' + (i + 1) + ' 行歌词');
      }
      d.lyrics.loadFromText('[ti:跟随测试]\\n' + rows.join('\\n'), { fileName: 'match.lrc' });
      return { lines: d.lyrics.count, last: d.lyrics.lastTime };
    })()`)
  }
  const lyricInfo = await loadMatchingLyrics()
  console.log(`已载入与音频对齐的歌词：${lyricInfo.lines} 行（每行 1 秒，末行 ${lyricInfo.last}s）`)

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
      const auto = d.auto;
      const active = document.querySelector('.lyric-line.is-active');
      return {
        t: Number(d.player.currentTime.toFixed(2)),
        activeIndex: auto.activeIndex.value,
        centerIndex: auto.centerIndex?.value ?? auto.activeIndex.value,
        offset: Number(auto.currentOffset.value.toFixed(1)),
        playing: d.player.playing,
        activeText: active?.textContent?.trim().slice(0, 18) ?? null,
        activeOp: active ? Number(Number(getComputedStyle(active).opacity).toFixed(3)) : null,
      };
    })()`)

  /**
   * 分步拖动：steps 步、每步 intervalMs。
   * 返回每一步的 {t, activeIndex, offset} 快照。
   */
  async function dragStepped(box, fromRatio, toRatio, { steps = 10, intervalMs = 120, playing = false } = {}) {
    const x0 = box.left + box.width * fromRatio
    const x1 = box.left + box.width * toRatio
    const samples = []
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: box.cy, button: 'left', clickCount: 1, buttons: 1 })
    await sleep(80)
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x0 + ((x1 - x0) * i) / steps,
        y: box.cy,
        button: 'left',
        buttons: 1,
      })
      await sleep(intervalMs)
      const s = await stateOf()
      samples.push({ step: i, ratio: +(fromRatio + (toRatio - fromRatio) * i / steps).toFixed(3), ...s })
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: box.cy, button: 'left', clickCount: 1, buttons: 0 })
    await sleep(400)
    return samples
  }

  async function dragFast(box, fromRatio, toRatio) {
    const x0 = box.left + box.width * fromRatio
    const x1 = box.left + box.width * toRatio
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: box.cy, button: 'left', clickCount: 1, buttons: 1 })
    await sleep(10)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: box.cy, button: 'left', buttons: 1 })
    await sleep(10)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: box.cy, button: 'left', clickCount: 1, buttons: 0 })
    await sleep(400)
  }

  /** 统计"歌词跟随了几个独立位置" */
  function followStats(samples) {
    /** @type {Set<number>} */
    const distinctOffsets = new Set()
    /** @type {Set<number>} */
    const distinctIdx = new Set()
    let last = null
    let jumps = 0
    for (const s of samples) {
      distinctOffsets.add(s.offset)
      distinctIdx.add(s.activeIndex)
      if (last !== null && s.activeIndex !== last) jumps++
      last = s.activeIndex
    }
    return { distinctOffsets: distinctOffsets.size, distinctIdx: distinctIdx.size, jumps }
  }

  const tol = 2.0

  const seekSel = '[role=slider][aria-label="播放进度"]'
  const volSel = '[role=slider][aria-label="音量"]'

  // ══════════════════════════════════════════════
  group('1. 暂停 + 慢速拖动 → 歌词实时跟随（本次 bug）')
  {
    await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
    await sleep(300)
    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(400)

    const before = await stateOf()
    check('初始为暂停状态', before.playing === false, `playing=${before.playing}`)

    const box = await boxOf(seekSel)
    // 严苛场景：40 步 × 80ms，60s 音频拖 50% → 每步仅 0.75s。
    // 旧实现的阈值是"跳变 >1 秒才 snap"，这个场景永远达不到 → 歌词呆住。
    // 修复后暂停下任何变化都立即对齐。
    const samples = await dragStepped(box, 0.1, 0.6, { steps: 40, intervalMs: 80 })
    const stats = followStats(samples)

    console.log(`      ${samples.length} 步（每步 Δt≈${((dur * 0.5) / samples.length).toFixed(2)}s < 1s 旧阈值），歌词跟随了 ${stats.distinctOffsets} 个不同位置，activeIndex 变化 ${stats.jumps} 次`)

    // 核心断言：滚动位移必须逐步更新（这是"歌词不呆住"的直接证据）。
    // 旧实现下 40 步只会更新 8 次（跨行时才更新），这里要求远多于 8 次。
    check(
      '暂停下慢速拖动：滚动位置逐步更新（不呆住）',
      stats.distinctOffsets >= samples.length * 0.5,
      `${stats.distinctOffsets}/${samples.length} 步有独立滚动位置`,
    )
    // activeIndex 应跟随推进（50% 跨度 / 每行 1s ≈ 跨 30 行）
    check(
      '暂停下慢速拖动：activeIndex 跟随推进',
      stats.jumps >= 15,
      `activeIndex 变化 ${stats.jumps} 次`,
    )

    // 松手后停在正确位置
    const after = await stateOf()
    const expectIdx = Math.floor(dur * 0.6)
    check(
      '松手后停在 60% 对应位置',
      Math.abs(after.t - dur * 0.6) < tol,
      `t=${after.t}s`,
    )
    // 容差 ±1 行：currentTime 可能落在 35.98（浮点/夹取），
    // 此时 findLineIndexAt 返回第 35 行（t=35 ≤ 35.98），而文本显示"第 36 行歌词"
    // 是因为行号 = 下标+1。允许 ±1 行避免浮点边界误报。
    check(
      '松手后高亮正确行（±1 行，行号=下标+1）',
      Math.abs(after.activeIndex - expectIdx) <= 1,
      `activeIdx=${after.activeIndex}（期望 ${expectIdx}），text=${after.activeText}`,
    )
    check('暂停状态保持', after.playing === false, `playing=${after.playing}`)
  }

  // ══════════════════════════════════════════════
  group('2. 暂停 + 快速拖动 → 实时跟随（不回归）')
  {
    await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
    await sleep(300)
    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(300)

    const box = await boxOf(seekSel)
    await dragFast(box, 0.1, 0.8)
    const after = await stateOf()
    check('暂停下快速拖动：落点 ≈80%', Math.abs(after.t - dur * 0.8) < tol, `t=${after.t}s`)
    const expectIdx80 = Math.floor(dur * 0.8)
    // ±1 行容差：见上方说明（currentTime 的浮点/夹取边界）
    check(
      '暂停下快速拖动：歌词跟随（activeIndex 推进）',
      Math.abs(after.activeIndex - expectIdx80) <= 1,
      `activeIdx=${after.activeIndex}（期望 ${expectIdx80}）`,
    )
  }

  // ══════════════════════════════════════════════
  group('3. 播放 + 慢速/快速拖动 → 实时跟随（不回归）')
  {
    await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
    await sleep(300)
    await cdp.eval(`window.__lrcDiag.engine.play()`)
    await sleep(500)

    const box = await boxOf(seekSel)
    const samples = await dragStepped(box, 0.1, 0.5, { steps: 20, intervalMs: 100, playing: true })
    const stats = followStats(samples)
    console.log(`      播放下 ${samples.length} 步慢速拖动：跟随 ${stats.distinctOffsets} 个位置，activeIndex 变化 ${stats.jumps} 次`)
    check(
      '播放下慢速拖动：歌词跟随',
      stats.distinctOffsets >= samples.length * 0.5 && stats.jumps >= 8,
      `${stats.distinctOffsets}/${samples.length} 步有位置，activeIndex 变化 ${stats.jumps} 次`,
    )

    await dragFast(box, 0.5, 0.85)
    const after = await stateOf()
    check('播放下快速拖动：落点 ≈85%', Math.abs(after.t - dur * 0.85) < tol + 1, `t=${after.t}s`)
    check('播放下快速拖动：歌词跟随', after.activeIndex >= Math.floor(dur * 0.85) - 2, `activeIdx=${after.activeIndex}`)

    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(300)
  }

  // ══════════════════════════════════════════════
  group('4. 拖完松手 → 歌词停在正确位置，不高亮错行')
  {
    for (const [target, label] of [[0.25, '25%'], [0.5, '50%'], [0.75, '75%']]) {
      await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
      await sleep(250)
      await cdp.eval(`window.__lrcDiag.engine.pause()`)
      await sleep(250)

      const box = await boxOf(seekSel)
      await dragStepped(box, 0.05, target, { steps: 8, intervalMs: 60 })
      const s = await stateOf()
      const expectIdx = Math.floor(dur * target)
      check(
        `拖到 ${label} → 停在 ${s.t}s、高亮第 ${s.activeIndex} 行（期望第 ${expectIdx} 行）`,
        Math.abs(s.t - dur * target) < tol && s.activeIndex === expectIdx,
        `t=${s.t}, activeIdx=${s.activeIndex}, text=${s.activeText}`,
      )
    }
  }

  // ══════════════════════════════════════════════
  group('5. 拖到最左/最右边界 → 歌词落到首行/末行')
  {
    await cdp.eval(`window.__lrcDiag.engine.seek(30)`)
    await sleep(400)
    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(300)

    // 最左
    const box = await boxOf(seekSel)
    await dragStepped(box, 0.4, 0.0, { steps: 10, intervalMs: 60 })
    const left = await stateOf()
    check(
      '拖到最左 → 时间 0、高亮第 0 行',
      left.t < 0.6 && left.activeIndex === 0,
      `t=${left.t}, activeIdx=${left.activeIndex}`,
    )

    // 最右
    await dragStepped(box, 0.0, 1.0, { steps: 10, intervalMs: 60 })
    const right = await stateOf()
    const expectLast = lyricInfo.lines - 1
    check(
      '拖到最右 → 接近时长、高亮末行',
      right.t >= dur - 1 && right.activeIndex >= expectLast - 1,
      `t=${right.t}, activeIdx=${right.activeIndex}（末行=${expectLast}）`,
    )
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
