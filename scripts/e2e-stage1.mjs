// @ts-check
/**
 * 阶段 1 浏览器端验收脚本（CDP 驱动真实浏览器）。
 *
 * 覆盖 10 项验收用例中必须在浏览器里才能验证的部分，
 * 尤其是：真实文件导入、GBK 编码兜底、offset 实时重算、重复时间提示。
 *
 * 用法：node scripts/e2e-stage1.mjs <页面URL> [调试端口]
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

function group(t) {
  console.log(`\n${t}`)
}

async function waitForTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
      last = 'no page target'
    } catch (e) {
      last = e instanceof Error ? e.message : String(e)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`CDP 端口 ${PORT} 未就绪: ${last}`)
}

class CDP {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.ws = null
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
      }, 20000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      throw new Error(`页面异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
    }
    return r.result?.value
  }
  close() {
    this.ws?.close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log(`\n阶段 1 验收 —— ${PAGE_URL}\n`)

  const target = await waitForTarget()
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('DOM.enable')

  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(1200)
  // 设置已持久化：从干净状态开始，避免上次运行的残留影响断言。
  // 只清一次，以免破坏需要保留状态的用例。
  await cdp.eval(`(() => { try { localStorage.clear(); } catch (e) {} return true; })()`)
  await cdp.send('Page.navigate', { url: PAGE_URL })
  await sleep(2500)

  // 收集页面控制台错误
  /** @type {string[]} */
  const consoleErrors = []
  cdp.ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(String(ev.data))
      if (m.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(m.params?.exceptionDetails?.text ?? 'unknown')
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
        consoleErrors.push((m.params.args ?? []).map((a) => a.value ?? a.description).join(' '))
      }
    } catch {
      /* ignore */
    }
  })

  /**
   * 通过 DataTransfer 把文件内容塞进页面的 <input type=file>，
   * 这是唯一能在无头浏览器里真实触发 change 事件的方式。
   * @param {string} name
   * @param {number[]} bytes
   */
  async function importFile(name, bytes) {
    // 在页面里构造 File 对象并直接派发到 input 上
    return cdp.eval(`(async () => {
      const bytes = new Uint8Array(${JSON.stringify(bytes)});
      const file = new File([bytes], ${JSON.stringify(name)}, { type: 'text/plain' });
      const input = document.querySelector('input[type=file]');
      if (!input) return { ok: false, error: 'no file input' };
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // 等待解析完成（文件读取是异步的）
      await new Promise(r => setTimeout(r, 1200));
      return { ok: true };
    })()`)
  }

  /** 用 UTF-8 文本编码成字节数组 */
  function utf8Bytes(text) {
    return Array.from(new TextEncoder().encode(text))
  }

  /**
   * 清空当前所有 toast。
   * 必须做：toast 会停留 3.6 秒，相邻用例的消息会串味，
   * 导致"上一条用例的提示"被误判成本次用例的结果。
   */
  async function clearToasts() {
    await cdp.eval(`(() => {
      document.querySelectorAll('.toast__close').forEach(b => b.click());
    })()`)
    await sleep(120)
  }

  /** 读取所有 toast 的完整文本（message + detail + hint），而不只是标题 */
  async function readToasts() {
    return cdp.eval(`[...document.querySelectorAll('.toast')].map(t => t.innerText.replace(/\\s+/g, ' ').trim())`)
  }

  /** 读取信息面板里的解析提示 */
  async function readPanelWarnings() {
    return cdp.eval(`(() => {
      const p = document.querySelector('.info');
      if (p?.classList.contains('is-collapsed')) document.querySelector('.info__head')?.click();
      return [...document.querySelectorAll('.warn__message')].map(e => e.textContent);
    })()`)
  }

  // ══════════════════════════════════════════════
  group('用例 1 · 基础导入：标准 LRC 正确载入')
  {
    const lrc = '[ti:测试歌]\n[ar:测试歌手]\n[00:01.00]第一行歌词\n[00:05.00]第二行歌词\n[00:09.00]第三行歌词'
    await importFile('basic.lrc', utf8Bytes(lrc))

    const info = await cdp.eval(`(() => {
      const el = document.querySelector('.topbar__sub');
      return {
        sub: el?.textContent ?? '',
        lineCount: document.querySelectorAll('.lyric-line').length,
        texts: [...document.querySelectorAll('.lyric-line__text')].map(e => e.textContent),
      };
    })()`)

    check('标题与歌手显示在顶栏', info.sub.includes('测试歌') && info.sub.includes('测试歌手'), info.sub)
    check('渲染出 3 行歌词', info.lineCount === 3, `实际 ${info.lineCount}`)
    check('歌词文本正确', info.texts.includes('第一行歌词') && info.texts.includes('第三行歌词'), info.texts.join('|'))
  }

  // ══════════════════════════════════════════════
  group('用例 2 · 多标签展开')
  {
    const lrc = '[ti:多标签]\n[00:10.00][00:20.00][00:30.00]重复出现的歌词'
    await importFile('multi.lrc', utf8Bytes(lrc))

    const info = await cdp.eval(`(() => {
      const lines = [...document.querySelectorAll('.lyric-line')];
      return {
        count: lines.length,
        texts: lines.map(e => e.querySelector('.lyric-line__text').textContent),
        badge: document.querySelector('.topbar__badge')?.textContent ?? '',
      };
    })()`)

    check('一行三标签展开成 3 行', info.count === 3, `实际 ${info.count}`)
    check('三行正文完全相同', info.texts.every((t) => t === '重复出现的歌词'), info.texts.join('|'))
    check('顶栏行数徽标显示 3 行', info.badge.includes('3'), info.badge)
  }

  // ══════════════════════════════════════════════
  group('用例 3 · 乱序排序')
  {
    const lrc = '[ti:乱序]\n[00:30.00]我排第三个\n[00:05.00]我排第一个\n[00:20.00]我排第二个'
    await importFile('unordered.lrc', utf8Bytes(lrc))

    const texts = await cdp.eval(
      `[...document.querySelectorAll('.lyric-line__text')].map(e => e.textContent)`,
    )
    check('按时间升序排列', JSON.stringify(texts) === JSON.stringify(['我排第一个', '我排第二个', '我排第三个']), texts.join(' → '))
  }

  // ══════════════════════════════════════════════
  group('用例 4 · offset 基于 rawT 重算（核心）')
  {
    const lrc = '[ti:offset测试]\n[offset:500]\n[00:10.00]第十秒\n[00:20.00]第二十秒'
    await importFile('offset.lrc', utf8Bytes(lrc))

    // 打开信息面板读取原始时间与最终时间
    await cdp.eval(`(() => {
      const head = document.querySelector('.info__head');
      if (head && document.querySelector('.info')?.classList.contains('is-collapsed')) head.click();
    })()`)
    await sleep(400)

    const initial = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('.preview-row')];
      return rows.map(r => ({
        t: r.querySelector('.preview-time')?.textContent?.trim(),
        raw: r.querySelector('.preview-tag')?.textContent?.trim(),
      }));
    })()`)

    check('offset +500 使 10 秒行变为 09.50', initial[0]?.t === '00:09.50', JSON.stringify(initial[0]))
    check('原始时间 rawT 仍显示为 10.00', initial[0]?.raw?.includes('00:10.00'), JSON.stringify(initial[0]))

    // 反复改 offset，验证无累积误差
    const result = await cdp.eval(`(async () => {
      const setOffset = (v) => {
        const input = document.querySelector('.info__offset-input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, String(v));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const read = () => [...document.querySelectorAll('.preview-row')].map(r => r.querySelector('.preview-time')?.textContent?.trim());

      setOffset(500);  await new Promise(r=>setTimeout(r,120));
      const a = read();
      setOffset(-300); await new Promise(r=>setTimeout(r,120));
      const b = read();
      setOffset(500);  await new Promise(r=>setTimeout(r,120));
      const c = read();
      setOffset(0);    await new Promise(r=>setTimeout(r,120));
      const d = read();
      return { a, b, c, d };
    })()`)

    check('offset=+500 → 09.50', result.a[0] === '00:09.50', result.a.join(','))
    check('offset=-300 → 10.30', result.b[0] === '00:10.30', result.b.join(','))
    check('改回 +500 与首次完全一致（无累积误差）', result.c[0] === result.a[0], `${result.a[0]} vs ${result.c[0]}`)
    check('归零后恢复原始 10.00', result.d[0] === '00:10.00', result.d.join(','))
  }

  // ══════════════════════════════════════════════
  group('用例 5 · 重复时间警告')
  {
    const lrc = '[ti:重复测试]\n[00:05.00]这一行重复了\n[00:05.00]这一行重复了\n[00:10.00]正常行'
    await importFile('dup.lrc', utf8Bytes(lrc))

    const info = await cdp.eval(`(() => {
      const panel = document.querySelector('.info');
      if (panel?.classList.contains('is-collapsed')) document.querySelector('.info__head')?.click();
      const warns = [...document.querySelectorAll('.warn__message')].map(e => e.textContent);
      return {
        warnings: warns,
        lineCount: document.querySelectorAll('.lyric-line').length,
      };
    })()`)
    await sleep(300)

    check('出现重复时间警告', info.warnings.some((w) => w.includes('重复')), info.warnings.join(' | '))
    check('重复行全部保留（3 行）', info.lineCount === 3, `实际 ${info.lineCount}`)
  }

  // ══════════════════════════════════════════════
  group('用例 6 · 双语歌词被识别（不误报重复）')
  {
    const lrc = '[ti:双语测试]\n[00:05.00]君の名前を呼んでいる\n[00:05.00]呼唤着你的名字'
    await importFile('bilingual.lrc', utf8Bytes(lrc))

    const info = await cdp.eval(`(() => {
      const warns = [...document.querySelectorAll('.warn__message')].map(e => e.textContent);
      const lines = [...document.querySelectorAll('.lyric-line')];
      return {
        warns,
        count: lines.length,
        translationCount: lines.filter(e => e.classList.contains('is-translation')).length,
      };
    })()`)

    check('识别为双语而非重复错误', info.warns.some((w) => w.includes('双语')), info.warns.join(' | '))
    check('不产生"重复"警告', !info.warns.some((w) => w.includes('时间完全重复')), info.warns.join(' | '))
    check('恰好一行被标为翻译行', info.translationCount === 1, `实际 ${info.translationCount}`)
    check('两行都渲染出来', info.count === 2, `实际 ${info.count}`)
  }

  // ══════════════════════════════════════════════
  group('用例 7 · GBK 编码兜底（真实 GBK 文件）')
  {
    await clearToasts()
    // 页面内用 GBK 编码生成文件字节：通过构造已知 GBK 字节序列
    // "中文测试" 的 GBK 编码：D6 D0 CE C4 B2 E2 CA D4
    const gbkHeader = [
      0x5b, 0x74, 0x69, 0x3a, // "[ti:"
      0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, // 中文测试
      0x5d, 0x0a, // "]\n"
    ]
    const gbkLine = [
      0x5b, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x2e, 0x30, 0x30, 0x5d, // "[00:01.00]"
      0xd6, 0xd0, 0xce, 0xc4, 0xb8, 0xe8, 0xb4, 0xca, // 中文歌词
    ]
    await importFile('gbk.lrc', [...gbkHeader, ...gbkLine])

    const info = await cdp.eval(`(() => {
      const lines = [...document.querySelectorAll('.lyric-line__text')].map(e => e.textContent);
      const sub = document.querySelector('.topbar__sub')?.textContent ?? '';
      const hasReplacement = document.body.innerText.includes('\\uFFFD');
      return { lines, sub, hasReplacement };
    })()`)

    // 编码回退提示是通过 toast 弹出的（不是信息面板的警告区），
    // 所以这里要读 .toast__message
    const gbkToasts = await readToasts()
    const gbkWarns = await readPanelWarnings()

    check('GBK 中文被正确解码（无乱码）', info.lines.some((t) => t === '中文歌词'), info.lines.join('|'))
    check('GBK 标题被正确解码', info.sub.includes('中文测试'), info.sub)
    check('页面无替换字符乱码', info.hasReplacement === false)
    check(
      '出现编码回退提示（toast）',
      gbkToasts.some((t) => t.includes('GBK') || t.includes('编码')),
      gbkToasts.join(' | '),
    )
    check(
      '信息面板记录了实际探测编码',
      (await cdp.eval(
        `[...document.querySelectorAll('.info__dl dd')].map(e => e.textContent).join(' ')`,
      )).toUpperCase().includes('GB18030'),
      '面板应显示 GB18030',
    )
    void gbkWarns
  }

  // ══════════════════════════════════════════════
  group('用例 8 · 空文件与无时间标签边界')
  {
    // 8a. 完全空文件
    await importFile('empty.lrc', utf8Bytes(''))
    const emptyInfo = await cdp.eval(`(() => {
      const warns = [...document.querySelectorAll('.warn__message')].map(e => e.textContent);
      return {
        warns,
        emptyState: !!document.querySelector('.stage__empty'),
        crashes: document.querySelectorAll('.lyric-line').length,
      };
    })()`)
    check('空文件不崩溃，显示空状态', emptyInfo.emptyState === true)
    check('空文件给出"文件是空的"提示', emptyInfo.warns.some((w) => w.includes('空')), emptyInfo.warns.join(' | '))

    // 8b. 纯空白
    await importFile('blank.lrc', utf8Bytes('   \n\n   \t  '))
    const blankInfo = await cdp.eval(`(() => ({
      emptyState: !!document.querySelector('.stage__empty'),
      warns: [...document.querySelectorAll('.warn__message')].map(e => e.textContent),
    }))()`)
    check('纯空白文件不崩溃', blankInfo.emptyState === true)

    // 8c. 无时间标签的纯文本
    await importFile('plain.txt', utf8Bytes('这是第一句\n这是第二句\n这是第三句'))
    const plainInfo = await cdp.eval(`(() => ({
      warns: [...document.querySelectorAll('.warn__message')].map(e => e.textContent),
      emptyState: !!document.querySelector('.stage__empty'),
      dropped: document.querySelectorAll('.info__dropped li').length,
      untimedLines: document.querySelectorAll('.stage__untimed-line').length,
    }))()`)
    check('无时间标签时给出明确提示', plainInfo.warns.some((w) => w.includes('时间标签')), plainInfo.warns.join(' | '))
    /*
     * 【阶段 5 第 2 步 · N3 的有意行为变更】
     * 原来的断言是"不崩溃且显示空状态"。其中：
     *   - "不崩溃"  —— 仍然必须成立，是本条的本意；
     *   - "显示空状态" —— 被 N3 有意取代：导入无时间标签的纯文本后，
     *     舞台应当**按换行逐行显示歌词**（供打轴补时间），
     *     此时再显示"还没有歌词 / 把 .lrc 文件拖到这里"是自相矛盾的。
     *
     * 改为断言"空状态不出现、且无时间行已渲染"，
     * 详见 e2e-stage5.mjs 的 N3 验收组。
     */
    check('无时间标签时不崩溃（空状态不再出现，改为逐行显示）', plainInfo.emptyState === false, `emptyState=${plainInfo.emptyState}`)
    check(
      '无时间标签的文本已按换行铺到舞台上（N3）',
      plainInfo.untimedLines === 3,
      `实际 ${plainInfo.untimedLines} 行`,
    )
    check('被跳过的行被列出（3 行）', plainInfo.dropped === 3, `实际 ${plainInfo.dropped}`)
  }

  // ══════════════════════════════════════════════
  group('用例 9 · 空行（间奏）保留 + 非法时间忽略')
  {
    const lrc = '[ti:空行测试]\n[00:01.00]有词\n[00:05.00]\n[00:09.00]有词\n[00:99.00]非法秒数'
    await importFile('emptyline.lrc', utf8Bytes(lrc))

    const info = await cdp.eval(`(() => {
      const lines = [...document.querySelectorAll('.lyric-line')];
      return {
        count: lines.length,
        emptyCount: lines.filter(e => e.classList.contains('is-empty')).length,
        texts: lines.map(e => e.querySelector('.lyric-line__text').textContent),
      };
    })()`)
    check('空行被保留（共 3 行）', info.count === 3, `实际 ${info.count}`)
    check('恰好一行是空行', info.emptyCount === 1, `实际 ${info.emptyCount}`)
    check('非法时间行被忽略（不渲染）', !info.texts.some((t) => t.includes('非法')), info.texts.join('|'))
    check('空行显示为（间奏）占位', info.texts.includes('（间奏）'), info.texts.join('|'))
  }

  // ══════════════════════════════════════════════
  group('用例 10 · 拖拽导入与错误处理')
  {
    // 10a. 传入音频文件应被拒绝并提示
    await clearToasts()
    const audioReject = await cdp.eval(`(async () => {
      const file = new File([new Uint8Array([1,2,3])], 'song.mp3', { type: 'audio/mpeg' });
      const input = document.querySelector('input[type=file]');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 800));
      return [...document.querySelectorAll('.toast')].map(t => t.innerText.replace(/\\s+/g,' ').trim());
    })()`)
    // 关键：拒绝文案在 toast 的 hint 里（"音频请选择 mp3..."），
    // 只读 .toast__message 会漏掉，所以这里读整块 innerText
    check(
      '选择音频文件时给出明确拒绝提示',
      audioReject.some((t) => t.includes('不支持') || t.includes('音频')),
      audioReject.join(' | '),
    )
    check(
      '拒绝提示说明了正确做法',
      audioReject.some((t) => t.includes('.lrc') || t.includes('歌词文件')),
      audioReject.join(' | '),
    )
    check(
      '音频文件未被错误载入为歌词',
      !(await cdp.eval(`document.querySelector('.topbar__sub')?.textContent ?? ''`)).includes('1 行'),
      '不应把 mp3 当歌词解析',
    )

    // 10b. 舞台支持拖拽事件（dragover 被 preventDefault 才能 drop）
    const dragSupport = await cdp.eval(`(() => {
      const stage = document.querySelector('.stage');
      if (!stage) return { ok: false };
      const ev = new DragEvent('dragover', { bubbles: true, cancelable: true });
      stage.dispatchEvent(ev);
      return { ok: true, defaultPrevented: ev.defaultPrevented };
    })()`)
    check('舞台接受 dragover（防止浏览器直接打开文件）', dragSupport.defaultPrevented === true, JSON.stringify(dragSupport))

    // 10c. 恢复示例歌词功能可用
    const demoRestore = await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('恢复为内置示例'));
      if (!btn) return { found: false };
      btn.click();
      await new Promise(r => setTimeout(r, 800));
      return {
        found: true,
        count: document.querySelectorAll('.lyric-line').length,
        sub: document.querySelector('.topbar__sub')?.textContent ?? '',
      };
    })()`)
    check('"恢复为内置示例"按钮存在且可用', demoRestore.found === true)
    check('恢复后载入示例歌词（14 行）', demoRestore.count === 14, `实际 ${demoRestore.count}`)
  }

  // ══════════════════════════════════════════════
  group('通用 · 控制台无错误')
  {
    check('全程无未捕获异常 / console.error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  }

  console.log(`\n${'─'.repeat(52)}`)
  console.log(`通过 ${passed} 项，失败 ${failed} 项`)
  if (failed) console.log(`\n失败项：\n  - ${failures.join('\n  - ')}`)
  console.log('─'.repeat(52))

  cdp.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n脚本异常: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
})
