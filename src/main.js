import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

import './styles/variables.css'
import './styles/base.css'
import './styles/animations.css'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')

// 开发模式下挂载验收钩子（生产构建会被 tree-shake 掉）
if (import.meta.env.DEV) {
  Promise.all([
    import('@/devtools/diagHooks'),
    import('@/stores/playerStore'),
    import('@/stores/lyricsStore'),
    import('@/stores/settingsStore'),
    import('@/composables/useAudioEngine'),
  ]).then(([{ installDiagHooks }, { usePlayerStore }, { useLyricsStore }, { useSettingsStore }, { useAudioEngine }]) => {
    const engine = useAudioEngine()
    installDiagHooks({
      engine,
      player: usePlayerStore(),
      lyrics: useLyricsStore(),
      settings: useSettingsStore(),
      getAudioEl: () => engine.getAudioElement(),
    })
  })
}
