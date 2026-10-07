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
     * droppedLines 与 tapped 下标一一对应：打了时间的生成新行，
     * 没打的留着继续当"无时间行"。
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

      const merged = [...this.lines]
      /** @type {Array<{line:number,text:string,reason:string}>} */
      const rest = []
      let applied = 0

      for (let i = 0; i < this.droppedLines.length; i++) {
        const row = this.droppedLines[i]
        const rec = tapped[i]
        if (!rec) {
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
