// @ts-check
/**
 * 阶段 5 验收：N3 纯文本铺开 + 所见即所得调色盘。
 *
 * 覆盖：
 *  1. 纯 .txt（全部无时间标签）→ 逐行显示，且不显示"还没有歌词"空状态
 *  2. 无时间行不进 rowMetrics（不影响滚动边界与居中）
 *  3. 轨道消失后 rowCount 归零（第 3 步前置修复）
 *  4. 混合文件 → 两类都显示，有时间的照常滚动
 *  5. 纯 LRC / 空文件 / 元数据（不回归）
 *  6. 所见即所得：拖色相环只改 H，S/L 不动；颜色不变时给提示
 *  7. 显示一致性：环心预览色 / HEX / RGB 滑杆内部一致
 *  8. 按钮文案「导入 txt / lrc」
 *
 * 用法：node scripts/e2e-stage5.mjs [页面URL] [调试端口]
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
  console.log(`\n阶段 5 验收：N3 纯文本铺开 + 所见即所得调色盘 —— ${PAGE_URL}\n`)

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

  const reload = async () => {
    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(1200)
    await cdp.eval(`(() => { try { localStorage.clear(); localStorage.setItem('lrc-scroller:tutorial-seen:v1','1'); } catch (e) {} return true; })()`)
    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(2600)
  }

  const loadText = (text) =>
    cdp.eval(`(() => {
      window.__lrcDiag.lyrics.loadFromText(${JSON.stringify(text)}, { fileName: 't.txt' });
      return true;
    })()`)

  /** 舞台快照 */
  const probe = () =>
    cdp.eval(`(() => {
      const d = window.__lrcDiag;
      const untimed = document.querySelector('[data-testid=untimed-rows]');
      const untimedLines = [...document.querySelectorAll('.stage__untimed-line')];
      const track = document.querySelector('.stage__track');
      const lyricLines = [...document.querySelectorAll('.lyric-line')];
      return {
        lineCount: d.lyrics.lines.length,
        droppedCount: d.lyrics.droppedLines.length,
        hasUntimedBox: !!untimed,
        untimedLineCount: untimedLines.length,
        untimedTexts: untimedLines.map(e => e.textContent.trim()),
        hasEmptyState: !!document.querySelector('.stage__empty'),
        hasTrack: !!track,
        lyricLineCount: lyricLines.length,
        activeCount: document.querySelectorAll('.lyric-line.is-active').length,
        untimedHasDataIndex: untimedLines.some(e => e.hasAttribute('data-line-index')),
        untimedIsActive: untimedLines.some(e => e.classList.contains('is-active')),
        rowCount: d.auto ? d.auto.diagnostics.rowCount : null,
        measured: d.auto ? d.auto.diagnostics.measured : null,
        activeIndex: d.auto ? d.auto.activeIndex.value : null,
        offset: d.auto ? Number(d.auto.currentOffset.value.toFixed(1)) : null,
      };
    })()`)

  await reload()

  // ══════════════════════════════════════════════
  group('1. 纯 .txt（全部无时间标签）')
  {
    await loadText(['第一行歌词', '第二行歌词', '第三行歌词', '第四行歌词'].join('\n'))
    await sleep(700)
    const s = await probe()

    check('解析出 0 行有时间标签', s.lineCount === 0, `lines=${s.lineCount}`)
    check('解析出 4 行无时间文本', s.droppedCount === 4, `dropped=${s.droppedCount}`)
    check('舞台渲染出无时间行容器', s.hasUntimedBox === true)
    check('逐行显示 4 行文字', s.untimedLineCount === 4, `${s.untimedLineCount} 行`)
    check(
      '文字内容与文件换行一致',
      JSON.stringify(s.untimedTexts) === JSON.stringify(['第一行歌词', '第二行歌词', '第三行歌词', '第四行歌词']),
      JSON.stringify(s.untimedTexts),
    )
    check('纯文本时不显示"还没有歌词"空状态', s.hasEmptyState === false, `hasEmpty=${s.hasEmptyState}`)
    check('无时间时不渲染滚动轨道', s.hasTrack === false, `hasTrack=${s.hasTrack}`)

    // 布局：纯文本时撑满并垂直居中
    const plainLayout = await cdp.eval(`(() => {
      const box = document.querySelector('.stage__untimed');
      const stage = document.querySelector('.stage');
      const body = document.querySelector('.stage__untimed-body');
      if (!box || !stage) return null;
      const br = box.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      const ydr = body.getBoundingClientRect();
      return {
        boxH: Math.round(br.height),
        stageH: Math.round(sr.height),
        centerOffset: Math.round((ydr.top + ydr.height / 2) - (sr.top + sr.height / 2)),
      };
    })()`)
    check(
      '【布局】纯文本时容器撑满舞台高度',
      plainLayout !== null && plainLayout.boxH >= plainLayout.stageH - 4,
      `${plainLayout?.boxH}px / 舞台 ${plainLayout?.stageH}px`,
    )
    check(
      '【布局】纯文本时内容垂直居中（偏差 ≤40px）',
      plainLayout !== null && Math.abs(plainLayout.centerOffset) <= 40,
      `中心偏差 ${plainLayout?.centerOffset}px`,
    )
  }

  // ══════════════════════════════════════════════
  group('2. 无时间行不参与滚动 + rowCount 残留已修（第 3 步前置）')
  {
    const s = await probe()
    check('无时间行不带 data-line-index（不污染 rowMetrics）', s.untimedHasDataIndex === false)
    check('无时间行不带 is-active', s.untimedIsActive === false)
    check('无时间行场景下 activeIndex 无有效值', s.activeIndex < 0 || s.activeIndex === null, `activeIndex=${s.activeIndex}`)
    /*
     * 【rowCount 残留修复 —— 第 3 步打轴的前置条件】
     * 原缺陷：measure() 在 track 为 null 时直接 return，rowMetrics 留着旧值。
     * 触发路径：启动载入内置示例（14 行）→ 导入纯 .txt（轨道 DOM 消失）
     *        → measured 变 false 但 rowCount 仍是 14。
     * 第 3 步打轴往轨道灌行时，残留几何会让 getBounds() 算错。
     */
    check('【修复】轨道消失后 rowCount 归零', s.rowCount === 0, `rowCount=${s.rowCount}（不应残留示例歌词的 14）`)
    check('【修复】measured 同时为 false', s.measured === false, `measured=${s.measured}`)
  }

  // ══════════════════════════════════════════════
  group('3. 混合文件（部分有标签、部分没有）')
  {
    await loadText([
      '[00:00.00]第一句有时间',
      '[00:05.00]第二句有时间',
      '这是一句没时间的',
      '[00:10.00]第三句有时间',
      '这也是没时间的',
    ].join('\n'))
    await sleep(700)
    const s = await probe()

    check('解析出 3 行有时间标签', s.lineCount === 3, `lines=${s.lineCount}`)
    check('解析出 2 行无时间文本', s.droppedCount === 2, `dropped=${s.droppedCount}`)
    check('轨道正常渲染 3 行', s.lyricLineCount === 3, `${s.lyricLineCount} 行`)
    check('无时间行容器同时显示 2 行', s.untimedLineCount === 2, `${s.untimedLineCount} 行`)
    check(
      '无时间行文字正确',
      JSON.stringify(s.untimedTexts) === JSON.stringify(['这是一句没时间的', '这也是没时间的']),
      JSON.stringify(s.untimedTexts),
    )
    check('有歌词时不再显示空状态', s.hasEmptyState === false)
    check('【关键】rowCount 只等于有时间行数', s.rowCount === 3, `rowCount=${s.rowCount}，应为 3`)
    check('无时间行仍不带 data-line-index', s.untimedHasDataIndex === false)
  }

  // ══════════════════════════════════════════════
  group('4. 混合场景下有时间行仍正常滚动与高亮（不回归）')
  {
    await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
    await sleep(600)
    const at0 = await probe()
    check('t=0 时高亮第 0 行', at0.activeIndex === 0, `activeIndex=${at0.activeIndex}`)

    await cdp.eval(`window.__lrcDiag.engine.seek(6)`)
    await sleep(600)
    const at6 = await probe()
    check('t=6s 时高亮第 1 行', at6.activeIndex === 1, `activeIndex=${at6.activeIndex}`)
    check('t=6s 时滚动位置已变化', at6.offset !== at0.offset, `${at0.offset} → ${at6.offset}`)
    check('任何时刻只有一行高亮', at6.activeCount === 1, `activeCount=${at6.activeCount}`)
  }

  // ══════════════════════════════════════════════
  group('5. 纯 LRC / 空文件 / 元数据（不回归）')
  {
    await loadText(['[00:00.00]第一句', '[00:03.00]第二句', '[00:06.00]第三句', '[00:09.00]第四句'].join('\n'))
    await sleep(700)
    let s = await probe()
    check('纯 LRC：4 行有时间标签', s.lineCount === 4, `lines=${s.lineCount}`)
    check('纯 LRC：无时间行数为 0', s.droppedCount === 0, `dropped=${s.droppedCount}`)
    check('纯 LRC：不渲染无时间行容器', s.hasUntimedBox === false, `hasUntimedBox=${s.hasUntimedBox}`)
    check('纯 LRC：轨道正常渲染 4 行', s.lyricLineCount === 4, `${s.lyricLineCount} 行`)
    check('纯 LRC：rowCount = 4', s.rowCount === 4, `rowCount=${s.rowCount}`)

    await loadText('')
    await sleep(600)
    s = await probe()
    check('空文件：不渲染无时间行容器', s.hasUntimedBox === false)
    check('空文件：显示"还没有歌词"空状态', s.hasEmptyState === true, `hasEmpty=${s.hasEmptyState}`)

    await loadText('[ti:歌名]\n[ar:歌手]\n[00:01.00]有句歌词')
    await sleep(600)
    s = await probe()
    check('元数据不算无时间行', s.droppedCount === 0, `dropped=${s.droppedCount}`)
    check('元数据场景不渲染无时间行容器', s.hasUntimedBox === false)
  }

  // ══════════════════════════════════════════════
  group('6. 空行与纯空白不产生可视行')
  {
    await loadText(['第一行', '', '   ', '第二行', '', '第三行'].join('\n'))
    await sleep(700)
    const s = await probe()
    check('空行与纯空白被跳过，只渲染 3 行', s.untimedLineCount === 3, `${s.untimedLineCount} 行`)
    check('没有空的 <p> 元素', !s.untimedTexts.some((t) => t === ''), JSON.stringify(s.untimedTexts))
  }

  // ══════════════════════════════════════════════
  group('7. 色轮：点哪里得哪里的颜色（补丁 10）')
  {
    await reload()
    await cdp.eval(`window.__lrcDiag.settings.openDrawer()`)
    await sleep(1000)

    const size = await cdp.eval(`(() => {
      const el = document.querySelector('.cp__ring');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), hasCenter: !!document.querySelector('.cp__ring-center') };
    })()`)
    check('色轮可见且为 120px', size !== null && size.w === 120, `${size?.w}px`)
    check('色轮不再有旧色相环的中心镂空元素', size?.hasCenter === false, String(size?.hasCenter))
    check('旧提示已删除（色轮下不再需要"颜色不会变"说明）',
      (await cdp.eval(`!!document.querySelector('.cp__hint')`)) === false)

    const box = await cdp.eval(`(() => {
      const el = document.querySelector('.cp__ring');
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width/2, cy: r.top + r.height/2, w: r.width };
    })()`)
    const R = box.w / 2 - 2

    /** 设置颜色并等 UI 同步（避免 pointerdown 落在已被替换的旧 DOM 节点上） */
    const setColor = async (hex) => {
      await cdp.eval(`window.__lrcDiag.settings.set('color.active', ${JSON.stringify(hex)})`)
      for (let i = 0; i < 25; i++) {
        await sleep(80)
        const got = await cdp.eval(`document.querySelector('.cp__hex-input') ? document.querySelector('.cp__hex-input').value : null`)
        if (got === hex) return
      }
      throw new Error(`设置颜色超时：期望 ${hex}`)
    }

    /**
     * 点色轮。
     * 必须补 1px 位移才能触发 onMove（纯 click 不会改色），
     * 引入的误差 <2/255。
     */
    const tapAt = async (deg, frac) => {
      const rad = (deg * Math.PI) / 180
      const x = box.cx + Math.sin(rad) * R * frac
      const y = box.cy - Math.cos(rad) * R * frac
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
      await sleep(30)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 1, y, button: 'left', buttons: 1 })
      await sleep(30)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 1, y, button: 'left', clickCount: 1, buttons: 0 })
      await sleep(280)
      return cdp.eval(`(() => {
        const d = window.__lrcDiag;
        const hex = d.settings.settings.color.active;
        const m = /^#(..)(..)(..)$/.exec(hex);
        const rgb = [m[1], m[2], m[3]].map(x => parseInt(x, 16));
        const mx = Math.max(rgb[0], rgb[1], rgb[2]);
        const mn = Math.min(rgb[0], rgb[1], rgb[2]);
        return {
          hex: hex.toLowerCase(),
          rgb,
          s: mx === mn ? 0 : Math.round(((mx - mn) / 255) * 100),
          sliderHex: document.querySelector('.cp__hex-input')?.value ?? null,
          knob: getComputedStyle(document.querySelector('.cp__ring-knob')).transform,
        };
      })()`)
    }

    // ── 核心诉求：纯白起点点绿色变绿、点紫色变紫 ──
    await setColor('#ffffff')
    let r = await tapAt(120, 1.0)
    check('【核心】纯白起点点绿色 → 变绿', r.rgb[1] > 200 && r.rgb[0] < 60 && r.rgb[2] < 60, `得到 ${r.hex}`)

    await setColor('#ffffff')
    r = await tapAt(280, 1.0)
    check('【核心】纯白起点点紫色 → 变紫', r.rgb[2] > 200 && r.rgb[1] < 80, `得到 ${r.hex}`)

    // ── 六个主色相 ──
    for (const [deg, name] of [[0, '红'], [60, '黄'], [120, '绿'], [180, '青'], [240, '蓝'], [300, '洋红']]) {
      await setColor('#ffffff')
      r = await tapAt(deg, 1.0)
      check(`纯白起点点 ${deg}°(${name}) → 高饱和`, r.s >= 95, `${r.hex} S=${r.s}%`)
    }

    // ── 半径 → 饱和度 ──
    await setColor('#ffffff')
    const edge = await tapAt(120, 1.0)
    await setColor('#ffffff')
    const mid = await tapAt(120, 0.5)
    await setColor('#ffffff')
    const near = await tapAt(120, 0.2)
    check('半径 100% → S≈100', edge.s >= 95, `${edge.hex} S=${edge.s}%`)
    check('半径 50% → S≈50', Math.abs(mid.s - 50) <= 6, `${mid.hex} S=${mid.s}%`)
    check('半径 20% → S 更低', near.s < mid.s && near.s < 30, `${near.hex} S=${near.s}%`)

    // ── 中心与死区 ──
    await setColor('#ffffff')
    const center = await tapAt(0, 0.0)
    check('点正中心 → 纯白（S=0）', center.hex === '#ffffff' && center.s === 0, `${center.hex} S=${center.s}%`)
    await setColor('#3366cc')
    const dead = await tapAt(0, 0.08)
    check('点死区内 → 饱和度归 0', dead.s <= 2, `${dead.hex} S=${dead.s}%`)

    // ── 色相记忆 + 重置为白色 ──
    await setColor('#ffffff')
    await tapAt(280, 0.9)
    await cdp.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '重置为白色')?.click()`)
    await sleep(400)
    const reset = await cdp.eval(`(() => ({
      hex: window.__lrcDiag.settings.settings.color.active,
      knob: getComputedStyle(document.querySelector('.cp__ring-knob')).transform,
    }))()`)
    check('「重置为白色」→ #ffffff', reset.hex === '#ffffff', reset.hex)
    /*
     * 【断言的坑】小点用的是 `translate(calc(-50% + Xpx), calc(-50% + Ypx))`，
     * 12px 的小点在中心时 translate 是 0px —— 但 getComputedStyle 返回的
     * matrix 会把那个 -50%（=-6px）算进去，于是读出来是 (-6,-6)。
     * 直接断言 matrix 数值会误判。改为**读内联样式里的 X/Y**，
     * 那才是我们真正想验的"相对圆心的偏移"。
     */
    /*
     * 【断言的坑 + 为什么不解析数值】
     * 小点用 `translate(calc(-50% + 0px), calc(-50% + 0px))` 定位在圆心。
     * 两种直接断言都会误判：
     *   - 读 getComputedStyle().transform → matrix 会把 -50%（12px 的 -6px）算进去，
     *     圆心读出来是 (-6,-6)，不是 (0,0)
     *   - 解析内联样式里的数字 → 经过 evaluate 的多层字符串转义后容易解析失败
     * 所以这里只断言**字符串形态**：两段 calc 都是 "+ 0px"，
     * 即"没有额外的偏移"，这正是我们要验的（S=0 → 小点在圆心）。
     */
    const knobStyle = await cdp.eval(`document.querySelector('.cp__ring-knob').getAttribute('style') || ''`)
    check(
      '重置后小点回到圆心（S=0，不留在紫色区）',
      /translate\(calc\(-50%\s*\+\s*0px\),\s*calc\(-50%\s*\+\s*0px\)\)/.test(knobStyle),
      knobStyle.slice(0, 90),
    )

    // ── 明度条联动：V=0 时点色轮，色相要记住 ──
    await setColor('#3366cc')
    const bar = await cdp.eval(`(() => {
      const el = document.querySelector('.cp__bar');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, yTop: r.top + 2, yBot: r.bottom - 2 };
    })()`)
    const dragBar = async (y) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bar.x, y, button: 'left', clickCount: 1, buttons: 1 })
      await sleep(30)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bar.x, y: y - 0.5, button: 'left', buttons: 1 })
      await sleep(30)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bar.x, y: y - 0.5, button: 'left', clickCount: 1, buttons: 0 })
      await sleep(280)
    }
    await dragBar(bar.yBot)
    const black = await cdp.eval(`window.__lrcDiag.settings.settings.color.active`)
    check('明度条拉到底 → 接近黑', /^#0/.test(black), black)

    const knobBefore = await cdp.eval(`getComputedStyle(document.querySelector('.cp__ring-knob')).transform`)
    r = await tapAt(120, 1.0)
    check('【联动】纯黑时点色轮：颜色仍是黑（V=0 决定）', /^#0/.test(r.hex), r.hex)
    check('【联动】但小点已移动到绿色角度（色相被记住）', knobBefore !== r.knob, 'transform 未变')

    await dragBar(bar.yTop)
    const restored = await cdp.eval(`window.__lrcDiag.settings.settings.color.active`)
    const rm = /^#(..)(..)(..)$/.exec(restored)
    check('【联动】明度拉回顶 → 颜色按记住的色相变成绿', parseInt(rm[2], 16) > 180, restored)

    // ── 显示一致性 ──
    await setColor('#3366cc')
    r = await tapAt(210, 0.8)
    check('显示一致性：HEX 输入框与 store 同步', r.sliderHex === r.hex, `${r.sliderHex} vs ${r.hex}`)
    check('显示一致性：色轮背景已应用（不是空白）',
      (await cdp.eval(`getComputedStyle(document.querySelector('.cp__ring')).backgroundImage`)).includes('conic-gradient'))

    // ── 明度条把手几何（真机 BUG 回归）──
    /*
     * 【这个 BUG 为什么之前没被发现】
     * 拖动行为**是对的**（下拖变黑、上拖变亮），只有把手的显示位置反了，
     * 所以"拖动 → 颜色变化"这类断言全绿。测试里从来没读过把手的位置。
     *
     * 【断言要读内联 top/left，不能读 computed matrix】
     * 竖直把手的 CSS 是 `left:50% + translate(-50%,-50%)`，
     * computed 的 matrix 会把那个 -50% 算进去（12px→-6px），
     * 读出来是 (x,-6) 而不是我们关心的百分比。内联样式才是真实意图。
     *
     * 【端点必须精确，中点也精确】
     * 明度条只有线性一档（「感知」模式已移除，因为它会让
     * 把手位置与实际明度脱钩、看到与得到不一致），
     * 所以位置就是 `1 - v`，任何档位都不该有缓动偏差。
     */
    const knobXY = () => cdp.eval(`(() => {
      const st = document.querySelector('.cp__bar-knob').getAttribute('style') || '';
      const bar = document.querySelector('.cp__bar').getBoundingClientRect();
      const horizontal = bar.width > bar.height;
      /*
       * 必须用宽松的数字正则：[\\d.eE+-]+
       * Vue 写出来的是 "top: 2.9e-06%;"（V=100 时 1-v 的浮点残差），
       * 只匹配 [\\d.]+ 会漏掉指数写法 → 读成 null → 误判"没定位"。
       * 只关心端点是否≈0/≈100，不需要高精度。
       */
      const pick = (k) => {
        const m = st.match(new RegExp('(?:^|;)\\\\s*' + k + '\\\\s*:\\\\s*([-+0-9.eE]+)%'));
        return m ? parseFloat(m[1]) : null;
      };
      return { horizontal, top: pick('top'), left: pick('left') };
    })()`)

    const setV = async (v) => {
      // 直接改 HEX 的明度最稳：V=0 → #000000，V=100 → 纯色
      const hex = v === 0 ? '#000000' : v === 100 ? '#ff0000' : null
      if (hex) {
        await setColor(hex)
      } else {
        // V=50：用一个中明度色，通过明度条拖到中间
        const b = await cdp.eval(`(() => {
          const el = document.querySelector('.cp__bar');
          const r = el.getBoundingClientRect();
          return { horizontal: r.width > r.height, x: r.left, y: r.top, w: r.width, h: r.height };
        })()`)
        const tx = b.x + (b.horizontal ? b.w * 0.5 : b.w / 2)
        const ty = b.y + (b.horizontal ? b.h / 2 : b.h * 0.5)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', clickCount: 1, buttons: 1 })
        await sleep(30)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tx, y: ty + 0.5, button: 'left', buttons: 1 })
        await sleep(30)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty + 0.5, button: 'left', clickCount: 1, buttons: 0 })
        await sleep(300)
      }
    }

    // 当前是竖直（≥300px 视口）
    {
      const axis = (await knobXY()).horizontal ? 'left' : 'top'
      check('【把手几何】当前为竖直明度条（用 top 定位）', axis === 'top', axis)

      await setV(100)
      let k = await knobXY()
      check('【把手几何】V=100（最亮）→ 把手在顶部 ≈0%', k.top !== null && k.top <= 0.5, `top=${k.top}%`)

      await setV(0)
      k = await knobXY()
      check('【把手几何】V=0（最暗）→ 把手在底部 ≈100%', k.top !== null && k.top >= 99.5, `top=${k.top}%`)

      await setV(50)
      k = await knobXY()
      // 「感知」模式已移除，位置就是 `1 - v`，中点也该精确落在 50%
      check('【把手几何】V=50 → 把手精确在中点（±2%）',
        k.top !== null && Math.abs(k.top - 50) <= 2, `top=${k.top}%`)
    }

    // ── 水平降级（≤300px）：同一组断言换成 left ──
    {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 290, height: 800, deviceScaleFactor: 1, mobile: true })
      await cdp.send('Page.navigate', { url: PAGE_URL })
      await sleep(2600)
      await cdp.eval(`window.__lrcDiag.settings.openDrawer()`)
      await sleep(1000)

      const k0 = await knobXY()
      check('【把手几何】窄屏降级为水平明度条（用 left 定位）',
        k0.horizontal === true && k0.left !== null,
        `horizontal=${k0.horizontal} left=${k0.left} top=${k0.top}`)

      const setColorH = async (hex) => {
        await cdp.eval(`window.__lrcDiag.settings.set('color.active', ${JSON.stringify(hex)})`)
        for (let i = 0; i < 25; i++) {
          await sleep(80)
          const got = await cdp.eval(`document.querySelector('.cp__hex-input')?.value ?? null`)
          if (got === hex) return
        }
      }
      await setColorH('#ff0000')  // V=100
      let kh = await knobXY()
      check('【把手几何·水平】V=100 → 把手在最左 ≈0%', kh.left !== null && kh.left <= 0.5, `left=${kh.left}%`)

      await setColorH('#000000')  // V=0
      kh = await knobXY()
      check('【把手几何·水平】V=0 → 把手在最右 ≈100%', kh.left !== null && kh.left >= 99.5, `left=${kh.left}%`)

      await cdp.eval(`window.__lrcDiag.settings.closeDrawer()`)
      await sleep(400)
    }

    // 恢复标准视口，供后续用例使用
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Page.navigate', { url: PAGE_URL })
    await sleep(2600)
  }

  // ══════════════════════════════════════════════
  group('8. 按钮文案：导入 txt / lrc')
  {
    await reload()
    const label = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /导入/.test(b.textContent) && /lrc|txt/i.test(b.textContent));
      return btn ? btn.textContent.trim() : null;
    })()`)
    check('顶栏按钮文案为「导入 txt / lrc」', label === '导入 txt / lrc', String(label))
    const accept = await cdp.eval(`[...document.querySelectorAll('input[type=file]')].map(i => i.getAttribute('accept')).join(' | ')`)
    check('功能未变：文件选择器仍支持 .lrc 与 .txt', /\.lrc/.test(accept) && /\.txt/.test(accept), accept)
  }

  // ══════════════════════════════════════════════
  group('9. 控制台 0 error')
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
