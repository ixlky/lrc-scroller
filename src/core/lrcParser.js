// @ts-check
/**
 * LRC 解析器 —— 纯函数层，禁止 import vue。
 *
 * 设计要点（都是踩过坑之后的决定）：
 *
 * 1. **同时保留 rawT 与 t**。`t` 是最终生效时间，`rawT` 是文件里的原始时间。
 *    用户改 offset 时永远从 rawT 重算，绝不基于 t 二次偏移 —— 否则来回改几次 offset
 *    就会累积误差，这是 LRC 工具最常见也最难察觉的 bug。
 *
 * 2. **多标签展开**。`[00:12.00][01:20.00]歌词` 展开成两行，各自有稳定 id。
 *
 * 3. **重复时间不丢弃**。两行时间完全相同时也全部保留，只给警告。
 *    静默去重会让用户"少了一句歌词"却不知道原因。
 *
 * 4. **空行（有标签无正文）保留**。间奏占位行如果被删掉，滚动会在该处跳变。
 *
 * 5. **排序必须稳定**。相同时间保持文件中的原顺序，否则同一时间的多行会乱序闪烁。
 *
 * 6. **解析绝不抛异常**。任何脏输入都降级为"尽力解析 + 警告"，
 *    因为用户面对的是一首歌的歌词文件，宁可显示得难看也不能白屏。
 */

import { parseTimeTag, parseOffset, clamp } from './timeUtils.js'
import { CODES, makeMessage } from './errors.js'

/** 支持的元数据标签（不含 offset/length，它们需要数值解析） */
const META_TAGS = ['ti', 'ar', 'al', 'by', 're', 've', 'au']

/** 标准时间标签：[mm:ss.xx] 等。全局，需每次重置 lastIndex */
const TIME_TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

