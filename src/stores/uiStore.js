import { defineStore } from 'pinia'
import { makeMessage } from '@/core/errors'

/**
 * 轻提示（Toast）队列。
 * 阶段 0 用来告诉用户"这个按钮属于后面哪个阶段"，后续复用为错误/成功提示。
 */
export const useUiStore = defineStore('ui', {
  state: () => ({
    /** @type {Array<{id:number, level:string, message:string, hint?:string, detail?:string}>} */
    toasts: [],
    nextId: 1,
  }),

  actions: {
    /**
     * 推入一条提示。
     * @param {{level?:string, message:string, hint?:string, detail?:string}} payload
     * @param {number} [durationMs] 0 表示不自动消失
     */
    push(payload, durationMs = 3600) {
      const id = this.nextId++
      const toast = {
        id,
        level: payload.level ?? 'info',
        message: payload.message,
        hint: payload.hint,
        detail: payload.detail,
      }
      this.toasts.push(toast)
      // 最多同时显示 4 条，避免刷屏
      if (this.toasts.length > 4) this.toasts.shift()
      if (durationMs > 0) {
        setTimeout(() => this.dismiss(id), durationMs)
      }
      return id
    },

    /** 由错误码推送（文案统一来自 core/errors）。 */
    pushCode(code, detail) {
      return this.push(makeMessage(code, detail))
    },

    dismiss(id) {
      const i = this.toasts.findIndex((t) => t.id === id)
      if (i !== -1) this.toasts.splice(i, 1)
    },

    clear() {
      this.toasts.splice(0, this.toasts.length)
    },
  },
})
