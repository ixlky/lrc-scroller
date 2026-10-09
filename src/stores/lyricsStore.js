import { defineStore } from 'pinia'
import { parseLrc, withOffset } from '@/core/lrcParser'
import { makeMessage, CODES } from '@/core/errors'
import demoLrcRaw from '@/assets/samples/demo.lrc?raw'

/**
 * 歌词数据。
 *
 * 阶段 1 起，这里的数据一律由 `core/lrcParser.js` 产出，
 * store 只负责持有状态与转发操作，不做任何解析逻辑（保持分层干净）。
 *
 * 关于 offset：`meta.offsetMs` 是唯一输入源，`lines[].t` 永远是
 * `rawT - offsetMs/1000` 的结果。改 offset 一律走 `setOffset()`，
 * 它基于 rawT 全量重算，因此不存在累积误差。
 */
export const useLyricsStore = defineStore('lyrics', {
  state: () => {
    // 启动时用内置示例歌词走一遍真实解析器，
    // 这样示例数据与用户数据走的是同一条代码路径，示例本身也是一次自测
    const demo = parseLrc(demoLrcRaw, { encoding: 'utf-8' })

    return {
      /** @type {import('@/core/lrcParser').LyricLine[]} */
      lines: demo.lines,
      meta: demo.meta,
      /** @type {Array<{code:string,level:string,message:string,hint?:string,detail?:string}>} */
      warnings: demo.warnings,
      /** @type {Array<{line:number,text:string,reason:string}>} */
      droppedLines: demo.droppedLines,
      stats: demo.stats,

      /** demo（内置示例） | user（用户导入） | empty（导入后无内容） */
      source: 'demo',

      /** 原始文本，供"导出 LRC"与 round-trip 校验使用（阶段 6） */
      rawText: demoLrcRaw,

      /** 导入过程的中间态 */
      importing: false,
      lastFileName: '',
      /** 编码回退信息，用于提示用户 */
      encodingInfo: null,
      /**
       * 最近一次导入的诊断信息。
       *
       * 放在 store 里而不是 useLrcImport 的局部 ref —— 这一点很关键：
       * composable 被 TopBar / StageView / LyricsInfoPanel 各调用一次，
       * 局部 ref 会导致每个组件各持一份互不相通的状态（导入写进 TopBar 的那份，
       * 信息面板读自己的空那份，诊断区永远不显示）。store 才能共享。
       * 这个 bug 是被 e2e 用例 7 抓出来的。
       * @type {null | {name:string, encoding:string, fellBack:boolean, reason:string, bytes:number}}
       */
      lastImport: null,
    }
  },

  getters: {
    count: (state) => state.lines.length,
    hasLyrics: (state) => state.lines.length > 0,
    /** 歌词最后一行时间，用于无音频时的进度参考 */
    lastTime: (state) => (state.lines.length ? state.lines.at(-1).t : 0),
    /** 有正文的行数（排除间奏空行），展示用 */
    textLineCount: (state) => state.lines.filter((l) => !l.empty).length,
    /** 是否存在需要用户注意的警告 */
    hasWarnings: (state) => state.warnings.length > 0,
  },

  actions: {
    /**
     * 载入解析好的歌词文档。
     * @param {import('@/core/lrcParser').LyricsDoc} doc
     * @param {{fileName?:string, rawText?:string, encodingInfo?:any}} [info]
     */
    loadDoc(doc, info = {}) {
      this.lines = doc.lines
      this.meta = doc.meta
      this.warnings = doc.warnings
      this.droppedLines = doc.droppedLines
      this.stats = doc.stats
      this.source = doc.lines.length > 0 ? 'user' : 'empty'
      this.rawText = info.rawText ?? ''
      this.lastFileName = info.fileName ?? ''
      this.encodingInfo = info.encodingInfo ?? null
      if (info.importMeta) this.lastImport = info.importMeta
    },

    /**
     * 从原始文本解析并载入。
     * @param {string} rawText
     * @param {{fileName?:string, encoding?:string, encodingInfo?:any}} [options]
     */
    loadFromText(rawText, options = {}) {
      const doc = parseLrc(rawText, { encoding: options.encoding ?? 'utf-8' })
      this.loadDoc(doc, {
        fileName: options.fileName,
        rawText,
        encodingInfo: options.encodingInfo,
      })
      return doc
    },

    /**
     * 修改整体偏移（毫秒）。
     *
     * 关键：基于每行的 rawT 全量重算，**不是**在当前 t 上叠加增量。
     * 所以 +500 → -300 → +500 的结果与直接设 +500 完全一致。
     * @param {number} offsetMs
     */
    setOffset(offsetMs) {
      const ms = Number.isFinite(Number(offsetMs)) ? Number(offsetMs) : 0
      this.meta = { ...this.meta, offsetMs: ms }
      const { lines } = withOffset(this.lines, ms)
      this.lines = lines

      // offset 变化可能产生新的重复时间或负数行，重算相关警告
      this.refreshWarnings()
    },

    /**
     * 重算与 offset 相关的警告（重复时间、负数时间）。
     * 元数据类警告（编码、无时间标签）不在此处处理，它们不随 offset 变化。
     */
    refreshWarnings() {
      // 保留与 offset 无关的警告
      const keep = this.warnings.filter(
        (w) => w.code !== CODES.LRC_DUPLICATE_TIME && w.code !== CODES.LRC_NEGATIVE_TIME,
      )

      // 重复时间
      const dups = this.findDuplicateGroups()
      if (dups.length > 0) {
        const detail = dups
          .slice(0, 3)
          .map((g) => `${g[0].t.toFixed(2)} 秒处有 ${g.length} 行`)
          .join('；')
        keep.push(
          makeMessage(CODES.LRC_DUPLICATE_TIME, dups.length > 3 ? `${detail} 等 ${dups.length} 处` : detail),
        )
      }

      // 负数：offset 太大导致 rawT - offset < 0
      const offsetSec = this.meta.offsetMs / 1000
      const negative = this.lines.filter((l) => l.rawT - offsetSec < 0).length
      if (negative > 0) {
        keep.push(makeMessage(CODES.LRC_NEGATIVE_TIME, `${negative} 行被对齐到 0 秒`))
      }

      // 恢复成"元数据警告在前、offset 相关警告在后"的稳定顺序
      this.warnings = [...keep]
    },

    /** 找时间重复的分组（store 内用，逻辑与 parser 保持一致）。 */
    findDuplicateGroups() {
      const groups = []
      let i = 0
      while (i < this.lines.length) {
        let j = i + 1
        while (j < this.lines.length && this.lines[j].t === this.lines[i].t) j++
        if (j - i > 1) groups.push(this.lines.slice(i, j))
        i = j
      }
      return groups
    },

    /**
     * 把打轴草稿合并进歌词（阶段 5 的应用出口）。
     *
     * 【两种目标，两套处理 —— 修复一个静默丢数据的真实 BUG】
     * 打轴的目标是二选一的（与 tappingStore.tapTarget 同一判据）：
     *   - droppedLines 非空 → 目标是**无时间的行**，打轴是"给它们补时间"
     *   - droppedLines 为空 → 目标是 **lines 本身**，打轴是"改已有行的时间"
     *
     * 旧实现只遍历 droppedLines，于是在纯 LRC（droppedLines 为空）里打轴后
     * 点「应用到歌词」会提示"已应用 0 行"、**用户打的时间被静默丢弃** ——
     * 不报错、不提示，最难发现的那类问题。
     *
     * 【为什么用 droppedLines.length 判断，而不是接收参数】
     * 与 tappingStore 的 tapTarget 判据必须完全一致，否则 tapped 的下标会
     * 对到错误的数组上（张冠李戴）。两处都从同一个状态推导，才不会走偏。
     *
     * 【新行为什么要带 sourceLine】
     * 排序是 `(t, sourceLine)`。新行缺 sourceLine 时 undefined 参与减法得 NaN，
     * 同时间多行的顺序会退化成输入顺序而非文件顺序。
     * droppedLines[i].line 本来就是原始文件行号，直接用它。
     *
     * 【rawT = t】
     * 让之后调 offset 时这些手打的时间一起平移
     * （offset 是"整体平移对齐音频"，打轴是"在当前对齐下记录时间"）。
     *
     * @param {Array<{t:number,beat:number|null,locked:boolean}|null>} tapped
     * @returns {{applied:number, remaining:number}}
     */
    applyTapped(tapped) {
      if (!Array.isArray(tapped) || tapped.length === 0) {
        return { applied: 0, remaining: this.droppedLines.length }
      }

      const useDropped = this.droppedLines.length > 0

      /** @type {Array<any>} */
      const merged = [...this.lines]
      /** @type {Array<{line:number,text:string,reason:string}>} */
      const rest = []
      let applied = 0

      if (useDropped) {
        // ── 目标是无时间的行：打了时间的生成新行，没打的留作"无时间行" ──
        for (let i = 0; i < this.droppedLines.length; i++) {
          const row = this.droppedLines[i]
          const rec = tapped[i]
          if (!this._hasValidTap(rec)) {
            // 没打（或时间无效）→ 继续留在无时间行里
            rest.push(row)
            continue
          }
          merged.push({
            id: '',
            t: rec.t,
            rawT: rec.t,
            text: row.text,
            empty: row.text === '',
            beat: rec.beat ?? null,
            locked: rec.locked ?? false,
            sourceLine: row.line,
            duplicateOf: [],
          })
          applied++
        }
      } else {
        // ── 目标是 lines 本身：就地改写被打的行的**时间**（正文与行序不动）──
        for (let i = 0; i < merged.length; i++) {
          const rec = tapped[i]
          if (!this._hasValidTap(rec)) continue
          const line = merged[i]
          merged[i] = {
            ...line,
            t: rec.t,
            rawT: rec.t,
            beat: rec.beat ?? null,
            locked: rec.locked ?? false,
          }
          applied++
        }
      }

      merged.sort((a, b) => (a.t - b.t) || (a.sourceLine - b.sourceLine))
      for (let i = 0; i < merged.length; i++) merged[i].id = `L${i}`

      this.lines = merged
      this.droppedLines = rest
      if (merged.length === 0) this.source = 'empty'
      // 合并后可能出现重复时间，警告要跟着更新
      this.refreshWarnings()
      return { applied, remaining: rest.length }
    },

    /**
     * 打轴记录是否可用（有时间、且时间是有限数）。
     *
     * 【为什么不能用 `if (!rec)` 判断】
     * 那只挡掉了"没打"（null），挡不住 `{t: NaN}` 这种脏记录 ——
     * 会让 NaN 流进 lines[].t，之后滚动、导出、排序全部失效。
     *
     * @param {{t?:unknown}|null|undefined} rec
     * @returns {boolean}
     */
    _hasValidTap(rec) {
      if (!rec || typeof rec !== 'object') return false
      return Number.isFinite(Number(/** @type {any} */ (rec).t))
    },

    /**
     * 用快照整体还原（应用撤销用）。
     * @param {{lines:any[], droppedLines:any[]}} snap
     */
    restoreSnapshot(snap) {
      if (!snap) return
      this.lines = snap.lines
      this.droppedLines = snap.droppedLines
    },

    /** 更新某一行的正文（打轴/校对时用）。 */
    setLineText(id, text) {
      const line = this.lines.find((l) => l.id === id)
      if (!line) return
      line.text = text
      line.empty = text.trim() === ''
    },

    clear() {
      this.lines = []
      this.warnings = []
      this.droppedLines = []
      this.source = 'empty'
      this.rawText = ''
      this.lastFileName = ''
      this.encodingInfo = null
    },

    /** 恢复到内置示例（空状态下的"试试示例"用）。 */
    loadDemo() {
      const doc = parseLrc(demoLrcRaw, { encoding: 'utf-8' })
      this.loadDoc(doc, { fileName: 'demo.lrc', rawText: demoLrcRaw })
      this.source = 'demo'
    },
  },
})