/** 元数据标签：[ti:xxx] 形式（时间标签不会匹配，因为要求含冒号且值非纯数字结构） */
const META_TAG_RE = /^\[([a-zA-Z#]+):\s*(.*?)\s*\]$/

/** 增强型逐字标签 <mm:ss.xx> */
const ENHANCED_TAG_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g

/**
 * @typedef {Object} LyricLine
 * @property {string} id      稳定唯一 id
 * @property {number} t       最终生效时间（秒）= rawT - offsetMs/1000
 * @property {number} rawT    原始标签时间（秒），offset 重算的唯一依据
 * @property {string} text    正文（已剥离标签）
 * @property {boolean} empty  是否为空行（间奏占位）
 * @property {number|null} beat 吸附到的节拍序号（阶段 5 用）
 * @property {boolean} locked 是否被手动微调过（阶段 5 用，吸附时不覆盖）
 * @property {number} sourceLine 在原始文件中的行号（从 1 开始，便于报错定位）
 * @property {string[]} duplicateOf 与之时间重复的其他行 id
 * @property {boolean} [isTranslation] 是否为翻译行（同时间多行时的次要行）
 */

/**
 * @typedef {Object} LyricsDoc
 * @property {number} version
 * @property {{title:string,artist:string,album:string,by:string,length:number|null,offsetMs:number,raw:Record<string,string>}} meta
 * @property {LyricLine[]} lines
 * @property {Array<ReturnType<typeof makeMessage>>} warnings
 * @property {Array<{line:number,text:string,reason:string}>} droppedLines
 * @property {{totalRows:number, parsedLines:number, offsetApplied:boolean, encoding:string, translationGroups?:number}} stats
 */

/**
 * 解析 LRC 文本。
 *
 * @param {string} raw LRC 文本内容
 * @param {Object} [options]
 * @param {string} [options.encoding='utf-8'] 实际使用的编码，仅用于统计/提示
 * @param {number} [options.maxLines=50000] 安全上限，防止异常文件撑爆内存
 * @returns {LyricsDoc}
 */
export function parseLrc(raw, options = {}) {
  const { encoding = 'utf-8', maxLines = 50000 } = options

  /** @type {LyricsDoc} */
  const doc = {
    version: 1,
    meta: {
      title: '',
      artist: '',
      album: '',
      by: '',
      length: null,
      offsetMs: 0,
      raw: {},
    },
    lines: [],
    warnings: [],
    droppedLines: [],
    stats: { totalRows: 0, parsedLines: 0, offsetApplied: false, encoding },
  }

  // ── 输入防御 ──────────────────────────────────
  if (typeof raw !== 'string') {
    doc.warnings.push(makeMessage(CODES.LRC_EMPTY))
    return doc
  }

  // 去 BOM。带 BOM 的文件第一行标签常常解析不出来，这是中文 LRC 的高频问题
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

  if (text.trim() === '') {
    doc.warnings.push(makeMessage(CODES.LRC_EMPTY))
    return doc
  }

  // ── 第一遍：扫描元数据（包括 offset）────────────
  // 必须先扫完 offset 再算时间，因为 offset 可能出现在文件任意位置
  const rows = text.split(/\r\n|\r|\n/)
  doc.stats.totalRows = rows.length

  /** 原始时间 + 正文的中间结果，等 offset 确定后再算 t */
  /** @type {Array<{rawT:number, text:string, sourceLine:number}>} */
  const pending = []

  /** @type {string[]} */
  const untimedTexts = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const sourceLine = i + 1

    // 去掉增强型逐字标签（先剥离，保留正文；阶段 4 可选做逐字高亮）
    const withoutEnhanced = row.replace(ENHANCED_TAG_RE, '')

    // 提取本行所有标准时间标签
    TIME_TAG_RE.lastIndex = 0
    /** @type {number[]} */
    const times = []
    let m
    while ((m = TIME_TAG_RE.exec(withoutEnhanced)) !== null) {
      const t = parseTimeTag(`${m[1]}:${m[2]}${m[3] != null ? `.${m[3]}` : ''}`)
      if (t !== null) times.push(t)
    }

    // 正文 = 去掉所有时间标签后的内容
    TIME_TAG_RE.lastIndex = 0
    const body = withoutEnhanced.replace(TIME_TAG_RE, '').trim()

    if (times.length > 0) {
      if (pending.length + times.length > maxLines) {
        // 超出上限：停止追加，但不报错中断，保留已解析部分
        break
      }
      // 一行多标签 → 展开成多行，共享同一份正文
      for (const rawT of times) {
        pending.push({ rawT, text: body, sourceLine })
      }
      continue
    }

    // 没有时间标签：可能是元数据，也可能是纯文本歌词
    const metaMatch = META_TAG_RE.exec(row.trim())
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase()
      const value = metaMatch[2]

      if (key === 'offset') {
        doc.meta.offsetMs = parseOffset(value)
        continue
      }
      if (key === 'length') {
        const secs = parseTimeTag(value) ?? (/^\d+$/.test(value) ? Number(value) : null)
        doc.meta.length = secs
        continue
      }
      applyMeta(doc, key, value)
      continue
    }

    // 既无时间标签也非元数据：记录为被丢弃的文本
    if (row.trim() !== '') {
      untimedTexts.push(row.trim())
      doc.droppedLines.push({
        line: sourceLine,
        text: row.trim(),
        reason: '没有时间标签',
      })
    }
  }

  // ── 第二遍：应用 offset，得到最终时间 ──────────
  const offsetSec = doc.meta.offsetMs / 1000
  doc.stats.offsetApplied = doc.meta.offsetMs !== 0

  let negativeCount = 0
  for (const p of pending) {
    // 社区约定：最终时间 = 原时间 - offset/1000（正数 offset 表示歌词整体提前）
    let t = p.rawT - offsetSec
    if (t < 0) {
      t = 0
      negativeCount++
    }
    doc.lines.push({
      id: '', // 排序后再分配，保证 id 与最终顺序一致
      t,
      rawT: p.rawT,
      text: p.text,
      empty: p.text === '',
      beat: null,
      locked: false,
      sourceLine: p.sourceLine,
      duplicateOf: [],
    })
  }

  // ── 第三遍：稳定排序 ──────────────────────────
  // 用 sourceLine 作为次级键，保证相同时间的行维持文件原顺序（稳定排序）
  doc.lines.sort((a, b) => (a.t - b.t) || (a.sourceLine - b.sourceLine))

  // 排序后分配 id
  for (let i = 0; i < doc.lines.length; i++) {
    doc.lines[i].id = `L${i}`
  }

  // ── 统计与警告 ────────────────────────────────
  doc.stats.parsedLines = doc.lines.length

  if (doc.lines.length === 0) {
    // 没有任何时间标签：区分"完全空文件"与"有文字但没时间"
    if (untimedTexts.length > 0) {
      doc.warnings.push(makeMessage(CODES.LRC_NO_TIME_TAGS, `共 ${untimedTexts.length} 行文本`))
    } else {
      doc.warnings.push(makeMessage(CODES.LRC_EMPTY))
    }
  }

  if (negativeCount > 0) {
    doc.warnings.push(makeMessage(CODES.LRC_NEGATIVE_TIME, `${negativeCount} 行被对齐到 0 秒`))
  }

  // 检测重复时间。注意要区分两种情况（中文 LRC 里非常关键）：
  //   a) 同一时间的多行是「原文 + 翻译」—— 这是正常且常见的格式，不该报警吓用户
  //   b) 同一时间出现内容相同或无关的多行 —— 这才是真需要提醒的
  const dupGroups = findDuplicateTimes(doc.lines)
  const realDupGroups = []
  const translationGroups = []

  for (const g of dupGroups) {
    for (const line of g) {
      line.duplicateOf = g.filter((x) => x.id !== line.id).map((x) => x.id)
    }
    if (looksLikeTranslationGroup(g)) translationGroups.push(g)
    else realDupGroups.push(g)
  }

  // 记录每行是否属于"翻译行"，供 UI 用更弱的样式显示（不抢主歌词的视觉）
  for (const g of translationGroups) {
    const primary = pickPrimaryLine(g)
    for (const line of g) {
      line.isTranslation = line.id !== primary.id
    }
  }

  if (translationGroups.length > 0) {
    doc.stats.translationGroups = translationGroups.length
  }

  if (realDupGroups.length > 0) {
    const detail = realDupGroups
      .slice(0, 3)
      .map((g) => `${formatSec(g[0].t)} 秒处有 ${g.length} 行`)
      .join('；')
    doc.warnings.push(
      makeMessage(
        CODES.LRC_DUPLICATE_TIME,
        realDupGroups.length > 3 ? `${detail} 等 ${realDupGroups.length} 处` : detail,
      ),
    )
  }
  // 翻译行属于正常格式，只作信息提示，不作为警告
  if (translationGroups.length > 0) {
    doc.warnings.push(
      makeMessage(CODES.LRC_TRANSLATION_DETECTED, `${translationGroups.length} 处`),
    )
  }

  return doc
}

/**
 * 取一段文本的"书写系统特征"，用于区分双语歌词与真重复。
 *
 * 为什么需要：同时间的多行到底是「原文 + 翻译」还是「时间写重复了」，
 * 单看"文本不同"判断不出来。但书写系统能给出强信号 ——
 * 日文原文含平假名/片假名，而中文译文只有汉字；
 * 中文原文是汉字，英文译文是拉丁字母。特征不同 → 几乎可以确定是双语。
 *
 * 反之，两行都是纯汉字，则更像时间写重复或排版问题，应当提醒用户。
 *
 * @param {string} text
 * @returns {string} 形如 'han' 或 'han+hiragana' 或 'latin'
 */
function scriptSignature(text) {
  /** @type {Set<string>} */
  const sig = new Set()
  if (/[A-Za-z]/.test(text)) sig.add('latin')
  if (/[\u3040-\u309f]/.test(text)) sig.add('hiragana')
  if (/[\u30a0-\u30ff]/.test(text)) sig.add('katakana')
  if (/[\uac00-\ud7af]/.test(text)) sig.add('hangul')
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) sig.add('han')
  if (/[\u0400-\u04ff]/.test(text)) sig.add('cyrillic')
  if (/[\u0600-\u06ff]/.test(text)) sig.add('arabic')
  if (/[\u0e00-\u0e7f]/.test(text)) sig.add('thai')
  return [...sig].sort().join('+') || 'other'
}

