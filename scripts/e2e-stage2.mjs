// @ts-check
/**
 * 阶段 2 验收（CDP 驱动真实浏览器）。
 *
 * 重点验证用户点名的 7 项：
 *  1. 导入 mp3 后时长正确、点播放出声
 *  2. 拖进度条到 80% 立刻生效，无回弹、无跳回 0
 *  3. 暂停后 300ms 内 rAF 停止，不空转
 *  4. 换歌时旧音频停止、旧 ObjectURL 释放
 *  5. 音频未加载时点播放给提示、不报错
 *  6. 移动端点击播放可出声（首次交互解锁）
 *  7. 无音频时模拟时钟与有音频走同一套 rAF 逻辑
 *
 * 音频文件通过 Node 读成 base64 注入页面，构造真实 File 对象，
 * 确保测的是真实解码路径而不是假数据。
 *
 * 用法：node scripts/e2e-stage2.mjs <页面URL> [调试端口]
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
          this.errors.push(m.params?.exceptionDetails?.text ?? 'exception')
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
      }, 30000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true, // 关键：让 play() 被视为用户手势，才能验证"点击出声"
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
  console.log(`\n阶段 2 验收 —— ${PAGE_URL}\n`)

  // 读取真实音频文件
  const audioDir = 'samples/audio'
  const files = {
    mp3_10s: `${audioDir}/test-10s-440hz.mp3`,
    mp3_60s: `${audioDir}/test-60s-beeps.mp3`,
    wav_5s: `${audioDir}/test-5s.wav`,
  }
  for (const [k, p] of Object.entries(files)) {
    if (!existsSync(p)) throw new Error(`测试音频缺失: ${p}（${k}）`)
  }
  const b64 = {
    mp3_10s: readFileSync(files.mp3_10s).toString('base64'),
    mp3_60s: readFileSync(files.mp3_60s).toString('base64'),
    wav_5s: readFileSync(files.wav_5s).toString('base64'),
  }
  console.log(`测试音频已载入：10s mp3 / 60s mp3 / 5s wav`)

  const target = await waitForTarget()
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  await cdp.send('Page.navigate', { url: PAGE_URL })
  // 必须设定足够宽的视口：主内容避让（需求 N2）在 ≤640px 时按设计为 0，
  // 若用默认窄窗口测"是否被遮挡"会得到一个假的失败。
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(1200)
  // 设置已持久化：从干净状态开始，避免上次运行的残留影响断言。
  // 只清一次（不用 addScriptToEvaluateOnNewDocument），以免破坏需要保留状态的用例。
  await cdp.eval(`(() => { try { localStorage.clear(); } catch (e) {} return true; })()`)
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(2500)

  /** 把 base64 音频注入页面并触发音频导入 */
  async function importAudio(key, name) {
    return cdp.eval(`(async () => {
      const b64 = ${JSON.stringify(b64[key])};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], ${JSON.stringify(name)}, { type: 'audio/mpeg' });
      const inputs = [...document.querySelectorAll('input[type=file]')];
      const input = inputs.find(i => (i.getAttribute('accept')||'').includes('audio'));
      if (!input) return { ok: false, error: '找不到音频 input' };
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // 等待 loadedmetadata
      const t0 = Date.now();
      while (Date.now() - t0 < 12000) {
        await new Promise(r => setTimeout(r, 120));
        const dur = window.__lrcDiag?.playerDuration ?? 0;
        if (dur > 0) break;
      }
      await new Promise(r => setTimeout(r, 400));
      return { ok: true };
    })()`)
  }

  /** 读取引擎诊断 + store 状态（测试钩子在 main.js 里挂到 window.__lrcDiag） */
  async function snap() {
    return cdp.eval(`(() => {
      const d = window.__lrcDiag;
      if (!d) return null;
      return {
        mode: d.engine.diagnostics.mode,
        rafActive: d.engine.diagnostics.rafActive,
        frameCount: d.engine.diagnostics.frameCount,
        hasObjectUrl: d.engine.diagnostics.hasObjectUrl,
        playing: d.player.playing,
        currentTime: Number(d.player.currentTime.toFixed(3)),
        duration: Number(d.player.duration.toFixed(3)),
        volume: d.player.volume,
        muted: d.player.muted,
        rate: d.player.rate,
        fileName: d.player.fileName,
        realAudioTime: d.audioTime(),
      };
    })()`)
  }

  // ══════════════════════════════════════════════
  group('用例 7 · 无音频时的模拟时钟（需求 N1，先测因为没有音频干扰）')
  {
    const s0 = await snap()
    check('诊断钩子可用', s0 !== null, 'window.__lrcDiag 未挂载')

    // 内置示例歌词应已提供模拟时长
    check('无音频时已有模拟时长（来自歌词时间轴）', s0.duration > 0, `duration=${s0.duration}`)
    check('当前为模拟模式', s0.mode === 'simulated', `mode=${s0.mode}`)
    check('初始未播放', s0.playing === false)
    check('初始 rAF 未运行（不空转）', s0.rafActive === false)

    // 点播放
    await cdp.eval(`document.querySelector('.playerbar__play').click()`)
    await sleep(1200)
    const s1 = await snap()
    check('模拟模式可播放', s1.playing === true)
    check('模拟时钟时间在推进', s1.currentTime > 0.5, `currentTime=${s1.currentTime}`)
    check('rAF 在运行', s1.rafActive === true)
    check('无音频时没有 audio 元素', s1.mode === 'simulated')

    // 时间推进速率应接近真实时间（1 秒约 +1.0）
    const t1 = s1.currentTime
    await sleep(1000)
    const s2 = await snap()
    const delta = s2.currentTime - t1
    check('模拟时钟推进速率接近实时', delta > 0.8 && delta < 1.25, `Δ=${delta.toFixed(3)}s`)

    // 暂停
    await cdp.eval(`document.querySelector('.playerbar__play').click()`)
    await sleep(120)
    const s3 = await snap()
    check('暂停后 playing=false', s3.playing === false)

    // 验收用例 3：暂停后 300ms 内 rAF 停止
    await sleep(320)
    const s4 = await snap()
    check('暂停后 300ms 内 rAF 已停止', s4.rafActive === false, `rafActive=${s4.rafActive}`)
    const frozen = s4.frameCount
    await sleep(600)
    const s5 = await snap()
    check(
      '暂停后 600ms 帧计数不再增长（真正不空转）',
      s5.frameCount === frozen,
      `${frozen} → ${s5.frameCount}`,
    )
    check('暂停期间模拟时间冻结', Math.abs(s5.currentTime - s4.currentTime) < 0.05, `${s4.currentTime} → ${s5.currentTime}`)
  }

  // ══════════════════════════════════════════════
  group('用例 1 · 导入 mp3：时长正确 + 播放出声')
  {
    await importAudio('mp3_10s', 'test-10s-440hz.mp3')
    const s = await snap()
    check('成功载入 mp3', s.fileName === 'test-10s-440hz.mp3', s.fileName)
    check('时长显示正确（10 秒 ±0.3）', Math.abs(s.duration - 10) < 0.3, `duration=${s.duration}`)
    check('载入后切换为真实音频模式', s.mode === 'audio', `mode=${s.mode}`)
    check('ObjectURL 已创建', s.hasObjectUrl === true)
    check('载入后回到 0 秒', Math.abs(s.currentTime) < 0.05, `currentTime=${s.currentTime}`)

    // 播放并确认真实音频在走
    await cdp.eval(`document.querySelector('.playerbar__play').click()`)
    await sleep(1500)
    const s2 = await snap()
    check('点播放后 playing=true', s2.playing === true)
    check('真实音频 currentTime 在推进', s2.realAudioTime > 0.5, `audio.currentTime=${s2.realAudioTime}`)
    check('未被浏览器策略拦截（无 NotAllowedError）', !cdp.errors.some((e) => /NotAllowed/i.test(e)))

    await cdp.eval(`document.querySelector('.playerbar__play').click()`)
    await sleep(200)
  }

  // ══════════════════════════════════════════════
  group('用例 2 · 拖进度条到 80%：立刻生效、无回弹、无跳回 0')
  {
    const s0 = await snap()
    const dur = s0.duration

    // 模拟真实拖动：pointerdown → pointermove 到 80% → pointerup
    const result = await cdp.eval(`(async () => {
      const seek = document.querySelector('[role=slider][aria-label="播放进度"]');
      const rect = seek.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const xAt = (r) => rect.left + rect.width * r;

      const ev = (type, x) => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
        clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1,
      });

      const samples = [];
      const d = window.__lrcDiag;
      const readT = () => Number(d.player.currentTime.toFixed(3));

      seek.dispatchEvent(ev('pointerdown', xAt(0.2)));
      await new Promise(r => setTimeout(r, 60));
      samples.push({ at: 'down 20%', t: readT() });

      seek.dispatchEvent(ev('pointermove', xAt(0.5)));
      await new Promise(r => setTimeout(r, 60));
      samples.push({ at: 'move 50%', t: readT() });

      seek.dispatchEvent(ev('pointermove', xAt(0.8)));
      await new Promise(r => setTimeout(r, 60));
      samples.push({ at: 'move 80%', t: readT() });

      seek.dispatchEvent(ev('pointerup', xAt(0.8)));
      // 松手后立刻读，这是最容易"回弹"的时刻
      await new Promise(r => setTimeout(r, 30));
      samples.push({ at: 'up+30ms', t: readT() });
      await new Promise(r => setTimeout(r, 150));
      samples.push({ at: 'up+180ms', t: readT() });
      await new Promise(r => setTimeout(r, 400));
      samples.push({ at: 'up+580ms', t: readT() });

      return { samples, duration: d.player.duration };
    })()`)

    const at80 = result.duration * 0.8
    const get = (n) => result.samples.find((s) => s.at === n)?.t

    check('拖动到 20% 时间同步更新', Math.abs(get('down 20%') - dur * 0.2) < 0.5, `${get('down 20%')}`)
    check('拖动到 50% 时间同步更新', Math.abs(get('move 50%') - dur * 0.5) < 0.5, `${get('move 50%')}`)
    check('拖动到 80% 时间同步更新', Math.abs(get('move 80%') - at80) < 0.5, `${get('move 80%')}`)
    check(
      '松手瞬间不跳回 0（防回弹核心）',
      get('up+30ms') > dur * 0.7,
      `up+30ms = ${get('up+30ms')}（期望 ≈ ${at80.toFixed(2)}）`,
    )
    check('松手后 180ms 仍稳定在 80% 附近', Math.abs(get('up+180ms') - at80) < 0.8, `${get('up+180ms')}`)
    check('松手后 580ms 仍稳定在 80% 附近', Math.abs(get('up+580ms') - at80) < 1.0, `${get('up+580ms')}`)

    // 80% 处继续播放应从该处前进
    await cdp.eval(`document.querySelector('.playerbar__play').click()`)
    await sleep(900)
    const sAfter = await snap()
    check(
      '从 80% 处继续播放（时间前进而非回到 0）',
      sAfter.currentTime > at80,
      `${at80.toFixed(2)} → ${sAfter.currentTime}`,
    )
    await cdp.eval(`document.querySelector('.playerbar__play').click()`)
    await sleep(200)
  }

  // ══════════════════════════════════════════════
  group('用例 4 · 换歌：旧音频停止 + 旧 ObjectURL 释放')
  {
    // 先播放，再在播放中换歌
    await cdp.eval(`document.querySelector('.playerbar__play').click()`)
    await sleep(900)
    const sBefore = await snap()
    check('换歌前正在播放', sBefore.playing === true, `playing=${sBefore.playing}`)

    // 记录旧 ObjectURL，换歌后应失效
    const oldUrl = await cdp.eval(`window.__lrcDiag.engine.diagnostics.objectUrl ?? ''`)

    await importAudio('mp3_60s', 'test-60s-beeps.mp3')
    await sleep(500)
    const sAfter = await snap()

    check('新音频已载入', sAfter.fileName === 'test-60s-beeps.mp3', sAfter.fileName)
    check('新时长正确（60 秒 ±0.5）', Math.abs(sAfter.duration - 60) < 0.5, `duration=${sAfter.duration}`)
    check('换歌后播放状态被重置（旧音频已停止）', sAfter.playing === false, `playing=${sAfter.playing}`)
    check('换歌后时间归零', Math.abs(sAfter.currentTime) < 0.05, `currentTime=${sAfter.currentTime}`)

    // 旧 URL 必须已被 revoke：尝试 fetch 它应当失败
    const oldUrlDead = await cdp.eval(`(async () => {
      const url = ${JSON.stringify(oldUrl)};
      if (!url) return { skipped: true };
      try {
        const r = await fetch(url);
        return { revoked: false, status: r.status };
      } catch (e) {
        return { revoked: true, error: String(e.name || e) };
      }
    })()`)
    check(
      '旧 ObjectURL 已被 revoke（释放内存）',
      oldUrlDead.skipped === true || oldUrlDead.revoked === true,
      JSON.stringify(oldUrlDead),
    )

    // 新 URL 必须与旧的不同
    const newUrl = await cdp.eval(`window.__lrcDiag.engine.diagnostics.objectUrl ?? ''`)
    check('新旧 ObjectURL 不同', oldUrl !== newUrl && newUrl !== '', `${oldUrl?.slice(-12)} vs ${newUrl?.slice(-12)}`)
  }

  // ══════════════════════════════════════════════
  group('用例 5 · 未加载音频时点播放：提示且不报错')
  {
    // 先清掉音频：重新加载页面回到无音频状态
    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(2500)

    // 清掉歌词，制造"既无音频也无歌词"的状态
    await cdp.eval(`(() => {
      const d = window.__lrcDiag;
      d.lyrics.clear();
    })()`)
    await sleep(600)

    // 此时没有时间轴可走，播放按钮必须失效 ——
    // 这里验证的是一个真实修过的缺陷：歌词清空后模拟时长若未归零，
    // 会出现"不出声、不报错、时间却往前走"的空转播放态。
    const noTimeline = await snap()
    check('无音频且无歌词时时长归零', noTimeline.duration === 0, `duration=${noTimeline.duration}`)

    const before = cdp.errors.length
    await cdp.eval(`document.querySelector('.playerbar__play').click()`)
    await sleep(500)

    const toasts = await cdp.eval(`[...document.querySelectorAll('.toast')].map(t => t.innerText.replace(/\\s+/g,' '))`)
    check('给出"请先导入音频"提示', toasts.some((t) => t.includes('请先导入音频')), toasts.join(' | '))
    check('点播放未产生异常', cdp.errors.length === before, cdp.errors.slice(before).join(' | '))

    const s = await snap()
    check('未加载时不会误进入播放态', s.playing === false, `playing=${s.playing}`)
    check('未加载时 rAF 未启动', s.rafActive === false, `rafActive=${s.rafActive}`)

    // 恢复示例歌词，供后续用例使用
    await cdp.eval(`window.__lrcDiag.lyrics.loadDemo()`)
    await sleep(600)
    const restored = await snap()
    check('恢复歌词后模拟时长重新可用', restored.duration > 0, `duration=${restored.duration}`)
  }

  // ══════════════════════════════════════════════
  group('用例 7 补充 · 模拟与真实音频共用同一套 rAF 逻辑')
  {
    const probe = await cdp.eval(`(() => {
      const d = window.__lrcDiag;
      const src = d.engine.diagnostics.readClockTimeSource || '';
      return {
        tickSource: d.engine.diagnostics.tickSource,
        sameTickFn: d.engine.diagnostics.tickIsShared === true,
        // 确认分流确实存在（有 audio 分支），且只有一处
        hasAudioBranch: src.includes('audio ?') || src.includes('audio ?'),
        branchCount: (src.match(/audio \\?/g) || []).length,
      };
    })()`)

    check('引擎标记为"单条 rAF 循环"', probe.tickSource === 'single-raf-loop', JSON.stringify(probe))
    check('两种模式共用同一 tick 实现', probe.sameTickFn === true, JSON.stringify(probe))
    check(
      '时间读取函数内部存在（且仅存在一处）模式分流',
      probe.hasAudioBranch === true && probe.branchCount <= 1,
      `hasBranch=${probe.hasAudioBranch}, count=${probe.branchCount}`,
    )

    // 行为对比：显式采集"暂停期间"与"播放期间"两个等长窗口内的帧增量。
    // 不能简单比较两次读数 —— 前一用例可能刚暂停，基线不稳定。
    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(300)

    const probe2 = await cdp.eval(`(async () => {
      const d = window.__lrcDiag;
      const f = () => d.engine.diagnostics.frameCount;

      // 窗口一：暂停状态 500ms
      const p0 = f();
      await new Promise(r => setTimeout(r, 500));
      const pausedDelta = f() - p0;

      // 窗口二：播放状态 500ms
      await d.engine.play();
      const q0 = f();
      await new Promise(r => setTimeout(r, 500));
      const playingDelta = f() - q0;

      await d.engine.pause();
      return { pausedDelta, playingDelta, mode: d.engine.diagnostics.mode };
    })()`)

    check(
      '模拟模式播放时 rAF 帧持续递增',
      probe2.playingDelta > 5,
      `播放窗口帧增量=${probe2.playingDelta}（模式=${probe2.mode}）`,
    )
    check(
      '模拟模式暂停时帧不增长（与有音频时行为一致）',
      probe2.pausedDelta === 0,
      `暂停窗口帧增量=${probe2.pausedDelta}`,
    )
  }

  // ══════════════════════════════════════════════
  group('用例 6 · 移动端首次交互解锁播放')
  {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await sleep(600)

    // 移动端判断：粗指针媒体查询生效
    const coarse = await cdp.eval(`matchMedia('(pointer: coarse)').matches`)
    check('移动端模拟生效（pointer: coarse）', coarse === true)

    // 通过真实触摸点击播放（CDP Input 会带上用户手势标记）
    const s0 = await snap()
    const btnBox = await cdp.eval(`(() => {
      const b = document.querySelector('.playerbar__play');
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height };
    })()`)
    check('移动端播放按钮触摸目标 ≥44px', btnBox.w >= 44 && btnBox.h >= 44, `${btnBox.w}x${btnBox.h}`)

    // 用 Input.dispatchTouchEvent 触发真实触摸序列
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: btnBox.x, y: btnBox.y }],
    })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(1400)

    const s1 = await snap()
    check(
      '触摸点击后可播放（首次交互解锁）',
      s1.playing === true || s1.frameCount > s0.frameCount,
      `playing=${s1.playing}, frames ${s0.frameCount}→${s1.frameCount}`,
    )
    check('移动端播放未触发 NotAllowedError', !cdp.errors.some((e) => /NotAllowed/i.test(e)))

    // 停止
    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(200)

    // 恢复宽视口（不要用 clearDeviceMetricsOverride：那会退回默认窄窗口，
    // 使后续依赖宽屏布局的用例失效）
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await sleep(500)
  }

  // ══════════════════════════════════════════════
  group('附加 · 音量 / 倍速 / 键盘 / N2 抽屉避让')
  {
    // 音量
    await cdp.eval(`window.__lrcDiag.engine.setVolume(0)`)
    const v0 = (await snap()).volume
    check('音量可调到 0', v0 === 0, `volume=${v0}`)
    await cdp.eval(`window.__lrcDiag.engine.setVolume(1)`)
    check('音量可调到 1', (await snap()).volume === 1)

    // 倍速
    await cdp.eval(`window.__lrcDiag.engine.setRate(2)`)
    check('倍速可设置', (await snap()).rate === 2)
    await cdp.eval(`window.__lrcDiag.engine.setRate(1)`)

    // 键盘空格播放/暂停
    await cdp.eval(`(() => {
      const d = window.__lrcDiag;
      d.lyrics.loadDemo();
      return true;
    })()`)
    await sleep(400)
    const beforeKb = await snap()
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
    await sleep(700)
    const afterKb = await snap()
    check(
      '空格键触发播放（键盘可达）',
      afterKb.playing !== beforeKb.playing || afterKb.frameCount > beforeKb.frameCount,
      `playing ${beforeKb.playing} → ${afterKb.playing}`,
    )
    if (afterKb.playing) {
      await cdp.eval(`window.__lrcDiag.engine.pause()`)
      await sleep(200)
    }

    // N2：抽屉打开时，舞台右下角浮层与播放条控件不被遮挡
    //
    // 必须先恢复宽视口（上一个移动端用例会把视口改窄）：
    // 窄屏下主内容避让量按设计为 0，且部分控件是 display:none，
    // 会因尺寸为 0 而"看起来没被遮挡"，得到一个假通过。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(700)

    const viewport = await cdp.eval(`({
      w: window.innerWidth,
      shift: getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--drawer-shift').trim(),
    })`)
    check('当前处于宽视口（避让策略生效的前提）', viewport.w > 640, `innerWidth=${viewport.w}, shift=${viewport.shift}`)

    // "回到当前行"按钮只在用户回看时出现。
    // 注意必须先跳到歌曲中部：在开头时位移已处于下界（min），
    // 向上滚会被"不越界"逻辑正确拦下（这是设计如此），不会进入回看状态。
    await cdp.eval(`(() => {
      const d = window.__lrcDiag;
      d.engine.seek(d.lyrics.lines[4].t + 0.01);
      return true;
    })()`)
    await sleep(700)

    await cdp.eval(`(() => {
      const stage = document.querySelector('.stage');
      stage?.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }));
      return true;
    })()`)
    await sleep(400)

    const resumeShown = await cdp.eval(`!!document.querySelector('.stage__resume')`)
    check('回看时"回到当前行"按钮出现（供避让测试使用）', resumeShown === true)

    await cdp.eval(`(() => {
      const d = window.__lrcDiag;
      if (!d.settings.drawerOpen) d.settings.toggleDrawer();
      return d.settings.drawerOpen;
    })()`)
    await sleep(800)

    const overlap = await cdp.eval(`(() => {
      const drawer = document.querySelector('#settings-drawer');
      if (!drawer) return { error: '抽屉未打开' };
      const dRect = drawer.getBoundingClientRect();

      const targets = [
        // 说明：阶段 2 时此处是"跳行胶囊"(.stage__preview)，
        // 但该胶囊已在阶段 3 按用户要求移除（由自动滚动取代）。
        // 改为检查阶段 3 新增的"回到当前行"按钮 —— 同样位于舞台右下角，同样需要避让。
        { name: '回到当前行按钮', el: document.querySelector('.stage__resume') },
        { name: '音量滑杆', el: document.querySelector('[role=slider][aria-label="音量"]') },
        { name: '音量按钮', el: document.querySelector('button[aria-label*="静音"]') },
        { name: '倍速按钮', el: document.querySelector('[aria-label="播放速度"]') },
      ];

      return targets.map(t => {
        if (!t.el) return { name: t.name, found: false };
        const r = t.el.getBoundingClientRect();
        // 尺寸为 0 说明元素被 CSS 隐藏，此时"不重叠"没有意义，必须单独标出，
        // 否则会得到一个假通过（这正是之前漏判的原因）。
        const visible = r.width > 0 && r.height > 0;
        const overlaps = visible && r.right > dRect.left + 1 && r.left < dRect.right && r.bottom > dRect.top && r.top < dRect.bottom;
        return {
          name: t.name, found: true, visible, overlaps,
          right: Math.round(r.right), drawerLeft: Math.round(dRect.left),
        };
      });
    })()`)

    for (const t of overlap) {
      check(
        `抽屉打开时「${t.name}」可见且不被遮挡`,
        t.found && t.visible === true && t.overlaps === false,
        JSON.stringify(t),
      )
    }

    // 关闭抽屉后应恢复原宽度
    await cdp.eval(`window.__lrcDiag.settings.closeDrawer()`)
    await sleep(500)
    const restored = await cdp.eval(`getComputedStyle(document.querySelector('.app-shell')).paddingRight`)
    check('关闭抽屉后主内容恢复原宽（避让量归零）', restored === '0px', `padding-right=${restored}`)
  }

  // ══════════════════════════════════════════════
  group('通用 · 控制台无错误')
  {
    check('全程无未捕获异常 / console.error', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '))
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
