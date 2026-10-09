// @ts-check
/**
 * 阶段 0 交互验收脚本（通过 Chrome DevTools Protocol 真实驱动页面）。
 *
 * 为什么需要它：`--dump-dom` 只能证明"首屏渲染出来了"，
 * 无法证明"点按钮真的有反应"。这个脚本用 CDP 在真实浏览器里点按钮、读 DOM、取值，
 * 把"验收用例"变成可重复执行的代码，而不是靠肉眼截图猜。
 *
 * 用法：node scripts/e2e-stage0.mjs <页面URL> [调试端口]
 */

const PAGE_URL = process.argv[2] ?? 'http://localhost:5173/'
const PORT = Number(process.argv[3] ?? 9222)

let passed = 0
let failed = 0
/** @type {string[]} */
const failures = []

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  \u2713 ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  \u2717 ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

/** 等待调试端口就绪 */
async function waitForTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
      lastErr = 'no page target yet'
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
    await new Promise((res) => setTimeout(res, 400))
  }
  throw new Error(`CDP 端口 ${PORT} 未就绪: ${lastErr}`)
}

/** 极简 CDP 客户端 */
class CDP {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.ws = null
    /** 收集页面错误，供"全程无错误"断言使用 */
    this.errors = []
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (e) => reject(new Error(`WS 错误: ${e.message ?? 'unknown'}`)))
      ws.addEventListener('message', (ev) => {
        let msg
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          this.errors.push(msg.params?.exceptionDetails?.text ?? 'exception')
        }
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
          this.errors.push((msg.params.args ?? []).map((a) => a.value ?? a.description).join(' '))
        }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) rej(new Error(JSON.stringify(msg.error)))
          else res(msg.result)
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
      }, 15000)
    })
  }

  /** 在页面里求值，返回 JSON 化结果 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(`页面求值异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
    }
    return r.result?.value
  }

  close() {
    this.ws?.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log(`\n阶段 0 交互验收 —— ${PAGE_URL}\n`)

  const target = await waitForTarget()
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  // 设置现在是持久化的，测试必须从干净状态开始 ——
  // 否则上一次运行（或上一个测试套件）留下的设置会让断言失败。
  // 这里只清一次，不用 addScriptToEvaluateOnNewDocument，
  // 因为那会在每次导航时都清，会破坏"刷新后设置恢复"这类用例。
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(1200)
  await cdp.eval(`(() => { try { localStorage.clear(); localStorage.setItem('lrc-scroller:tutorial-seen:v1','1'); } catch (e) {} return true; })()`)
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(2500)

  // ── 1. 挂载与首屏 ──────────────────────────────
  console.log('A. 挂载与首屏渲染')
  const mounted = await cdp.eval(`!!document.querySelector('#app .app-shell')`)
  check('Vue 已挂载，app-shell 存在', mounted === true)

  const lineCount = await cdp.eval(`document.querySelectorAll('.lyric-line').length`)
  check('示例歌词渲染出多行', typeof lineCount === 'number' && lineCount > 5, `实际 ${lineCount} 行`)

  const topbarText = await cdp.eval(`document.querySelector('.topbar__title')?.textContent ?? ''`)
  check('顶栏标题正确', topbarText.includes('LRC'))

  const metaText = await cdp.eval(`document.querySelector('.topbar__sub')?.textContent ?? ''`)
  check('元数据（标题/歌手）已展示', metaText.includes('示例歌曲') && metaText.includes('DeepSeek Harness'), metaText.trim())

  // ── 2. 当前行高亮 + transform 放大（不改布局）────
  console.log('\nB. 当前行高亮与 transform 放大')

  const activeCount = await cdp.eval(`document.querySelectorAll('.lyric-line.is-active').length`)
  check('恰好一行处于 active 状态', activeCount === 1, `实际 ${activeCount}`)

  // 关键验收：放大必须走 transform，**不得改变同一行的 offsetHeight**。
  // 注意不能拿"当前行 vs 另一行"比较 —— 不同行文本长度不同，折行数本来就不同
  // （实测第 1 行 1 行文本、第 3 行折成 2 行），那样比是错的。
  // 正确的判定是：同一行在 scale 变化前后，offsetHeight 必须完全不变。
  const layoutCheck = await cdp.eval(`(() => {
    const line = document.querySelector('.lyric-line.is-active');
    const other = document.querySelector('.lyric-line:not(.is-active)');
    if (!line || !other) return { error: 'missing lines' };
    const root = document.querySelector('.app-shell');
    const read = () => ({
      offsetHeight: line.offsetHeight,
      offsetWidth: line.offsetWidth,
      fontSize: getComputedStyle(line).fontSize,
      transform: getComputedStyle(line).transform,
    });
    root.style.setProperty('--lrc-active-scale', '1');
    const at1 = read();
    root.style.setProperty('--lrc-active-scale', '2');
    const at2 = read();
    root.style.removeProperty('--lrc-active-scale');
    const restored = read();
    return {
      at1, at2, restored,
      activeFontSize: restored.fontSize,
      otherFontSize: getComputedStyle(other).fontSize,
    };
  })()`)

  check('当前行使用了 scale transform', /matrix/.test(layoutCheck.restored?.transform ?? ''), `transform=${layoutCheck.restored?.transform}`)
  check(
    '当前行字号未被改变（不靠改字号实现放大）',
    layoutCheck.activeFontSize === layoutCheck.otherFontSize,
    `${layoutCheck.activeFontSize} vs ${layoutCheck.otherFontSize}`,
  )
  check(
    '放大 1→2 时该行 offsetHeight 完全不变（证明不占布局）',
    layoutCheck.at1?.offsetHeight === layoutCheck.at2?.offsetHeight &&
      layoutCheck.at1?.offsetHeight === layoutCheck.restored?.offsetHeight,
    `1x=${layoutCheck.at1?.offsetHeight} 2x=${layoutCheck.at2?.offsetHeight} restored=${layoutCheck.restored?.offsetHeight}`,
  )
  check(
    '放大 1→2 时该行 offsetWidth 也不变（不引发横向重排）',
    layoutCheck.at1?.offsetWidth === layoutCheck.at2?.offsetWidth,
    `1x=${layoutCheck.at1?.offsetWidth} 2x=${layoutCheck.at2?.offsetWidth}`,
  )

  // ── 3. 自动滚动：当前行随播放推进（取代阶段 0 的临时跳行按钮）──
  //
  // 阶段 3 起，右下角"调试 · 跳行"胶囊已按用户要求移除，
  // 由自动滚动接管。这里改为通过 seek 推进播放头来验证二分查找联动。
  console.log('\nC. 当前行随播放推进（验证二分查找联动）')

  const beforeIdx = await cdp.eval(
    `[...document.querySelectorAll('.lyric-line')].findIndex(el => el.classList.contains('is-active'))`,
  )
  check('起始当前行为第 1 行', beforeIdx === 0, `实际下标 ${beforeIdx}`)

  // 跳到第 2 行的时间点，当前行应前进
  await cdp.eval(`(() => {
    const d = window.__lrcDiag;
    d.engine.seek(d.lyrics.lines[1].t + 0.01);
    return true;
  })()`)
  await sleep(700)
  const afterIdx = await cdp.eval(
    `[...document.querySelectorAll('.lyric-line')].findIndex(el => el.classList.contains('is-active'))`,
  )
  check('跳到第 2 行时间点后当前行前进', afterIdx === 1, `实际下标 ${afterIdx}`)

  // 跳到第 6 行，验证跨多行也准确
  await cdp.eval(`(() => {
    const d = window.__lrcDiag;
    d.engine.seek(d.lyrics.lines[5].t + 0.01);
    return true;
  })()`)
  await sleep(700)
  const multiIdx = await cdp.eval(
    `[...document.querySelectorAll('.lyric-line')].findIndex(el => el.classList.contains('is-active'))`,
  )
  check('跳到第 6 行时间点后正好是第 6 行', multiIdx === 5, `实际下标 ${multiIdx}`)

  // 回到开头
  await cdp.eval(`window.__lrcDiag.engine.seek(0)`)
  await sleep(600)

  // 临时调试胶囊应已被移除
  const capsuleGone = await cdp.eval(`document.querySelector('.stage__preview') === null`)
  check('临时调试胶囊已移除（阶段 3 交付要求）', capsuleGone === true)

  // ── 4. 设置抽屉开合 ─────────────────────────────
  console.log('\nD. 设置抽屉')

  await cdp.eval(`[...document.querySelectorAll('.topbar__actions button')].find(b => b.textContent.trim() === '设置').click()`)
  await sleep(500)
  const drawerOpen = await cdp.eval(`!!document.querySelector('#settings-drawer')`)
  check('点"设置"后抽屉打开', drawerOpen === true)

  const fieldCount = await cdp.eval(`document.querySelectorAll('#settings-drawer .field').length`)
  check('设置项数量充足（字体/颜色/布局/动效）', fieldCount >= 12, `实际 ${fieldCount} 个字段`)

  // ── 5. 改设置 → CSS 变量实时生效 ────────────────
  console.log('\nE. 改设置实时生效（CSS 变量）')

  const rootBefore = await cdp.eval(
    `getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--lrc-font-size').trim()`,
  )
  check('CSS 变量 --lrc-font-size 初始为 40px', rootBefore === '40px', `实际 ${rootBefore}`)

  // 拖动字号滑杆到 72
  await cdp.eval(`(() => {
    const label = [...document.querySelectorAll('#settings-drawer .field')].find(f => f.textContent.includes('字号'));
    const input = label.querySelector('input[type=range]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '72');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await sleep(400)

  const rootAfter = await cdp.eval(
    `getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--lrc-font-size').trim()`,
  )
  check('拖字号后 --lrc-font-size 变为 72px', rootAfter === '72px', `实际 ${rootAfter}`)

  const lineFontSize = await cdp.eval(`getComputedStyle(document.querySelector('.lyric-line')).fontSize`)
  check('歌词行字号实际跟着变了', lineFontSize === '72px', `实际 ${lineFontSize}`)

  // 改当前行颜色 —— 阶段 3 起改用 ColorPicker（RGB/HSL 调色盘 + HEX）。
  // 直接走 store 的 set 接口，避免依赖具体控件结构（那部分由 e2e-stage3 详细覆盖）。
  await cdp.eval(`window.__lrcDiag.settings.set('color.active', '#ff0000')`)
  await sleep(500)
  const activeColor = await cdp.eval(`getComputedStyle(document.querySelector('.lyric-line.is-active')).color`)
  check('改当前行颜色后实际颜色变为 rgb(255, 0, 0)', activeColor === 'rgb(255, 0, 0)', `实际 ${activeColor}`)

  // 调色盘存在性（详细交互在 e2e-stage3）
  const hasPicker = await cdp.eval(`!!document.querySelector('.cp')`)
  check('设置面板提供 RGB/HSL 调色盘', hasPicker === true)

  // 放大比例：验证仍是 transform 且相邻行位置不变（核心验收）
  console.log('\nF. 放大比例不影响相邻行位置（关键验收）')

  // 先跳到列表中段：首行没有"上一行"，测不出"相邻行不动"这个核心断言。
  await cdp.eval(`(() => {
    const d = window.__lrcDiag;
    d.engine.seek(d.lyrics.lines[5].t + 0.01);
    return true;
  })()`)
  await sleep(900)

  const neighborBefore = await cdp.eval(`(() => {
    const lines = [...document.querySelectorAll('.lyric-line')];
    const i = lines.findIndex(el => el.classList.contains('is-active'));
    return {
      index: i,
      prevTop: lines[i-1]?.getBoundingClientRect().top ?? null,
      nextTop: lines[i+1]?.getBoundingClientRect().top ?? null,
    };
  })()`)

  await cdp.eval(`window.__lrcDiag.settings.set('font.scale', 2)`)
  await sleep(900)

  const neighborAfter = await cdp.eval(`(() => {
    const lines = [...document.querySelectorAll('.lyric-line')];
    const i = lines.findIndex(el => el.classList.contains('is-active'));
    return {
      index: i,
      prevTop: lines[i-1]?.getBoundingClientRect().top ?? null,
      nextTop: lines[i+1]?.getBoundingClientRect().top ?? null,
    };
  })()`)

  check(
    '测试位置在第 6 行（有上下相邻行）',
    neighborBefore.index === 5,
    `实际下标 ${neighborBefore.index}`,
  )
  check(
    '放大到 2.0 后上一行位置不变',
    neighborBefore.prevTop !== null && Math.abs(neighborBefore.prevTop - neighborAfter.prevTop) < 1,
    `${neighborBefore.prevTop} → ${neighborAfter.prevTop}`,
  )
  check(
    '放大到 2.0 后下一行位置不变',
    neighborBefore.nextTop !== null && Math.abs(neighborBefore.nextTop - neighborAfter.nextTop) < 1,
    `${neighborBefore.nextTop} → ${neighborAfter.nextTop}`,
  )

  // ── 7. 空歌词 / 播放器提示 ──────────────────────
  console.log('\nG. 健壮性与提示')

  // 阶段 2 起「导入音频」已是真实功能（点开会打开文件选择框）。
  // 因此这里不再断言"弹出阶段 2 占位提示"，改为断言它有真实的文件输入可触发，
  // 且不会因为缺少后端/文件而报错。
  const audioInputExists = await cdp.eval(`(() => {
    const inputs = [...document.querySelectorAll('input[type=file]')];
    return inputs.some(i => (i.getAttribute('accept') || '').includes('audio'));
  })()`)
  check('「导入音频」按钮已接入真实的文件输入（阶段 2 起可用）', audioInputExists === true)

  const errsBeforeClick = cdp.errors.length
  await cdp.eval(`[...document.querySelectorAll('.topbar__actions button')].find(b => b.textContent.includes('导入音频')).click()`)
  await sleep(400)
  check('点击「导入音频」不报错', cdp.errors.length === errsBeforeClick, cdp.errors.slice(errsBeforeClick).join(' | '))

  // 点播放：有歌词时应进入模拟时钟播放（阶段 2 需求 N1），
  // 只有在"既无音频也无歌词"时才应提示"请先导入音频"。
  const hasTimeline = await cdp.eval(`window.__lrcDiag ? window.__lrcDiag.player.duration > 0 : null`)
  await cdp.eval(`document.querySelector('.playerbar__play').click()`)
  await sleep(900)

  if (hasTimeline === true) {
    const playing = await cdp.eval(`window.__lrcDiag.player.playing`)
    const t = await cdp.eval(`window.__lrcDiag.player.currentTime`)
    check('有歌词无音频时，点播放走模拟时钟（需求 N1）', playing === true && t > 0.3, `playing=${playing}, t=${t}`)
    await cdp.eval(`window.__lrcDiag.engine.pause()`)
    await sleep(200)
  } else {
    const toast2 = await cdp.eval(`[...document.querySelectorAll('.toast__message')].map(e => e.textContent).join(' | ')`)
    check('无时间轴时点播放给出提示', toast2.includes('请先导入音频'), toast2)
  }

  // ── 8. 无障碍基础 ───────────────────────────────
  console.log('\nH. 无障碍与响应式基础')

  const seekSlider = await cdp.eval(`(() => {
    const el = document.querySelector('[role=slider][aria-label="播放进度"]');
    return el ? { tabindex: el.getAttribute('tabindex'), valuenow: el.getAttribute('aria-valuenow'), label: el.getAttribute('aria-label') } : null;
  })()`)
  check('进度条具备 slider 语义与键盘可达性', seekSlider?.tabindex === '0' && seekSlider?.label === '播放进度', JSON.stringify(seekSlider))

  const liveRegion = await cdp.eval(`document.querySelector('[aria-live]')?.getAttribute('aria-live') ?? ''`)
  check('存在 aria-live 播报区域', liveRegion === 'polite' || liveRegion === 'assertive', liveRegion)

  const btnLabels = await cdp.eval(`(() => {
    const btns = [...document.querySelectorAll('button')];
    return btns.filter(b => !b.textContent.trim() && !b.getAttribute('aria-label')).length;
  })()`)
  check('所有图标按钮均有 aria-label', btnLabels === 0, `${btnLabels} 个按钮缺少标签`)

  // 移动端视口下不溢出
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true })
  // 必须同时开启触摸模拟，`pointer: coarse` 才会真正匹配 ——
  // 只设 deviceMetrics 时 coarse 仍为 false，触摸相关的 CSS 根本不会生效，
  // 那样测出来的"按钮过小"是假象。
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await sleep(700)
  const overflow = await cdp.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)
  check('375px 视口下无横向溢出', overflow <= 1, `溢出 ${overflow}px`)

  const tapTargets = await cdp.eval(`(() => {
    const btns = [...document.querySelectorAll('.playerbar button, .topbar button')];
    // 只统计真正可见的按钮：小屏下"演示"被 CSS 隐藏，高度为 0，不该算作失败
    const visible = btns.filter(b => b.offsetParent !== null && b.getBoundingClientRect().height > 0);
    const small = visible.filter(b => b.getBoundingClientRect().height < 44)
      .map(b => (b.getAttribute('aria-label') || b.textContent.trim().slice(0,10)) + ':' + Math.round(b.getBoundingClientRect().height));
    return { total: visible.length, small };
  })()`)
  check(
    '移动端可见按钮触摸目标均 ≥44px',
    tapTargets.small.length === 0,
    `过小按钮 ${tapTargets.small.join(', ')}`,
  )

  await cdp.send('Emulation.clearDeviceMetricsOverride')

  // ── 汇总 ───────────────────────────────────────
  console.log(`\n${'─'.repeat(52)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed) console.log(`失败项：\n  - ${failures.join('\n  - ')}`)
  console.log('─'.repeat(52))

  cdp.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n脚本异常: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
})