/**
 * 判断一组同时间的行是否是「原文 + 翻译」。
 *
 * 判定依据（按重要性排序）：
 *  1. 若存在完全相同的文本 → 判定为真重复（复制粘贴造成），不是双语
 *  2. 各行的**书写系统特征必须不同** → 这是双语的核心信号
 *  3. 全部非空、长度适中
 *
 * 只有 (2) 成立才认为是双语；两行同为纯汉字会被判为需要提醒的重复时间。
 *
 * @param {LyricLine[]} group
 * @returns {boolean}
 */
function looksLikeTranslationGroup(group) {
  if (group.length < 2) return false

  const texts = group.map((l) => l.text)

  // 1. 有完全相同的文本 → 真重复
  if (new Set(texts).size !== texts.length) return false

  // 2. 必须全部非空
  if (!texts.every((t) => t.trim() !== '')) return false

  // 3. 书写系统特征必须存在差异（双语的核心判据）
  const sigs = new Set(texts.map(scriptSignature))
  if (sigs.size < 2) return false

  // 4. 长度适中（排除"两句完整长歌词挤在同一时刻"这种明显异常）
  const allReasonable = texts.every((t) => t.length <= 120)
  if (!allReasonable) return false

  return group.length <= 4
}

/**
 * 在翻译组里挑出"主歌词"行。
 *
 * 优先选：
 *  1. 含中日韩文字的（原文通常是中文/日文）
 *  2. 文本更长的（翻译一般比原文短或等长）
 *  3. 原始行号更小的（保持文件里的先后）
 * @param {LyricLine[]} group
 * @returns {LyricLine}
 */
