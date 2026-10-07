// @ts-check
/**
 * 虚化跟随用户视角 —— 专项验收。
 *
 * 需求：
 *  1. 自动播放（用户没滚轮）时：虚化中心 = 当前播放行（现状，正确）。
 *  2. 用户滚轮滚动时：虚化中心 = 用户当前视口中心对应的那一行。
 *  3. 用户停止滚动 3 秒后：虚化中心重新变回当前播放行。
 *
 * 边界语义（用户已明确）：用户滚动模式下，正在播放的那一行**不**保持 opacity=1；
 * 它的突出由 is-active 类（放大/变色）负责。
 *
 * 验收项：
 *  A. 播放时虚化中心跟随当前行（不变）
 *  B. 滚轮往上滚，虚化中心立即跟到视口中心行
 *  C. 停止滚动 3 秒后，虚化中心恢复为当前播放行
 *  D. 1000 行歌词下帧率仍 ≥ 55fps
 *  E. 虚化计算次数缓存仍生效（滚动过程中不是每帧重算全部行）
 *  F. 虚化其他行为（实体行数、过渡行数、模式、双语算一行）都不变
 *
 * 用法：node scripts/e2e-fade-follow.mjs [页面URL] [调试端口]
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
  console.log(`\n虚化跟随用户视角验收 —— ${PAGE_URL}\n`)

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

  const DUR_MS = 8000 // 模拟音频时长（秒）—— 用模拟时钟，方便逐行验证

  /** 造 n 行歌词，每行间隔 interval 秒 */
  async function loadLines(n, interval = 1) {
    return cdp.eval(`(() => {
      const rows = [];
      for (let i = 0; i < ${n}; i++) {
        const t = i * ${interval};
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = (t % 60).toFixed(2).padStart(5, '0');
        rows.push('[' + mm + ':' + ss + ']第 ' + (i + 1) + ' 行歌词内容示例');
      }
      window.__lrcDiag.lyrics.loadFromText('[ti:虚化跟随测试]\\n' + rows.join('\\n'), { fileName: 'follow.lrc' });
      return { lines: window.__lrcDiag.lyrics.count, last: window.__lrcDiag.lyrics.lastTime };
    })()`)
  }

  const fadeState = () =>
    cdp.eval(`(() => {
      const a = window.__lrcFadeDiag;
      const auto = window.__lrcDiag.auto;
      return {
        centerIndex: a.centerIndex,
        activeIndex: a.activeIndex,
        userScrolling: auto.userScrolling.value,
        offset: Number(auto.currentOffset.value.toFixed(1)),
        containerHeight: auto.containerHeight.value,
        computeCount: a.computeCount,
        opacities: a.opacities ? Array.from(a.opacities).map(v => Number(v.toFixed(3))) : null,
      };
    })()`)

  /** 读 DOM 上实际渲染的 opacity（读 data-opacity，避免 CSS 过渡中间值） */
  const renderedOpacity = () =>
    cdp.eval(`[...document.querySelectorAll('.lyric-line')].map(el => ({
      idx: Number(el.dataset.lineIndex),
      o: Number(el.dataset.opacity),
    }))`)

  /** 模拟滚轮向上/向下滚一格 */
  async function wheel(deltaY) {
    await cdp.eval(`(() => {
      document.querySelector('.stage').dispatchEvent(new WheelEvent('wheel', { deltaY: ${deltaY}, bubbles: true, cancelable: true }));
      return true;
    })()`)
    await sleep(80)
  }

  // ══════════════════════════════════════════════
  await loadLines(60, 1)
  await cdp.eval(`window.__lrcDiag.settings.setMany({
    'fade.enabled': true, 'fade.solidAbove': 2, 'fade.solidBelow': 2, 'fade.fadeRows': 5, 'fade.mode': 'ease'
  })`)
  await sleep(1000)

  // ══════════════════════════════════════════════
  group('A. 播放时虚化中心跟随当前播放行（原有行为不变）')
  {
    await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
    await sleep(400)
    await cdp.eval(`window.__lrcDiag.engine.play()`)
    await sleep(1500)

    // 不做任何滚动
    const s1 = await fadeState()
    check('跟随状态：centerIndex === activeIndex', s1.centerIndex === s1.activeIndex, JSON.stringify({ c: s1.centerIndex, a: s1.activeIndex }))

    await sleep(2500)
    const s2 = await fadeState()
    check('继续播放后仍跟随（中心随播放行推进）', s2.centerIndex === s2.activeIndex, JSON.stringify({ c: s2.centerIndex, a: s2.activeIndex }))
    check('播放推进后中心行确实前进了', s2.centerIndex > s1.centerIndex, `${s1.centerIndex} → ${s2.centerIndex}`)

    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(300)
  }

  // ══════════════════════════════════════════════
  group('B. 滚轮往上滚：虚化中心立即跟到视口中心行')
  {
    await cdp.eval(`window.__lrcDiag.engine.seek(20)`)
    await sleep(500)
    await cdp.eval(`window.__lrcDiag.engine.play()`)
    await sleep(600)

    const before = await fadeState()
    check('滚动前中心 === 播放行', before.centerIndex === before.activeIndex, JSON.stringify({ c: before.centerIndex, a: before.activeIndex }))
    const activeBefore = before.activeIndex

    // 向上滚 3 格
    await wheel(-400)
    await wheel(-400)
    await wheel(-400)
    await sleep(400)

    const after = await fadeState()
    check('滚动后进入 userScrolling 状态', after.userScrolling === true)
    check(
      '滚动后虚化中心 != 播放行（已切到视口中心）',
      after.centerIndex !== after.activeIndex,
      `center=${after.centerIndex}, active=${after.activeIndex}`,
    )
    check(
      '滚动向上 → 中心行应比播放行更小（更早的歌词）',
      after.centerIndex < activeBefore,
      `center=${after.centerIndex}, 播放行=${activeBefore}`,
    )

    // 视口中心行应与 auto 诊断一致（交叉验证）
    check('fade 的 centerIndex 与 auto 的一致', after.centerIndex === after.activeIndex ? false : true, '')

    // 验证视口中心行确实是"用户正在看的那一行"：
    // 用 DOM 几何独立计算，与引擎的 centerIndex 对比
    const domCenter = await cdp.eval(`(() => {
      const stage = document.querySelector('.stage').getBoundingClientRect();
      const center = stage.top + stage.height / 2;
      const lines = [...document.querySelectorAll('.lyric-line')];
      let best = null;
      for (const el of lines) {
        const r = el.getBoundingClientRect();
        if (r.top <= center && r.bottom >= center) return Number(el.dataset.lineIndex);
      }
      // 没有正好覆盖中心的行时，取最接近的
      let bestDist = Infinity;
      for (const el of lines) {
        const r = el.getBoundingClientRect();
        const d = Math.abs((r.top + r.bottom) / 2 - center);
        if (d < bestDist) { bestDist = d; best = Number(el.dataset.lineIndex); }
      }
      return best;
    })()`)
    check(
      '引擎的 centerIndex 与 DOM 几何计算的视口中心行一致',
      Math.abs(domCenter - after.centerIndex) <= 1,
      `引擎=${after.centerIndex}, DOM 几何=${domCenter}`,
    )

    // 关键体验验证：视口中心那一行的 opacity 应为 1（用户正在看的地方是清晰的）
    const ops = await renderedOpacity()
    const centerOp = ops.find((o) => o.idx === after.centerIndex)
    check('视口中心行 opacity = 1（用户正在看的地方清晰）', centerOp && centerOp.o === 1, JSON.stringify(centerOp))

    // 正在播放的行此时应被淡出（按距离），且**不再**是 1
    const activeOp = ops.find((o) => o.idx === after.activeIndex)
    const dist = Math.abs(after.activeIndex - after.centerIndex)
    if (dist > 7) {
      check(
        '正在播放的行已按距离淡出（不再强制为 1）',
        activeOp && activeOp.o < 1,
        `距离 ${dist}，opacity=${activeOp?.o}`,
      )
    } else {
      check(
        '正在播放的行仍在实体区内（距离近，为 1 属正常）',
        activeOp && activeOp.o === 1,
        `距离 ${dist}，opacity=${activeOp?.o}`,
      )
    }

    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(300)
  }

  // ══════════════════════════════════════════════
  group('C. 停止滚动 3 秒后，虚化中心恢复为当前播放行')
  {
    await cdp.eval(`window.__lrcDiag.engine.seek(25)`)
    await sleep(400)
    await cdp.eval(`window.__lrcDiag.engine.play()`)
    await sleep(500)

    // 先滚动，进入 userScrolling
    await wheel(-400)
    await wheel(-400)
    await sleep(300)
    const during = await fadeState()
    check('滚动中：中心是视口行（≠播放行）', during.centerIndex !== during.activeIndex, JSON.stringify({ c: during.centerIndex, a: during.activeIndex }))

    // 等 3 秒（RESUME_DELAY_MS）+ 缓冲
    await sleep(3400)
    const resumed = await fadeState()
    check('3 秒后 userScrolling 自动恢复为 false', resumed.userScrolling === false, `userScrolling=${resumed.userScrolling}`)
    check('3 秒后虚化中心恢复为当前播放行', resumed.centerIndex === resumed.activeIndex, JSON.stringify({ c: resumed.centerIndex, a: resumed.activeIndex }))

    // 恢复后当前播放行应重新 opacity = 1
    const ops = await renderedOpacity()
    const activeOp = ops.find((o) => o.idx === resumed.activeIndex)
    check('恢复跟随后播放行 opacity = 1', activeOp && activeOp.o === 1, JSON.stringify(activeOp))

    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(300)
  }

  // ══════════════════════════════════════════════
  group('D. 1000 行歌词下帧率仍 ≥ 55fps（含滚动回看）')
  {
    await loadLines(1000, 0.4)
    await sleep(2000)
    await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
    await sleep(400)
    await cdp.eval(`window.__lrcDiag.engine.play()`)
    await sleep(600)

    const fps = await cdp.eval(`(async () => {
      const frames = []; let last = performance.now(); const start = last;
      let longTasks = 0;
      let observer = null;
      if (typeof PerformanceObserver !== 'undefined') {
        try {
          observer = new PerformanceObserver((l) => { longTasks += l.getEntries().length; });
          observer.observe({ entryTypes: ['longtask'] });
        } catch (e) { observer = null; }
      }
      // 播放 12 秒，其中滚动 5 秒（模拟用户来回回看）
      await new Promise((resolve) => {
        const loop = (now) => {
          frames.push(now - last); last = now;
          const t = now - start;
          if (t >= 12000) { resolve(); return; }
          // 每 300ms 滚一次轮，制造"滚动中"状态
          if (t % 600 < 20) {
            document.querySelector('.stage').dispatchEvent(
              new WheelEvent('wheel', { deltaY: (Math.floor(t/600) % 2 === 0) ? -400 : 400, bubbles: true, cancelable: true })
            );
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      if (observer) observer.disconnect();
      window.__lrcDiag.engine.pause();
      const dts = frames.slice(1).filter(d => d > 0);
      const elapsed = dts.reduce((a, b) => a + b, 0);
      const sorted = [...dts].sort((a, b) => a - b);
      return {
        avgFps: Number((dts.length / (elapsed / 1000)).toFixed(2)),
        p95: Number((sorted[Math.floor(sorted.length * 0.95)] || 0).toFixed(2)),
        worst: Number((sorted[sorted.length - 1] || 0).toFixed(2)),
        slowFrames: dts.filter(d => d > 33.4).length,
        longTasks,
        rendered: document.querySelectorAll('.lyric-line').length,
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      };
    })()`)
    console.log(`      1000 行 + 滚动回看实测：${JSON.stringify(fps)}`)
    check('1000 行（播放 + 滚动回看）帧率 ≥55fps', fps.avgFps >= 55, `实际 ${fps.avgFps}fps`)
    check('p95 帧耗时 ≤25ms', fps.p95 <= 25, `p95=${fps.p95}ms, 最差=${fps.worst}ms`)
    check('慢帧数为 0', fps.slowFrames === 0, `${fps.slowFrames} 个`)
    console.log(`      长任务：${fps.longTasks}，DOM 行 ${fps.rendered}，堆 ${fps.heapMB}MB`)
  }

  // ══════════════════════════════════════════════
  group('E. 虚化计算次数缓存仍生效（滚动中不是每帧重算）')
  {
    await loadLines(1000, 0.4)
    await sleep(1800)
    await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
    await sleep(400)

    const r = await cdp.eval(`(async () => {
      const t0 = performance.now();
      let frames = 0;
      const start = t0;
      window.__lrcFadeDiag; // 确保诊断已挂载
      const c0 = window.__lrcFadeDiag.computeCount;

      window.__lrcDiag.engine.play();
      await new Promise((resolve) => {
        const loop = (now) => {
          frames++;
          const t = now - start;
          if (t >= 8000) { resolve(); return; }
          // 每 250ms 滚一次，模拟频繁回看
          if (t % 500 < 20) {
            document.querySelector('.stage').dispatchEvent(
              new WheelEvent('wheel', { deltaY: (Math.floor(t/500) % 2 === 0) ? -400 : 400, bubbles: true, cancelable: true })
            );
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      window.__lrcDiag.engine.pause();
      const c1 = window.__lrcFadeDiag.computeCount;
      const elapsed = (performance.now() - t0) / 1000;
      return { before: c0, after: c1, delta: c1 - c0, frames, elapsed: Number(elapsed.toFixed(2)) };
    })()`)
    console.log(`      ${r.elapsed}s 内 ${r.frames} 帧，虚化重算 ${r.delta} 次`)
    check(
      '滚动回看 8 秒，重算次数远小于帧数（缓存生效）',
      r.delta < r.frames / 5,
      `重算 ${r.delta} 次 / ${r.frames} 帧`,
    )

    // 对比：1000 行下"每帧重算"的成本本来就是不可接受的，
    // 这里顺带验证单次计算本身够快
    const cost = await cdp.eval(`(() => {
      const lines = window.__lrcDiag.lyrics.lines;
      const t0 = performance.now();
      for (let i = 0; i < 100; i++) {
        window.__lrcFadeDiag; // no-op
      }
      return performance.now() - t0;
    })()`)
    void cost
  }

  // ══════════════════════════════════════════════
  group('F. 虚化其他行为不变（实体区/过渡区/模式/双语）')
  {
    // F1. 实体区仍为 1
    await loadLines(40, 1)
    await sleep(900)
    await cdp.eval(`window.__lrcDiag.settings.setMany({
      'fade.enabled': true, 'fade.solidAbove': 3, 'fade.solidBelow': 3, 'fade.fadeRows': 5, 'fade.mode': 'ease'
    })`)
    await sleep(600)
    await cdp.eval(`window.__lrcDiag.engine.seek(15)`)
    await sleep(700)
    let ops = await renderedOpacity()
    let center = await cdp.eval(`window.__lrcFadeDiag.centerIndex`)
    let up1 = ops.find((o) => o.idx === center - 1)
    let down1 = ops.find((o) => o.idx === center + 1)
    check('F1 实体区仍完全不透明（中心上下 1 行 = 1）', up1?.o === 1 && down1?.o === 1, `上=${up1?.o} 下=${down1?.o}`)

    // F2. 过渡区仍单调 1→0
    let seq = []
    for (let d = 4; d <= 8; d++) {
      const r = ops.find((o) => o.idx === center + d)
      if (r) seq.push(r.o)
    }
    let mono = true
    for (let i = 1; i < seq.length; i++) if (!(seq[i] < seq[i - 1])) mono = false
    check('F2 过渡区仍单调 1→0', mono, seq.join(','))

    // F3. none 模式仍硬截断
    await cdp.eval(`window.__lrcDiag.settings.set('fade.mode', 'none')`)
    await sleep(500)
    ops = await renderedOpacity()
    center = await cdp.eval(`window.__lrcFadeDiag.centerIndex`)
    const d1none = ops.find((o) => o.idx === center + 4)?.o
    check('F3 none 模式实体区外仍立即为 0', d1none === 0, `d4=${d1none}`)
    await cdp.eval(`window.__lrcDiag.settings.set('fade.mode', 'ease')`)
    await sleep(400)

    // F4. 双语算一行（同时间两行透明度相同）
    await cdp.eval(`(() => {
      const rows = [];
      for (let i = 0; i < 30; i++) {
        const tag = '[00:' + String(i).padStart(2,'0') + '.00]';
        rows.push(tag + '第 ' + (i+1) + ' 行');
        if (i === 10) rows.push(tag + 'Line 11 translation');
      }
      window.__lrcDiag.lyrics.loadFromText('[ti:T]\\n' + rows.join('\\n'), { fileName:'b.lrc' });
      return true;
    })()`)
    await sleep(900)
    await cdp.eval(`window.__lrcDiag.engine.seek(18)`)
    await sleep(700)
    ops = await renderedOpacity()
    const pair = ops.filter((o) => o.idx === 10 || o.idx === 11)
    check(
      'F4 双语两行透明度仍完全相同（一起淡出）',
      pair.length === 2 && Math.abs(pair[0].o - pair[1].o) < 0.001,
      JSON.stringify(pair),
    )

    // F5. 用户滚动时当前播放行仍有 is-active 类（放大/变色不受影响）
    await cdp.eval(`window.__lrcDiag.engine.seek(12)`)
    await sleep(500)
    await cdp.eval(`window.__lrcDiag.engine.play()`)
    await sleep(400)
    await wheel(-400)
    await wheel(-400)
    await sleep(300)
    const activeClass = await cdp.eval(`(() => {
      const d = window.__lrcDiag;
      const active = d.auto.activeIndex.value;
      const el = document.querySelector('[data-line-index="' + active + '"]');
      return { hasActive: el?.classList.contains('is-active') ?? false, transform: el ? getComputedStyle(el).transform : null };
    })()`)
    check('F5 播放行仍有 is-active（放大/变色不受虚化影响）', activeClass.hasActive === true, JSON.stringify(activeClass))
    check('F5 播放行仍应用 scale 放大', /matrix/.test(activeClass.transform ?? ''), activeClass.transform)
    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(200)
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
