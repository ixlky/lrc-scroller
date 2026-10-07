<script setup>
/**
 * 视频导出面板（渲染 + 编码 + 下载 + 兼容性提示）。
 *
 * 产出无声 .mp4 —— 不含音频轨，音频由用户在自己的剪辑软件里对齐。
 * 「渲染当前帧」/「渲染全部帧」是预览（只画不编码），「导出视频」才真的产出文件。
 *
 * 【分辨率与帧率由用户选】
 * 480p / 720p / 1080p / 2K / 4K，24 / 30 / 60 帧。
 * 分辨率与帧率都写进 settings.export，因此会被持久化（刷新后仍是用户选的那档）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { usePlayerStore } from '@/stores/playerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useVideoExportShared, DEFAULT_FPS } from '@/composables/useVideoExport'
import { RESOLUTION_PRESETS, FPS_PRESETS, findResolution } from '@/core/settings'

const player = usePlayerStore()
const settings = useSettingsStore()
const exporter = useVideoExportShared()

/** 预览画布。尺寸由用户选的分辨率决定 */
const canvasRef = ref(/** @type {HTMLCanvasElement|null} */ (null))

/** 最近一次渲染的时间，画在按钮下方便于确认"画的是哪一刻" */
const lastRendered = ref(/** @type {number|null} */ (null))

// ── 逐帧渲染的本地状态（需求：不进 store）──
const rendering = ref(false)
/** 当前跑的是"导出视频"（而非仅渲染），用于按钮文案与进度显示 */
const exporting = ref(false)
const done = ref(0)
const total = ref(0)
const resultText = ref('')
/** @type {import('vue').Ref<AbortController|null>} */
const controller = ref(null)

/**
 * 编码能力探测结果。
 *   'probing'     还在探测
 *   'supported'   至少有一个候选 codec 可用
 *   'unsupported' 都不支持，导出按钮禁用
 */
const codecState = ref(/** @type {'probing'|'supported'|'unsupported'} */ ('probing'))

/** 当前选中的分辨率预设 */
const resolution = computed(() => settings.settings.export?.resolution ?? '720p')
const size = computed(() => findResolution(resolution.value))
const fpsi = computed(() => {
  const v = Number(settings.settings.export?.fps)
  return v > 0 ? v : DEFAULT_FPS
})

/** 用户没显式改过码率（仍是默认 8）时，显示按分辨率推荐的值 */
const bitrate = computed(() => {
  const configured = Number(settings.settings.export?.bitrateMbps)
  return configured > 0 && configured !== 8 ? configured : exporter.recommendBitrate(size.value.height)
})

/**
 * 把画布尺寸同步到所选分辨率。
 * 必须在渲染前完成，否则编码器配置与实际画布不一致会直接失败。
 */
function syncCanvasSize() {
  const c = canvasRef.value
  if (!c) return
  if (c.width !== size.value.width || c.height !== size.value.height) {
    c.width = size.value.width
    c.height = size.value.height
  }
}

/**
 * 探测一次编码能力。
 *
 * 用画布的实际尺寸（而不是写死 720p）—— 有些编码器只在特定分辨率下可用，
 * 探测用的参数必须和真正导出时一致，否则会得到"探测说行、导出却失败"。
 */
async function probe() {
  const c = canvasRef.value
  const w = c?.width || 1280
  const h = c?.height || 720
  const bitrateBps = Math.round(bitrate.value * 1_000_000)
  try {
    const codec = await exporter.pickSupportedCodec(w, h, bitrateBps, fpsi.value)
    codecState.value = codec ? 'supported' : 'unsupported'
  } catch {
    codecState.value = 'unsupported'
  }
}

onMounted(async () => {
  syncCanvasSize()
  await probe()
})

// 换分辨率或帧率都要重新探测：编码器对分辨率/帧率的支持并不一致
watch([resolution, fpsi], async () => {
  codecState.value = 'probing'
  lastRendered.value = null
  syncCanvasSize()
  await probe()
})

const percent = computed(() => (total.value > 0 ? Math.round((done.value / total.value) * 100) : 0))

function onRenderFrame() {
  syncCanvasSize()
  const ok = exporter.renderPreview(canvasRef.value, player.currentTime)
  if (ok) lastRendered.value = player.currentTime
}

/** 共用外壳：置位状态、跑一个导出动作、按 reason 出文案 */
async function run(task) {
  if (rendering.value) return
  rendering.value = true
  done.value = 0
  total.value = 0
  resultText.value = ''

  const ctrl = new AbortController()
  controller.value = ctrl

  try {
    const r = await task(ctrl.signal)
    resultText.value = describe(r)
  } finally {
    rendering.value = false
    exporting.value = false
    controller.value = null
  }
}

/** 把返回值翻成一句人话 */
function describe(r) {
  if (r.ok) {
    if (r.bytes !== undefined) {
      return `已导出 ${r.frames} 帧，文件 ${(r.bytes / 1024 / 1024).toFixed(1)} MB，耗时 ${(r.elapsedMs / 1000).toFixed(1)} 秒`
    }
    return `共 ${r.frames} 帧，耗时 ${(r.elapsedMs / 1000).toFixed(1)} 秒`
  }
  switch (r.reason) {
    case 'codec-unsupported':
      return '当前浏览器不支持该分辨率的 H.264 编码，请改用 Chrome / Edge 或降低分辨率'
    case 'no-timeline':
      return '没有可渲染的时间轴'
    case 'aborted':
      return '已取消'
    case 'encode-failed':
      return '编码失败：画面数据无法编码，请重试'
    default:
      return '导出未能开始'
  }
}