function pickPrimaryLine(group) {
  const hasCJK = (s) => /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s)
  const scored = group.map((line) => ({
    line,
    score: (hasCJK(line.text) ? 100 : 0) + Math.min(line.text.length, 60) - line.sourceLine * 0.001,
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored[0].line
}

/**
 * 写入元数据。未识别的标签进 meta.raw，保证导出时不丢信息。
 * @param {LyricsDoc} doc
 * @param {string} key
 * @param {string} value
 */
function applyMeta(doc, key, value) {
  switch (key) {
    case 'ti':
      doc.meta.title = value
      break
    case 'ar':
      doc.meta.artist = value
      break
    case 'al':
      doc.meta.album = value
      break
    case 'by':
      doc.meta.by = value
      break
    default:
      // re / ve 以及任何未知标签都原样保留
      doc.meta.raw[key] = value
      break
  }
}

/**
 * 找出时间完全重复的行分组。
 * @param {LyricLine[]} lines 已排序
 * @returns {LyricLine[][]}
 */
function findDuplicateTimes(lines) {
  /** @type {LyricLine[][]} */
  const groups = []
  let i = 0
  while (i < lines.length) {
    let j = i + 1
    while (j < lines.length && lines[j].t === lines[i].t) j++
    if (j - i > 1) groups.push(lines.slice(i, j))
    i = j
  }
  return groups
}

function formatSec(t) {
  return t.toFixed(2)
}

/**
 * 把 offset 应用到一组歌词行，返回全新数组。
 *
 * **这是 offset 正确性的唯一实现**（reapplyOffset 也走它，避免两份逻辑走偏）。
 *
 * 关键：时间永远从 `rawT` 重算，绝不在现有 `t` 上叠加增量。
 * 因此 +500 → -300 → +500 的结果与直接设 +500 完全一致，不存在累积误差。
 *
 * @param {LyricLine[]} lines
 * @param {number} offsetMs
 * @returns {{lines: LyricLine[], negativeCount:number}}
 */
export function withOffset(lines, offsetMs) {
  const offsetSec = (Number.isFinite(Number(offsetMs)) ? Number(offsetMs) : 0) / 1000
  let negativeCount = 0

  // 1) 基于 rawT 重算时间，并**清空**所有依赖 id/顺序的派生字段，
  //    因为重排后 id 会变，旧的 duplicateOf / isTranslation 会失效变脏。
  const out = lines.map((line) => {
    let t = line.rawT - offsetSec
    if (t < 0) {
      t = 0
      negativeCount++
    }
    return { ...line, t, duplicateOf: [], isTranslation: false }
  })

  // 2) 稳定排序（相同时间保持文件原顺序）
  out.sort((a, b) => (a.t - b.t) || (a.sourceLine - b.sourceLine))

  // 3) 排序确定后再分配 id，保证 id 与最终顺序一致
  for (let i = 0; i < out.length; i++) out[i].id = `L${i}`

  // 4) 用最终 id 重建重复/翻译关系
  const dupGroups = findDuplicateTimes(out)
  for (const g of dupGroups) {
    for (const line of g) {
      line.duplicateOf = g.filter((x) => x.id !== line.id).map((x) => x.id)
    }
    if (looksLikeTranslationGroup(g)) {
      const primary = pickPrimaryLine(g)
      for (const line of g) line.isTranslation = line.id !== primary.id
    }
  }

  return { lines: out, negativeCount }
}

/**
 * 重新应用 offset（保留此名以表达语义：offset 变化后重算）。
 * @param {LyricsDoc} doc
 * @param {number} offsetMs
 */
export function reapplyOffset(doc, offsetMs) {
  return withOffset(doc.lines, offsetMs)
}
