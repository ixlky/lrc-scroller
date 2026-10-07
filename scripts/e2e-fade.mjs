// @ts-check
/**
 * 歌词虚化验收（CDP 驱动真实浏览器）。
 *
 * 验证用户的每一条要求：
 *  1. 实体区：当前行上下各 N 行完全不透明（上下可分别设置）
 *  2. 过渡区：从实体区边缘往外 M 行，透明度 1 → 0
 *  3. 虚化模式：linear / ease / none
 *  4. 当前行永远 opacity=1
 *  5. 双语歌词行算一行，一起淡出
 *  6. 空行按同样规则
 *  7. 快速拖动进度条跳转时，虚化立即跟上（不滞后）
 *  8. 设置保存到 localStorage，刷新后恢复
 *  9. 性能：1000 行下不拖累帧率；只在 activeIndex 变化时重算
 *
 * 用法：node scripts/e2e-fade.mjs [页面URL] [调试端口]
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
  /**
   * 求值并返回结果。
   *
   * 【重要】读**对象**必须用 evalJson。
   * `returnByValue: true` 无法序列化 Vue 的响应式 Proxy —— 它会返回 `{}`，
   * 看起来像"数据丢了"，其实数据完好。这个坑让我误判过一次 setup 有问题。
   */
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

  /** 求值对象并安全序列化（绕开 Proxy 无法 returnByValue 的问题） */
  async evalJson(expression) {
    const raw = await this.eval(`JSON.stringify(${expression})`)
    return typeof raw === 'string' ? JSON.parse(raw) : null
  }
  close() {
    this.ws?.close()
  }
}

