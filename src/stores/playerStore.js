import { defineStore } from 'pinia'

/**
 * 播放器状态。
 *
 * 阶段 2 起由 `useAudioEngine` 真实驱动：
 *  - 有音频：时间为 `audio.currentTime`
 *  - 无音频：时间为模拟时钟推算值（需求 N1）
 * 两种模式对上层完全透明 —— store 只暴露一个 `currentTime`。
 *
 * 重要约定：**本 store 不操作 DOM、不持有 <audio>**。
 * 所有副作用都在 useAudioEngine 里，store 只做数据。
 */
export const usePlayerStore = defineStore('player', {
  state: () => ({
    playing: false,
    currentTime: 0,
    /** 时长（秒）。有音频时为音频时长；无音频时由歌词时间轴提供 */
    duration: 0,
    volume: 1,
    muted: false,
    rate: 1,

    /** 音频文件元信息 */
    fileName: '',
    fileSize: 0,
    mimeType: '',

    /** 加载中的中间态 */
    loading: false,
    error: '',

    /**
     * 用户是否显式要求了「无音频也滚动」。
     * 由 StageView 在有歌词但无音频时置 true，用于 UI 标注。
     */
    simMode: false,
  }),

  getters: {
    /** 进度 0~1（时长未知时返回 0，避免除零产生 NaN 宽度） */
    progress: (state) => (state.duration > 0 ? Math.min(1, Math.max(0, state.currentTime / state.duration)) : 0),

    /** 是否已载入音频 */
    hasAudio: (state) => Boolean(state.fileName) && state.duration > 0,

    /** 是否处于「无音频、靠模拟时钟滚动」的状态 */
    isSimulated: (state) => !state.fileName && state.duration > 0,

    /** 是否具备播放条件（有音频，或有时长参考可模拟） */
    canPlay: (state) => state.duration > 0,

    volumeIcon: (state) => {
      if (state.muted || state.volume === 0) return 'mute'
      if (state.volume < 0.5) return 'low'
      return 'high'
    },
  },

  actions: {
    /** 阶段 2 起由引擎调用；保留用于测试与直接设值 */
    setTime(seconds) {
      const d = this.duration > 0 ? this.duration : Number.POSITIVE_INFINITY
      this.currentTime = Math.min(Math.max(0, Number(seconds) || 0), d)
    },

    setDuration(seconds) {
      const s = Number(seconds)
      this.duration = Number.isFinite(s) && s > 0 ? s : 0
    },

    togglePlay() {
      this.playing = !this.playing
    },

    setVolume(v) {
      const n = Math.min(1, Math.max(0, Number(v) || 0))
      this.volume = n
      if (n > 0) this.muted = false
    },

    toggleMute() {
      this.muted = !this.muted
    },

    reset() {
      this.playing = false
      this.currentTime = 0
      this.duration = 0
      this.fileName = ''
      this.fileSize = 0
      this.mimeType = ''
      this.loading = false
      this.error = ''
      this.simMode = false
    },
  },
})