const progressOpts = (signal) => ({
  signal,
  onProgress: (d, tt) => {
    done.value = d
    total.value = tt
  },
})

function onRenderAll() {
  return run((signal) => {
    syncCanvasSize()
    return exporter.renderAll(canvasRef.value, progressOpts(signal))
  })
}

function onExportVideo() {
  exporting.value = true
  return run((signal) => {
    syncCanvasSize()
    return exporter.exportVideo(canvasRef.value, progressOpts(signal))
  })
}

function onCancel() {
  controller.value?.abort()
}
</script>

<template>
  <div class="export-panel">
    <!-- 分辨率 / 帧率：改完立刻反映到画布与编码探测 -->
    <div class="export-panel__settings">
      <label class="export-panel__field">
        <span class="export-panel__label">分辨率</span>
        <select
          class="export-panel__control"
          :value="resolution"
          :disabled="rendering"
          @change="settings.set('export.resolution', $event.target.value)"
        >
          <option v-for="p in RESOLUTION_PRESETS" :key="p.id" :value="p.id">
            {{ p.label }}（{{ p.width }}×{{ p.height }}）
          </option>
        </select>
      </label>

      <label class="export-panel__field">
        <span class="export-panel__label">帧率</span>
        <select
          class="export-panel__control"
          :value="fpsi"
          :disabled="rendering"
          @change="settings.set('export.fps', Number($event.target.value))"
        >
          <option v-for="f in FPS_PRESETS" :key="f.value" :value="f.value">{{ f.label }}</option>
        </select>
      </label>
    </div>

    <p class="export-panel__note">
      画布 {{ size.width }}×{{ size.height }} · {{ fpsi }} 帧 · 约 {{ bitrate }} Mbps
      ——画面按预览舞台等比缩放，动效、行距、字距、字体与配色都与预览一致。
    </p>

    <div class="export-panel__row">
      <button class="btn" type="button" :disabled="rendering" @click="onRenderFrame">渲染当前帧</button>
      <button class="btn" type="button" :disabled="rendering" @click="onRenderAll">渲染全部帧</button>
      <button
        class="btn btn--primary"
        type="button"
        data-tour="export-video"
        :disabled="rendering || codecState === 'unsupported' || codecState === 'probing'"
        @click="onExportVideo"
      >
        {{ exporting ? '导出中…' : '导出视频' }}
      </button>
      <button v-if="rendering" class="btn" type="button" @click="onCancel">取消</button>
    </div>

    <!-- 编码不可用时给出明确指引（预览仍可用，所以只禁「导出视频」） -->
    <p v-if="codecState === 'unsupported'" class="export-panel__warn">
      当前分辨率/帧率组合无法编码，请换一档分辨率或帧率，或改用最新版 Chrome / Edge。
    </p>
    <p v-else-if="codecState === 'probing'" class="export-panel__note">正在检测编码能力…</p>

    <p v-if="lastRendered !== null && !rendering" class="export-panel__note">
      已渲染 {{ lastRendered.toFixed(2) }}s 处的画面
    </p>

    <!-- 用原生 <progress>，不自造进度条样式 -->
    <template v-if="rendering || total > 0">
      <progress class="export-panel__progress" :value="done" :max="total || 1" />
      <p class="export-panel__note">
        <template v-if="rendering">{{ done }} / {{ total }} 帧（{{ percent }}%）</template>
        <template v-else>{{ resultText }}</template>
      </p>
    </template>
    <p v-else-if="resultText" class="export-panel__note">{{ resultText }}</p>

    <p class="export-panel__note">
      导出时请保持页面在前台，否则浏览器会节流后台标签页。
    </p>

    <canvas ref="canvasRef" class="export-panel__canvas" width="1280" height="720" />
    <p class="export-panel__note">
      导出的 MP4 不含音频轨，请在剪辑软件里对齐你的音频文件。
    </p>
  </div>
</template>

<style scoped>
.export-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  margin-top: 8px;
}

.export-panel__settings {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  width: 100%;
}

.export-panel__field {
  display: flex;
  flex: 1 1 140px;
  flex-direction: column;
  gap: 4px;
}

.export-panel__label {
  color: var(--ui-text-dim);
  font-size: var(--ui-font-xs);
}

.export-panel__control {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-2);
  color: var(--ui-text);
  font-size: var(--ui-font-xs);
}

.export-panel__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.export-panel__progress {
  width: 100%;
  height: 10px;
}

.export-panel__canvas {
  width: 100%;
  height: auto;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: #000;
}

.export-panel__note {
  margin: 0;
  color: var(--ui-text-dim);
  font-size: var(--ui-font-xs);
  line-height: 1.45;
}

.export-panel__warn {
  margin: 0;
  color: var(--ui-warn);
  font-size: var(--ui-font-xs);
  line-height: 1.45;
}
</style>
