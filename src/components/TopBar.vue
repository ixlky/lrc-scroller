<script setup>
/**
 * 顶栏：导入入口 + 全屏 + 教程 + 设置。
 *
 * 阶段 2 起「导入音频」也真实可用（阶段 1 时只提示"属于阶段 2"）。
 * 两种文件都支持点选与拖拽到舞台。
 *
 * 【data-tour 属性】
 * 教程（TutorialOverlay）靠 `data-tour="…"` 定位要高亮的元素，
 * 而不是 class —— class 会随样式重构被改掉，data-tour 只服务教程，语义稳定。
 */
import { ref } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'
import { useLyricsStore } from '@/stores/lyricsStore'
import { useUiStore } from '@/stores/uiStore'
import { useLrcImport } from '@/composables/useLrcImport'
import { useAudioImport } from '@/composables/useAudioImport'
import { useFullscreenShared } from '@/composables/useFullscreen'
import { useTutorialShared } from '@/composables/useTutorial'

const settings = useSettingsStore()
const lyrics = useLyricsStore()
const ui = useUiStore()
const { importing, onFileInput } = useLrcImport()
const { importing: audioImporting, onAudioInput } = useAudioImport()
// 单例：与 App.vue 的 CSS 类、useKeyboard 的 F/Esc 共享同一份状态
const full = useFullscreenShared()
// 单例：与 useKeyboard、App.vue 的遮罩共享同一份教程状态
const tut = useTutorialShared()

/**
 * 隐藏的文件输入：用按钮触发，便于自定义外观。
 * 必须用 Vue 的 ref()，否则模板 ref="fileInput" 不会绑定到这个变量，
 * 点击按钮会毫无反应（这类静默失败最难查）。
 */
const fileInput = ref(/** @type {HTMLInputElement|null} */ (null))
const audioInput = ref(/** @type {HTMLInputElement|null} */ (null))

function pickLrc() {
  fileInput.value?.click()
}

function pickAudio() {
  audioInput.value?.click()
}

/**
 * 进入/退出全屏。
 *
 * 全屏的目标元素是 .app-shell（包含歌词与播放条），
 * 而不是 documentElement —— 这样原生全屏下 CSS 类照样生效。
 * 拿不到原生全屏时 useFullscreen 会自动降级为伪全屏并提示用户。
 *
 * onBeforeEnter 里关抽屉：全屏里抽屉会淡出，留着它还会给
 * .app-shell 留一条 padding-right 避让，导致舞台右侧露白（真机 BUG）。
 */
function onPresent() {
  full.toggle(document.querySelector('.app-shell') ?? document.documentElement, {
    onBeforeEnter: () => settings.closeDrawer(),
  })
}

/**
 * 打开教程。
 * 每次点都从头开始 —— 用户点它就是为了"再看一遍"。
 * 教程进行中要独占键盘，因此先把可能开着的抽屉收起来，
 * 避免遮罩下的抽屉抢走焦点（也避免教程结束后面板状态混乱）。
 */
function onTutorial() {
  settings.closeDrawer()
  tut.start()
}
</script>

