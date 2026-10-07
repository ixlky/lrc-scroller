// @ts-check
/**
 * LRC / 歌词文件导入。
 *
 * 这是唯一允许操作 File / FileReader 的地方（分层约定：composables 负责副作用）。
 * 解析本身全部委托给 core/lrcParser.js 与 core/encoding.js，这里只做：
 *  1. 文件类型与大小校验
 *  2. 编码探测 → 解码
 *  3. 调用解析器
 *  4. 把结果写进 store 并给出用户提示
 */
import { computed } from 'vue'
import { useLyricsStore } from '@/stores/lyricsStore'
import { useUiStore } from '@/stores/uiStore'
import { decodeLrcBuffer, looksGarbled } from '@/core/encoding'
import { parseLrc } from '@/core/lrcParser'
import { CODES, makeMessage } from '@/core/errors'

/** 超过这个大小就提示用户可能需要等待（本地解析，不上传） */
const LARGE_FILE_BYTES = 512 * 1024

/** 允许的歌词文件扩展名 */
const ALLOWED_EXT = ['.lrc', '.txt', '.text']

export function useLrcImport() {
  const lyrics = useLyricsStore()
  const ui = useUiStore()

  /**
   * 注意：`importing` 与 `lastImport` 都存在 store 里，**刻意不做成局部 ref**。
   * 本 composable 会被 TopBar / StageView / LyricsInfoPanel 分别调用，
   * 若用局部 ref，各组件会各持一份互不相通的状态，
   * 表现为"导入成功了但信息面板的诊断区永远空白"——已被 e2e 用例 7 实际抓出过。
   */
  const importing = computed(() => lyrics.importing)
  const lastImport = computed(() => lyrics.lastImport)

  /**
   * 读取并解析一个歌词文件。
   * @param {File} file
   * @param {{silent?:boolean}} [options] silent 为 true 时不弹成功提示（批量/示例导入用）
   * @returns {Promise<boolean>} 是否成功载入
   */
  async function importFile(file, options = {}) {
    if (!file) {
      ui.pushCode(CODES.NO_FILE)
      return false
    }

    lyrics.importing = true
    try {
      // ── 1. 体积提示（不阻止，只是告知）──
      if (file.size > LARGE_FILE_BYTES) {
        ui.pushCode(CODES.FILE_TOO_LARGE, `${(file.size / 1024).toFixed(0)} KB`)
      }

      // ── 2. 扩展名校验：宽松放行，只对明显不是文本的给提示 ──
      const lower = file.name.toLowerCase()
      const ext = lower.slice(lower.lastIndexOf('.'))
      const looksLikeAudio = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus'].includes(ext)
      if (looksLikeAudio) {
        ui.pushCode(CODES.FILE_TYPE_UNSUPPORTED, `这是音频文件（${ext}），请选择 .lrc 歌词文件`)
        return false
      }

      // ── 3. 读取字节并探测编码 ──
      const buffer = await file.arrayBuffer()
      const decoded = decodeLrcBuffer(buffer)

      // ── 4. 解析 ──
      const doc = parseLrc(decoded.text, { encoding: decoded.encoding })

      // ── 5. 编码回退提示（放在解析前，让用户知道中文为何能正常显示）──
      if (decoded.fellBack) {
        ui.pushCode(CODES.LRC_ENCODING_FALLBACK, `${decoded.encoding.toUpperCase()} · ${decoded.reason}`)
      }

      // ── 6. 乱码检测：即使解码"成功"，也可能整体读错 ──
      const garble = looksGarbled(decoded.text)
      if (garble.suspicious && !decoded.fellBack) {
        ui.push({
          level: 'warn',
          message: '歌词文字可能显示不正常',
          hint: `${garble.reason}。如果确实乱码，请把文件另存为 UTF-8 编码后重试。`,
        })
      }

      // ── 7. 写入 store（诊断信息一并写进 store，供信息面板读取）──
      lyrics.loadDoc(doc, {
        fileName: file.name,
        rawText: decoded.text,
        encodingInfo: decoded,
        importMeta: {
          name: file.name,
          encoding: decoded.encoding,
          fellBack: decoded.fellBack,
          reason: decoded.reason,
          bytes: buffer.byteLength,
        },
      })

      // ── 8. 结果反馈 ──
      if (!options.silent) {
        if (doc.lines.length > 0) {
          ui.push({
            level: 'info',
            message: `已载入 ${doc.lines.length} 行歌词`,
            detail: doc.lines.length !== doc.lines.filter((l) => l.empty).length
              ? `其中 ${doc.lines.filter((l) => l.empty).length} 行为间奏空行`
              : undefined,
          })
        }
        // 解析器产出的警告（重复时间、无标签、负数等）逐条告知
        for (const w of doc.warnings) ui.push(w)
      }

      return doc.lines.length > 0 || doc.droppedLines.length > 0
    } catch (err) {
      ui.push({
        ...makeMessage(CODES.FILE_READ_FAIL),
        detail: err instanceof Error ? err.message : String(err),
      })
      return false
    } finally {
      lyrics.importing = false
    }
  }

  /**
   * 从 <input type="file"> 事件导入。
   * @param {Event} event
   */
  async function onFileInput(event) {
    const input = /** @type {HTMLInputElement} */ (event.target)
    const file = input.files?.[0]
    // 先清空 value，保证同一个文件连续选择两次也能触发 change
    input.value = ''
    if (file) await importFile(file)
  }

  /**
   * 处理拖拽放下。
   * @param {DragEvent} event
   */
  async function onDrop(event) {
    const dt = event.dataTransfer
    if (!dt) return
    const files = Array.from(dt.files ?? [])
    if (files.length === 0) return

    // 多文件时只取第一个歌词文件，并提示忽略了其他文件
    const picked = files[0]
    if (files.length > 1) {
      ui.push({
        level: 'info',
        message: `一次只能导入一个歌词文件，已使用「${picked.name}」`,
        hint: `忽略了另外 ${files.length - 1} 个文件。`,
      })
    }
    await importFile(picked)
  }

  return { importing, lastImport, importFile, onFileInput, onDrop, ALLOWED_EXT }
}