async function main() {
  console.log(`\n歌词虚化验收 —— ${PAGE_URL}\n`)

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

  /** 造一段可控歌词：n 行，每行 1 秒，时间唯一 */
  async function loadLines(n, opts = {}) {
    const { bilingual = [], empties = [] } = opts
    return cdp.eval(`(() => {
      const bilingual = ${JSON.stringify(bilingual)};
      const empties = ${JSON.stringify(empties)};
      const rows = [];
      for (let i = 0; i < ${n}; i++) {
        const mm = String(Math.floor(i / 60)).padStart(2, '0');
        const ss = String(i % 60).padStart(2, '0');
        const tag = '[' + mm + ':' + ss + '.00]';
        if (empties.includes(i)) { rows.push(tag); continue; }
        rows.push(tag + '第 ' + (i + 1) + ' 行歌词');
        if (bilingual.includes(i)) {
          rows.push(tag + 'Line ' + (i + 1) + ' translation');
        }
      }
      window.__lrcDiag.lyrics.loadFromText('[ti:虚化测试]\\n' + rows.join('\\n'), { fileName: 'fade.lrc' });
      return { lines: window.__lrcDiag.lyrics.count, dropped: window.__lrcDiag.lyrics.droppedLines.length };
    })()`)
  }

  /** 跳到第 i 秒并等虚化生效 */
  async function seekTo(sec) {
    await cdp.eval(`window.__lrcDiag.engine.seek(${sec})`)
    await sleep(450)
  }

  /** 读取每一行渲染出来的实际 opacity（从 DOM 读，不是读内部状态） */
  const readOpacity = () =>
    cdp.eval(`[...document.querySelectorAll('.lyric-line')].map(el => {
      const cs = getComputedStyle(el);
      return { index: Number(el.dataset.lineIndex), opacity: Number(Number(cs.opacity).toFixed(4)), active: el.classList.contains('is-active'), text: el.textContent.trim().slice(0, 14) };
    })`)

  const fadeCfg = () => cdp.evalJson(`window.__lrcDiag.settings.settings.fade`)

  // ══════════════════════════════════════════════
  group('1. 实体区：上下各 N 行完全不透明')
  {
    await loadLines(30)
    await cdp.eval(`window.__lrcDiag.settings.setMany({
      'fade.enabled': true, 'fade.solidAbove': 3, 'fade.solidBelow': 3, 'fade.fadeRows': 4, 'fade.mode': 'linear'
    })`)
    await sleep(500)
    await seekTo(10)

    const rows = await readOpacity()
    const active = rows.find((r) => r.active)
    check('存在当前行', !!active, JSON.stringify(active))

    // 需求原文：实体区"完全不透明"。所以实体区内（含已唱过的行）都必须是 1，
    // 不再像阶段 3 那样把 past 行调暗到 0.38 —— 否则"实体区"名不副实。
    let solidOk = true
    const details = []
    for (let d = 1; d <= 3; d++) {
      const above = rows.find((r) => r.index === active.index - d)
      const below = rows.find((r) => r.index === active.index + d)
      if (above && Math.abs(above.opacity - 1) > 0.01) {
        solidOk = false
        details.push(`上方 d=${d} opacity=${above.opacity}（期望 1）`)
      }
      if (below && Math.abs(below.opacity - 1) > 0.01) {
        solidOk = false
        details.push(`下方 d=${d} opacity=${below.opacity}（期望 1）`)
      }
    }
    check('上方 3 行完全不透明（opacity = 1）', solidOk && !details.some((x) => x.includes('上方')), details.join('; '))
    check('下方 3 行完全不透明（opacity = 1）', solidOk && !details.some((x) => x.includes('下方')), details.join('; '))

    // 第 4 行（实体区外第一行）应更透明
    const d4above = rows.find((r) => r.index === active.index - 4)
    check(
      '实体区外第 1 行开始淡出（< 1）',
      d4above && d4above.opacity < 1 && d4above.opacity > 0,
      `opacity=${d4above?.opacity}`,
    )
  }

  // ══════════════════════════════════════════════
  group('2. 上下实体行数可分别设置')
  {
    await cdp.eval(`window.__lrcDiag.settings.setMany({
      'fade.solidAbove': 5, 'fade.solidBelow': 0, 'fade.fadeRows': 3, 'fade.mode': 'linear'
    })`)
    await sleep(500)
    await seekTo(15)

    const rows = await readOpacity()
    const active = rows.find((r) => r.active)

    const up5 = rows.find((r) => r.index === active.index - 5)
    const up6 = rows.find((r) => r.index === active.index - 6)
    const down1 = rows.find((r) => r.index === active.index + 1)

    check('上方第 5 行仍在实体区（1）', up5 && Math.abs(up5.opacity - 1) < 0.01, `opacity=${up5?.opacity}`)
    check('上方第 6 行开始淡出（<1）', up6 && up6.opacity < 1, `opacity=${up6?.opacity}`)
    check('下方实体为 0 → 第 1 行就已淡出（<1）', down1 && down1.opacity < 1, `opacity=${down1?.opacity}`)
  }

  // ══════════════════════════════════════════════
  group('3. 过渡区与三种模式')
  {
    for (const mode of ['linear', 'ease', 'none']) {
      await cdp.eval(`window.__lrcDiag.settings.setMany({
        'fade.solidAbove': 0, 'fade.solidBelow': 0, 'fade.fadeRows': 6, 'fade.mode': '${mode}'
      })`)
      await sleep(500)
      await seekTo(20)

      const rows = await readOpacity()
      const active = rows.find((r) => r.active)
      const down = []
      for (let d = 1; d <= 8; d++) {
        const r = rows.find((x) => x.index === active.index + d)
        if (r) down.push({ d, o: r.opacity })
      }
      console.log(`      模式 ${mode}: ${down.map((x) => `d${x.d}=${x.o}`).join(' ')}`)

      if (mode === 'none') {
        check('none 模式：实体区外立即不可见（d1 = 0）', down[0]?.o === 0, `d1=${down[0]?.o}`)
      } else {
        // 过渡区应单调递减且都 >0（fadeRows=6 → d1..d5 可见，d6 归零）
        let mono = true
        for (let i = 1; i < Math.min(5, down.length); i++) {
          if (!(down[i].o < down[i - 1].o)) mono = false
        }
        check(`${mode} 模式：过渡区单调递减`, mono, down.map((x) => x.o).join(','))
        check(`${mode} 模式：过渡区内为部分可见（0<o<1）`, down[0]?.o > 0 && down[0].o < 1, `d1=${down[0]?.o}`)
        check(`${mode} 模式：超出过渡区后完全不可见`, down[7]?.o === 0 || down[6]?.o === 0, `d7=${down[6]?.o} d8=${down[7]?.o}`)
      }
    }

    // linear 与 ease 应有可见差异（近端 ease 更亮）
    await cdp.eval(`window.__lrcDiag.settings.setMany({'fade.fadeRows': 10, 'fade.mode': 'linear'})`)
    await sleep(400)
    await seekTo(20)
    const lin = (await readOpacity()).find((r) => r.active)
    const linRows = await readOpacity()
    const linD1 = linRows.find((r) => r.index === lin.index + 1)?.opacity

    await cdp.eval(`window.__lrcDiag.settings.set('fade.mode', 'ease')`)
    await sleep(400)
    const easeRows = await readOpacity()
    const ease = easeRows.find((r) => r.active)
    const easeD1 = easeRows.find((r) => r.index === ease.index + 1)?.opacity

    check(
      'linear 与 ease 在近端确实不同（ease 更亮）',
      easeD1 > linD1,
      `linear d1=${linD1}, ease d1=${easeD1}`,
    )
  }

  // ══════════════════════════════════════════════
  group('4. 当前行永远 opacity = 1')
  {
    for (const cfg of [
      { solidAbove: 0, solidBelow: 0, fadeRows: 1, mode: 'none' },
      { solidAbove: 10, solidBelow: 10, fadeRows: 0, mode: 'linear' },
      { solidAbove: 0, solidBelow: 0, fadeRows: 30, mode: 'ease' },
    ]) {
      await cdp.eval(`window.__lrcDiag.settings.setMany({
        'fade.enabled': true,
        'fade.solidAbove': ${cfg.solidAbove}, 'fade.solidBelow': ${cfg.solidBelow},
        'fade.fadeRows': ${cfg.fadeRows}, 'fade.mode': '${cfg.mode}'
      })`)
      await sleep(450)
      await seekTo(12)
      const rows = await readOpacity()
      const active = rows.find((r) => r.active)
      check(
        `当前行 opacity=1（solid=${cfg.solidAbove}/${cfg.solidBelow}, fade=${cfg.fadeRows}, ${cfg.mode}）`,
        active && active.opacity === 1,
        `opacity=${active?.opacity}`,
      )
    }
  }

  // ══════════════════════════════════════════════
  group('5. 双语歌词算一行，一起淡出')
  {
    // 第 8、9 物理行是同时间的双语对（index 8 与 9）
    const info = await loadLines(20, { bilingual: [8] })
    check('双语歌词已注入（21 行）', info.lines === 21, `实际 ${info.lines}`)

    await cdp.eval(`window.__lrcDiag.settings.setMany({
      'fade.solidAbove': 1, 'fade.solidBelow': 1, 'fade.fadeRows': 4, 'fade.mode': 'linear'
    })`)
    await sleep(500)
    await seekTo(3)

    const rows = await readOpacity()
    // 找出同时间的那两行：文本分别是"第 9 行歌词"与"Line 9 translation"
    const pair = rows.filter((r) => r.text.includes('第 9 行') || r.text.includes('Line 9'))
    check('找到双语两行', pair.length === 2, JSON.stringify(pair.map((p) => p.text)))

    if (pair.length === 2) {
      check(
        '双语两行透明度完全相同（一起淡出）',
        Math.abs(pair[0].opacity - pair[1].opacity) < 0.001,
        `${pair[0].opacity} vs ${pair[1].opacity}`,
      )
    }

    // 关键：跳到此双语行，验证"双语只占一行距离"
    await seekTo(8)
    const rows2 = await readOpacity()
    const activePair = rows2.filter((r) => r.active)

    // 说明：findLineIndexAt 返回"最后一个 t <= currentTime 的行"，
    // 因此同一时刻的双语对中，只有后一行是 active，前一行算 past。
    // 这是阶段 3 就有的既定行为（保证"当前正在唱的那句"唯一），并非缺陷。
    check('同时间的双语对只有一行是 active（既定行为）', activePair.length === 1, `实际 ${activePair.length}`)
    if (activePair.length === 1) {
      check('active 的那一行 opacity = 1', activePair[0].opacity === 1, `opacity=${activePair[0].opacity}`)
      // 另一行属于同一逻辑行 → 距离 0 → 透明度同样为 1
      // （虚化开启时透明度只看距离，不再有 past 变暗）
      const partner = rows2.find((r) => r.text.includes('第 9 行'))
      check(
        '同一逻辑行的另一行透明度也是 1（双语一起完全显示）',
        partner && Math.abs(partner.opacity - 1) < 0.01,
        `opacity=${partner?.opacity}`,
      )
    }
  }

  // ══════════════════════════════════════════════
  group('6. 空行按同样规则处理')
  {
    const info = await loadLines(20, { empties: [5, 15] })
    check('含空行的歌词已注入', info.lines === 20, `实际 ${info.lines}`)

    await cdp.eval(`window.__lrcDiag.settings.setMany({
      'fade.solidAbove': 2, 'fade.solidBelow': 2, 'fade.fadeRows': 5, 'fade.mode': 'linear'
    })`)
    await sleep(500)
    await seekTo(10)

    const rows = await readOpacity()
    const active = rows.find((r) => r.active)
    const emptyRow = rows.find((r) => r.index === 15)
    const normalRowSameDistance = rows.find((r) => r.index === active.index + 5)
    check('空行存在且被渲染', !!emptyRow, JSON.stringify(emptyRow))
    check('空行显示为（间奏）', emptyRow?.text.includes('间奏'), emptyRow?.text)

    // 空行与同距离的非空行应有相同的虚化因子
    if (emptyRow && normalRowSameDistance) {
      check(
        '空行与非空行在同距离下虚化一致',
        Math.abs(emptyRow.opacity - normalRowSameDistance.opacity) < 0.001,
        `空行=${emptyRow.opacity}, 同距离非空行=${normalRowSameDistance.opacity}`,
      )
    }
  }

  // ══════════════════════════════════════════════
  group('7. 快速拖动进度条：虚化立即跟上，不滞后')
  {
    await loadLines(60)
    await cdp.eval(`window.__lrcDiag.settings.setMany({
      'fade.solidAbove': 2, 'fade.solidBelow': 2, 'fade.fadeRows': 5, 'fade.mode': 'ease'
    })`)
    await sleep(500)

    // 连续快速跳转。
    //
    // 注意不要用 getComputedStyle 的 opacity 判断"是否跟上"：
    // .lyric-line 上有 `transition: opacity ...`，跳转后立刻取计算样式
    // 拿到的是**过渡中间值**（例如 0.12），看起来像滞后，其实是动画进行中。
    // 真正要验证的是：**Vue 是否已经把正确的目标值写进了 DOM**。
    // 因此读 data-opacity（组件按最终值渲染的属性）+ 内联 style。
    const seq = [10, 40, 5, 55, 25]
    let allOk = true
    const detail = []
    for (const sec of seq) {
      const r = await cdp.eval(`(async () => {
        window.__lrcDiag.engine.seek(${sec});
        // 只等一个微任务 + 一帧：模拟"快速拖动后立即观察"
        await new Promise(res => requestAnimationFrame(res));
        const active = document.querySelector('.lyric-line.is-active');
        if (!active) return { ok: false, reason: 'no active' };
        const inline = active.style.opacity;
        return {
          idx: Number(active.dataset.lineIndex),
          inlineOpacity: inline === '' ? null : Number(inline),
          dataOpacity: Number(active.dataset.opacity),
          text: active.textContent.trim().slice(0, 12),
        };
      })()`)
      // 当前行必须是新位置，且虚化目标值必须是 1（当前行永远完全不透明）
      const ok = r.idx === sec && Math.abs(r.dataOpacity - 1) < 1e-6 && Math.abs(r.inlineOpacity - 1) < 1e-6
      if (!ok) allOk = false
      detail.push(`${sec}s→idx${r.idx}/目标op${r.dataOpacity}`)
    }
    check('连续 5 次快速跳转：当前行与虚化目标值立即正确（无滞后）', allOk, detail.join('  '))
    console.log(`      跳转序列: ${detail.join('  ')}`)

    // 再验证一次"过渡结束后"的实际渲染值确实是 1
    await cdp.eval(`window.__lrcDiag.engine.seek(30)`)
    await sleep(600) // 等过渡完成
    const settled = await cdp.eval(`(() => {
      const active = document.querySelector('.lyric-line.is-active');
      return { idx: Number(active.dataset.lineIndex), computed: Number(Number(getComputedStyle(active).opacity).toFixed(4)) };
    })()`)
    check('过渡结束后当前行实际渲染 opacity = 1', settled.computed === 1, JSON.stringify(settled))
  }

  // ══════════════════════════════════════════════
  group('8. 设置保存到 localStorage 并在刷新后恢复')
  {
    await cdp.eval(`window.__lrcDiag.settings.setMany({
      'fade.enabled': true, 'fade.solidAbove': 7, 'fade.solidBelow': 1, 'fade.fadeRows': 12, 'fade.mode': 'linear'
    })`)
    await sleep(900) // 等防抖写入

    const stored = await cdp.eval(`window.__lrcDiag.storedSettings()`)
    const parsed = stored ? JSON.parse(stored) : null
    check('虚化设置已写入 localStorage', !!parsed?.fade, `fade=${JSON.stringify(parsed?.fade)}`)
    check(
      'localStorage 中的虚化值正确',
      parsed?.fade?.solidAbove === 7 &&
        parsed?.fade?.solidBelow === 1 &&
        parsed?.fade?.fadeRows === 12 &&
        parsed?.fade?.mode === 'linear',
      JSON.stringify(parsed?.fade),
    )

    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(2600)
    const after = await fadeCfg()
    check(
      '刷新后虚化设置原样恢复',
      after.solidAbove === 7 && after.solidBelow === 1 && after.fadeRows === 12 && after.mode === 'linear',
      JSON.stringify(after),
    )

    // 重置应清空
    await cdp.eval(`window.__lrcDiag.settings.reset()`)
    await sleep(600)
    const cleared = await cdp.eval(`window.__lrcDiag.storedSettings()`)
    check('重置后 localStorage 被清空', cleared === null, `实际 ${cleared}`)
    const def = await fadeCfg()
    check(
      '重置后虚化回到默认（ease / 2 / 2 / 5）',
      def.mode === 'ease' && def.solidAbove === 2 && def.solidBelow === 2 && def.fadeRows === 5,
      JSON.stringify(def),
    )
  }

  // ══════════════════════════════════════════════
  group('9. 性能：1000 行不拖累帧率，且只在换行时重算')
  {
    await loadLines(1000)
    await cdp.eval(`window.__lrcDiag.settings.setMany({
      'fade.enabled': true, 'fade.solidAbove': 3, 'fade.solidBelow': 3, 'fade.fadeRows': 6, 'fade.mode': 'ease'
    })`)
    await sleep(2000)

    // 9a. 计算次数：播放 6 秒，当前行只变 6 次，重算次数应约等于 6，而不是帧数
    const countResult = await cdp.eval(`(async () => {
      const d = window.__lrcDiag;
      d.engine.seek(0);
      await new Promise(r => setTimeout(r, 500));
      const before = window.__lrcFadeDiag.computeCount;
      const t0 = performance.now();
      let frames = 0;
      await d.engine.play();
      await new Promise((resolve) => {
        const loop = () => {
          frames++;
          if (performance.now() - t0 >= 6000) { resolve(); return; }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      await d.engine.pause();
      const after = window.__lrcFadeDiag.computeCount;
      const elapsed = (performance.now() - t0) / 1000;
      return { before, after, delta: after - before, frames, elapsed: Number(elapsed.toFixed(2)), currentTime: Number(d.player.currentTime.toFixed(2)) };
    })()`)
    console.log(`      播放 ${countResult.elapsed}s，共 ${countResult.frames} 帧，虚化重算 ${countResult.delta} 次`)
    check(
      '虚化重算次数远小于帧数（证明没有逐帧重算）',
      countResult.delta < countResult.frames / 10,
      `重算 ${countResult.delta} 次 / ${countResult.frames} 帧`,
    )
    check(
      '重算次数与"经过的歌词行数"同一量级',
      countResult.delta <= Math.ceil(countResult.currentTime) + 2,
      `重算 ${countResult.delta} 次，播放了 ${countResult.currentTime}s（每行 1s）`,
    )

    // 9b. 帧率：开虚化播放 10 秒
    const fps = await cdp.eval(`(async () => {
      const d = window.__lrcDiag;
      d.engine.seek(0);
      await new Promise(r => setTimeout(r, 400));
      await d.engine.play();
      const frames = []; let last = performance.now(); const start = last;
      await new Promise((resolve) => {
        const loop = (now) => { frames.push(now - last); last = now;
          if (now - start >= 10000) { resolve(); return; } requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
      });
      await d.engine.pause();
      const dts = frames.slice(1).filter(x => x > 0);
      const elapsed = dts.reduce((a,b)=>a+b,0);
      return {
        avgFps: Number((dts.length / (elapsed/1000)).toFixed(2)),
        worstMs: Number(Math.max(...dts).toFixed(1)),
        slowFrames: dts.filter(x => x > 33.4).length,
        rendered: document.querySelectorAll('.lyric-line').length,
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      };
    })()`)
    console.log(`      1000 行 + 虚化实测：${JSON.stringify(fps)}`)
    check('1000 行开虚化仍 ≥55fps', fps.avgFps >= 55, `实际 ${fps.avgFps}fps，最差帧 ${fps.worstMs}ms`)
    check('慢帧数为 0', fps.slowFrames === 0, `慢帧 ${fps.slowFrames} 个`)

    // 9c. 与关闭虚化对比，帧率不应有明显下降
    const fpsOff = await cdp.eval(`(async () => {
      const d = window.__lrcDiag;
      d.settings.set('fade.enabled', false);
      await new Promise(r => setTimeout(r, 500));
      d.engine.seek(0);
      await new Promise(r => setTimeout(r, 300));
      await d.engine.play();
      const frames = []; let last = performance.now(); const start = last;
      await new Promise((resolve) => {
        const loop = (now) => { frames.push(now - last); last = now;
          if (now - start >= 8000) { resolve(); return; } requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
      });
      await d.engine.pause();
      d.settings.set('fade.enabled', true);
      const dts = frames.slice(1).filter(x => x > 0);
      const elapsed = dts.reduce((a,b)=>a+b,0);
      return { avgFps: Number((dts.length / (elapsed/1000)).toFixed(2)), worstMs: Number(Math.max(...dts).toFixed(1)) };
    })()`)
    console.log(`      关闭虚化对照：${JSON.stringify(fpsOff)}`)
    check(
      '开/关虚化的帧率差异很小（虚化成本可忽略）',
      Math.abs(fpsOff.avgFps - fpsOff.avgFps) < 3 && fps.avgFps >= fpsOff.avgFps - 3,
      `开=${fps.avgFps} 关=${fpsOff.avgFps}`,
    )
  }

  // ══════════════════════════════════════════════
  group('10. 设置面板控件存在且可用')
  {
    await cdp.eval(`window.__lrcDiag.settings.openDrawer()`)
    await sleep(700)

    const ui = await cdp.eval(`(() => {
      const drawer = document.querySelector('#settings-drawer');
      if (!drawer) return { error: 'no drawer' };
      const labels = [...drawer.querySelectorAll('.group__title')].map(e => e.textContent.trim());
      const fadeGroup = [...drawer.querySelectorAll('.group')].find(g => g.querySelector('.group__title')?.textContent.includes('虚化'));
      if (!fadeGroup) return { labels, fadeFound: false };
      const fieldLabels = [...fadeGroup.querySelectorAll('.field__label')].map(e => e.textContent.trim().replace(/\\s+/g, ' '));
      const ranges = [...fadeGroup.querySelectorAll('input[type=range]')].length;
      const selects = [...fadeGroup.querySelectorAll('select')].length;
      const checkboxes = [...fadeGroup.querySelectorAll('input[type=checkbox]')].length;
      return { labels, fadeFound: true, fieldLabels, ranges, selects, checkboxes };
    })()`)
    check('设置面板存在「虚化」分组', ui.fadeFound === true, JSON.stringify(ui.labels))
    check('包含实体行数（上）控件', ui.fieldLabels?.some((l) => l.includes('实体行数（上）')), JSON.stringify(ui.fieldLabels))
    check('包含实体行数（下）控件', ui.fieldLabels?.some((l) => l.includes('实体行数（下）')), JSON.stringify(ui.fieldLabels))
    check('包含过渡行数控件', ui.fieldLabels?.some((l) => l.includes('过渡行数')), JSON.stringify(ui.fieldLabels))
    check('虚化模式为下拉选择（三选一）', ui.selects >= 1, `selects=${ui.selects}`)
    check('三个滑杆对应三个参数', ui.ranges === 3, `ranges=${ui.ranges}`)

    // 拖动"实体行数（上）"滑杆 → 舞台虚化目标值立即变化。
    //
    // 探针要选在"会跨越实体区边界"的那一行，否则测不出变化：
    // 这里先把实体行数设为 0，则当前行上方第 3 行处于渐变区（<0.38）；
    // 再把实体行数拖到 8，该行落入实体区（=0.38）。这才是有效的变化点。
    const dragResult = await cdp.eval(`(async () => {
      const drawer = document.querySelector('#settings-drawer');
      const fadeGroup = [...drawer.querySelectorAll('.group')].find(g => g.querySelector('.group__title')?.textContent.includes('虚化'));
      const field = [...fadeGroup.querySelectorAll('.field')].find(f => f.textContent.includes('实体行数（上）'));
      const input = field.querySelector('input[type=range]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

      // 读 data-opacity（组件按最终目标值渲染）
      const readTarget = () => {
        const active = document.querySelector('.lyric-line.is-active');
        if (!active) return null;
        const idx = Number(active.dataset.lineIndex);
        const probe = document.querySelector('[data-line-index="' + (idx - 3) + '"]');
        return probe ? Number(probe.dataset.opacity) : null;
      };

      // 先制造一个"该行处于渐变区"的起点
      window.__lrcDiag.settings.set('fade.solidAbove', 0);
      await new Promise(r => setTimeout(r, 350));
      const before = readTarget();
      const beforeCfg = window.__lrcDiag.settings.settings.fade.solidAbove;

      // 再拖动滑杆到 8
      setter.call(input, '8');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 400));
      const after = readTarget();
      return { before, after, beforeCfg, value: window.__lrcDiag.settings.settings.fade.solidAbove };
    })()`)
    check('拖动「实体行数（上）」滑杆生效', dragResult.value === 8, `值=${dragResult.value}`)
    check(
      '拖动后舞台虚化目标值立即变化',
      dragResult.before !== null && dragResult.after !== null && dragResult.after > dragResult.before,
      `上方第 3 行目标 opacity: ${dragResult.before} → ${dragResult.after}（实体区扩大后应更不透明）`,
    )

    await cdp.eval(`window.__lrcDiag.settings.closeDrawer()`)
    await sleep(300)
  }

  // ══════════════════════════════════════════════
  group('通用')
  {
    check('全程无未捕获异常', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '))
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
