// @ts-check
/**
 * 音频文件导入。
 *
 * 与 useLrcImport 对称：这里只处理"选文件 → 交给引擎"，不做解析。
 * 真正的加载逻辑在 useAudioEngine.loadFile 里（因为要和 <audio> 生命周期绑定）。
 */
import { computed } from 'vue'
import { usePlayerStore } from '@/stores/playerStore'
import { useUiStore } from '@/stores/uiStore'
import { useAudioEngine } from '@/composables/useAudioEngine'
import { CODES } from '@/core/errors'

/** 超过这个大小提示用户（音频通常较大，仅提示不阻止） */
const LARGE_AUDIO_BYTES = 100 * 1024 * 1024

export function useAudioImport() {
  const player = usePlayerStore()
  const ui = useUiStore()
  const engine = useAudioEngine()

  const importing = computed(() => player.loading)

  /**
   * 导入一个音频文件。
   * @param {File} file
   * @returns {Promise<boolean>}
   */
  async function importAudio(file) {
    if (!file) {
      ui.pushCode(CODES.NO_FILE)
      return false
    }

    if (file.size > LARGE_AUDIO_BYTES) {
      ui.push({
        level: 'warn',
        message: `音频较大（${(file.size / 1024 / 1024).toFixed(0)} MB）`,
        hint: '浏览器需要一些时间读取，请耐心等待。全程在本地处理，不会上传。',
      })
    }

    // 误把歌词文件当音频选时，给出针对性提示
    const lower = file.name.toLowerCase()
    if (lower.endsWith('.lrc') || lower.endsWith('.txt')) {
      ui.pushCode(CODES.FILE_TYPE_UNSUPPORTED, `「${file.name}」看起来是歌词文件，请用「导入 LRC」按钮`)
      return false
    }

    return engine.loadFile(file)
  }

  /**
   * 从 <input type="file"> 事件导入。
   * @param {Event} event
   */
  async function onAudioInput(event) {
    const input = /** @type {HTMLInputElement} */ (event.target)
    const file = input.files?.[0]
    // 先清空，保证连续选同一个文件也能触发 change
    input.value = ''
    if (file) await importAudio(file)
  }

  /** 支持把音频拖到舞台上 */
  async function onAudioDrop(event) {
    const dt = event.dataTransfer
    const files = Array.from(dt?.files ?? [])
    if (files.length === 0) return false

    // 只挑第一个看起来像音频的文件；若都没有，交给歌词导入处理
    const audioExt = ['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus']
    const picked = files.find((f) => audioExt.some((e) => f.name.toLowerCase().endsWith(e)))
    if (!picked) return false

    await importAudio(picked)
    return true
  }

  return { importing, importAudio, onAudioInput, onAudioDrop }
}
