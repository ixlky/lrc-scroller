<script setup>
/**
 * 应用骨架：顶栏 / 歌词舞台 / 播放条 三行布局。
 *
 * 这里是唯一把"用户设置"翻译成 CSS 变量的地方：
 * 根元素挂上 --lrc-* 变量后，所有歌词行共享同一套值，
 * 改一个设置只触发一次样式重算（阶段 3 的性能验收依赖这一点）。
 *
 * 需求 N2：设置抽屉打开时，主内容整体让出右侧空间，
 * 避免抽屉盖住舞台右下角的跳行胶囊与播放条的音量滑杆。
 * 用 padding-right（而非 transform）的原因：
 * transform 只是把内容移走，左侧会被裁掉；padding 让内容真正变窄、重新排版，
 * 长歌词会自动换行到可见区域内。
 *
 * 阶段 4 展示模式：is-presenting 让顶栏、播放条、设置抽屉、提示全部淡出，
 * 舞台独占整个视口。控制条（播放条）单独用 is-control-hidden 控制，
 * 因为它要跟随鼠标活动淡入淡出，而其他 UI 在展示模式下始终隐藏。
 */
import { computed, onMounted, ref } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'
import TopBar from '@/components/TopBar.vue'
import StageView from '@/components/StageView.vue'
import PlayerBar from '@/components/PlayerBar.vue'
import SettingsDrawer from '@/components/settings/SettingsDrawer.vue'
import ToastHost from '@/components/ToastHost.vue'
import TutorialOverlay from '@/components/TutorialOverlay.vue'
import { useKeyboard } from '@/composables/useKeyboard'
import { useFullscreenShared } from '@/composables/useFullscreen'
import { useTutorialShared, AUTO_OPEN_DELAY_MS } from '@/composables/useTutorial'

const settings = useSettingsStore()

// 全局快捷键（空格播放/暂停、←→ 快进退、↑↓ 音量、M 静音、F 全屏、Esc 退出）
useKeyboard()

const shellRef = ref(/** @type {HTMLElement|null} */ (null))

// 单例：App / TopBar / useKeyboard 共享同一份展示模式状态
const full = useFullscreenShared({ reduceMotion: computed(() => settings.reduceMotion) })

// 单例：教程状态（TopBar 的按钮、这里的遮罩、useKeyboard 的键盘让位共用）
const tut = useTutorialShared()

/**
 * 首次打开自动弹教程。
 *
 * 【为什么延迟而不是立刻弹】
 * 首屏布局、字体都还没稳定，立刻测量目标位置会画偏高亮框。
 * 延迟一小段同时让用户先看到页面长什么样，再被引导。
 *
 * 【为什么用 seen 判断而不是每次刷新都弹】
 * "只给第一次打开的用户看"是明确需求。标记写在 localStorage，
 * 隐私模式下写不进去时会再弹一次 —— 那是可接受的降级（不会报错）。
 */
onMounted(() => {
  if (tut.seen.value) return
  setTimeout(() => {
    // 用户可能在这 600ms 里已经开始操作（比如打开了抽屉），就不再打扰
    if (tut.seen.value || tut.active.value) return
    if (settings.drawerOpen) return
    tut.start()
  }, AUTO_OPEN_DELAY_MS)
})

const rootStyle = computed(() => settings.cssVars)
const rootClass = computed(() => ({
  'reduce-motion': settings.reduceMotion,
  'is-drawer-open': settings.drawerOpen,
  'is-presenting': full.isPresenting.value,
  // 展示模式但没拿到原生全屏（iOS Safari / 受限环境）→ 伪全屏，
  // 用 fixed + 100dvh 把界面铺满视口，功能与原生全屏完全一致
  'is-pseudo-fullscreen': full.isDegraded.value,
  // 控制条是否隐藏（鼠标活动 → false，静止 2 秒 → true）
  'is-control-hidden': full.isPresenting.value && !full.controlVisible.value,
}))
</script>

<template>
  <div ref="shellRef" class="app-shell" :class="rootClass" :style="rootStyle">
    <TopBar />

    <main class="app-stage">
      <StageView />
    </main>

    <PlayerBar />

    <SettingsDrawer />
    <ToastHost />

    <!-- 新手教程：Teleport 到 body，避免被 .app-shell 的 padding 影响 -->
    <TutorialOverlay />
  </div>
</template>