<template>
  <header class="topbar">
    <div class="topbar__brand">
      <span class="topbar__logo" aria-hidden="true">♪</span>
      <div class="topbar__titles">
        <h1 class="topbar__title">LRC 歌词滚动字幕</h1>
        <p class="topbar__sub">
          <template v-if="lyrics.meta.title || lyrics.meta.artist">
            {{ lyrics.meta.title }}<span v-if="lyrics.meta.artist"> · {{ lyrics.meta.artist }}</span>
          </template>
          <template v-else-if="lyrics.lastFileName">{{ lyrics.lastFileName }}</template>
          <template v-else> 未导入歌词 </template>
          <span class="topbar__badge">{{ lyrics.count }} 行</span>
          <span v-if="lyrics.meta.offsetMs !== 0" class="topbar__badge topbar__badge--offset">
            offset {{ lyrics.meta.offsetMs > 0 ? '+' : '' }}{{ lyrics.meta.offsetMs }}ms
          </span>
        </p>
      </div>
    </div>

    <div class="topbar__actions">
      <!-- 教程：随时可重放（首次打开也会自动弹一次） -->
      <button
        class="btn btn--ghost topbar__tutorial"
        type="button"
        data-tour="tutorial"
        title="重新观看新手教程"
        @click="onTutorial"
      >
        教程
      </button>

      <button
        class="btn"
        type="button"
        data-tour="import-audio"
        :disabled="audioImporting"
        @click="pickAudio"
      >
        {{ audioImporting ? '读取中…' : '导入音频' }}
      </button>

      <button
        class="btn btn--primary"
        type="button"
        data-tour="import-lyric"
        :disabled="importing"
        @click="pickLrc"
      >
        {{ importing ? '解析中…' : '导入 txt / lrc' }}
      </button>

      <button
        class="btn btn--ghost"
        type="button"
        data-tour="fullscreen"
        :aria-pressed="full.isPresenting.value"
        title="进入全屏（F 键切换，Esc 退出）"
        @click="onPresent"
      >
        {{ full.isPresenting.value ? '退出全屏' : '全屏' }}
      </button>

      <button
        class="btn btn--icon"
        type="button"
        data-tour="settings"
        :aria-expanded="settings.drawerOpen"
        aria-controls="settings-drawer"
        @click="settings.toggleDrawer()"
      >
        设置
      </button>
    </div>

    <!-- 真实的文件选择框，视觉上隐藏但可被无障碍技术访问 -->
    <input
      ref="fileInput"
      class="sr-only"
      type="file"
      accept=".lrc,.txt,.text,text/plain"
      aria-label="选择 LRC 歌词文件"
      @change="onFileInput"
    />
    <input
      ref="audioInput"
      class="sr-only"
      type="file"
      accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg,.opus"
      aria-label="选择音频文件"
      @change="onAudioInput"
    />
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  gap: var(--ui-gap);
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-panel);
}

.topbar__brand {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
}

.topbar__logo {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: linear-gradient(135deg, var(--ui-accent), #8a5cff);
  color: #fff;
  font-size: 16px;
}

.topbar__titles {
  min-width: 0;
}

.topbar__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.25;
}

.topbar__sub {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 0;
  overflow: hidden;
  color: var(--ui-text-dim);
  font-size: var(--ui-font-xs);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.topbar__badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--ui-panel-2);
  font-size: 11px;
}

.topbar__badge--offset {
  background: color-mix(in srgb, var(--ui-accent) 22%, transparent);
  color: var(--ui-accent);
}

.topbar__actions {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
}

@media (width <= 720px) {
  .topbar__sub {
    display: none;
  }

  /*
   * 窄屏收起次要按钮。
   *
   * 【为什么排除「教程」】
   * 教程是用户**唯一**能主动重放入门引导的入口
   * （首次弹出被跳过之后就找不回来了），所以它必须一直在。
   * 全屏按钮窄屏可以收 —— 手机上本来也没有"原生全屏"的强需求。
   */
  .topbar__actions .btn--ghost:not(.topbar__tutorial) {
    display: none;
  }
}

/*
 * 窄屏（≤430px）下顶栏按钮的防溢出处理。
 *
 * 【背景】按钮文案从「导入 LRC」改成「导入 txt / lrc」后多了 5 个字符，
 * 在 375px 视口下把 .topbar 撑到 377px，整页出现 2px 横向溢出
 * （e2e-stage0 的「375px 视口下无横向溢出」抓到的）。
 *
 * 【为什么用容器查询而不是固定断点】
 * 顶栏实际有多宽取决于**按钮文案长度**，不是视口宽度。
 * 固定断点（如 ≤400px 就缩小字号）在文案再变一次时就会失效。
 * 用 container query 让规则跟着"容器是否放得下"走，更贴合问题本质。
 *
 * 【注意】container-type 必须写在**被查询元素的祖先**上，
 * 不能写在 @container 规则内部 —— 那样元素会先按普通元素布局，
 * 再决定自己是否成为容器，规则永远匹配不上（自指，浏览器直接忽略）。
 */
.topbar {
  container-type: inline-size;
  container-name: topbar;
}

@container topbar (max-width: 430px) {
  .topbar__actions .btn {
    padding: 7px 9px;
    font-size: 12px;
  }
}
</style>
