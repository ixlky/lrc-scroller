// @ts-check
/**
 * 导出 LRC —— 把**已应用的正式歌词**写成 .lrc 文件并下载。
 *
 * 【流程：先应用打轴结果，再导出正式歌词】
 * 本文件**只读** lyricsStore 里已经应用的歌词，不读打轴草稿、不合并数据。
 * 草稿要生效必须先走「应用到歌词」（useTappingShared().apply()）——
 * 那是唯一的数据出口，重复实现一遍合并逻辑一定会和它走偏。
 *
 * 【导出绝不修改任何状态】
 * 不调用 apply、不改 lines、不清空草稿、不动撤销栈。
 * 导出是"看一眼当前状态并另存一份"，不该有副作用 ——
 * 否则用户点一下导出就把没打完的草稿应用了，属于越权操作。
 *
 * 【纯逻辑在 core/lrcWriter.js】
 * 那边负责文本生成与文件名清理（可 Node 单测）；
 * 这里只做 DOM 相关的"造链接并点击"和用户提示。
 */
import { useLyricsStore } from '@/stores/lyricsStore'
import { usePlayerStore } from '@/stores/playerStore'
import { useUiStore } from '@/stores/uiStore'
import { useTappingStore } from '@/stores/tappingStore'
import {
  buildLrcText,
  buildLrcFileName,
  summarizeLrcLines,
} from '@/core/lrcWriter'

/** 下载用的 MIME 类型 */
export const LRC_MIME = 'text/plain;charset=utf-8'

/**
 * 触发浏览器下载。
 *
 * 【为什么不加 BOM】
 * 加 UTF-8 BOM 能让部分老版本 Windows 记事本自动识别编码，
 * 但 BOM 会被某些播放器当成正文的第一个字符，显示成乱码方块。
 * 本应用自己的解析器能处理 BOM，但导出是给别人用的文件，
 * 优先保证"在播放器里正常"——声明 charset 已经足够。
 *
 * 【为什么延迟 revoke】
 * 立即 revokeObjectURL 在部分浏览器上会让下载中断（导出视频那边同样处理）。
 *
 * @param {string} text
 * @param {string} fileName
 */
function downloadText(text, fileName) {
  const blob = new Blob([text], { type: LRC_MIME })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function useLrcExport() {
  const lyrics = useLyricsStore()
  const player = usePlayerStore()
  const ui = useUiStore()
  const tapping = useTappingStore()

  /**
   * 是否有"还没应用"的打轴草稿。
   *
   * 只统计真正打了时间的行 —— 进了打轴模式但一个点都没打，
   * 算不上"有未应用的成果"，不该拿这个拦用户。
   * @returns {boolean}
   */
  function hasUnappliedDraft() {
    return tapping.tappedCount > 0
  }

  /**
   * 导出 LRC。
   *
   * @returns {{ok:true, lines:number, fileName:string, skipped:number}
   *          | {ok:false, reason:string, lines?:number}}
   */
  function exportLrc() {
    // ① 有未应用的打轴草稿 → 让用户先应用，不要替他决定
    if (hasUnappliedDraft()) {
      const n = tapping.tappedCount
      ui.push({
        level: 'warn',
        message: `还有 ${n} 行打轴结果没有应用`,
        hint: '请先点「应用到歌词」，再导出 —— 否则导出的文件里没有这些时间。',
      })
      return { ok: false, reason: 'unapplied-draft' }
    }

    const lines = lyrics.lines

    // ② 没有任何歌词
    if (!Array.isArray(lines) || lines.length === 0) {
      ui.push({
        level: 'warn',
        message: '还没有歌词可以导出',
        hint: '请先导入 .lrc / .txt 歌词文件。',
      })
      return { ok: false, reason: 'no-lyrics' }
    }

    // ③ 有行但没有一个可用时间 → 不下载空文件
    const { exportable, skipped } = summarizeLrcLines(lines)
    if (exportable === 0) {
      ui.push({
        level: 'warn',
        message: '这些歌词还没有有效的时间，无法导出',
        hint: '纯文本歌词请先在打轴模式里补上时间，并点「应用到歌词」。',
      })
      return { ok: false, reason: 'no-time' }
    }

    // ④ 生成文本与文件名
    const text = buildLrcText(lines, {
      meta: lyrics.meta,
      includeMeta: true,
      precision: 2,
    })

    if (text === '') {
      // 理论上走不到（前面已确认 exportable > 0），留作防御
      ui.push({ level: 'warn', message: '没有可以导出的内容' })
      return { ok: false, reason: 'empty-output' }
    }

    const fileName = buildLrcFileName({
      title: lyrics.meta?.title,
      audioFileName: player.fileName,
    })

    downloadText(text, fileName)

    // ⑤ 成功提示：说清楚导出了多少行，以及是否有被跳过的
    const n = text.split('\n').filter((l) => /^\[\d/.test(l)).length
    ui.push({
      level: 'info',
      message: `已导出 ${n} 行歌词`,
      hint:
        skipped > 0
          ? `${fileName} · 另有 ${skipped} 行时间无效已跳过`
          : `${fileName} · 可直接重新导入本应用`,
    })

    return { ok: true, lines: n, fileName, skipped }
  }

  return { exportLrc, hasUnappliedDraft }
}

/** @type {{current: ReturnType<typeof useLrcExport>|null}} */
const singleton = { current: /** @type {any} */ (null) }

/**
 * 取得全局唯一的导出控制器（首次调用时创建）。
 * 与其他 composable（useVideoExport / useTapping）保持同一套约定。
 * @returns {ReturnType<typeof useLrcExport>}
 */
export function useLrcExportShared() {
  if (!singleton.current) {
    singleton.current = useLrcExport()
  }
  return singleton.current
}
