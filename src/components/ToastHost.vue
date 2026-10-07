<script setup>
/**
 * 轻提示宿主。
 * 用 aria-live="polite" 让屏幕阅读器也能得知消息（阶段 7 无障碍验收的基础）。
 */
import { useUiStore } from '@/stores/uiStore'

const ui = useUiStore()
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="`toast--${t.level}`">
        <div class="toast__main">
          <p class="toast__message">{{ t.message }}</p>
          <p v-if="t.detail" class="toast__detail">{{ t.detail }}</p>
          <p v-if="t.hint" class="toast__hint">{{ t.hint }}</p>
        </div>
        <button class="toast__close" type="button" aria-label="关闭提示" @click="ui.dismiss(t.id)">✕</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  bottom: calc(var(--playerbar-h) + 12px);
  left: 50%;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  width: min(440px, calc(100vw - 24px));
  pointer-events: none;
  transform: translateX(-50%);
}

.toast {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-left-width: 3px;
  border-radius: var(--ui-radius);
  background: var(--ui-panel);
  box-shadow: var(--ui-shadow);
  pointer-events: auto;
}

.toast--info {
  border-left-color: var(--ui-accent);
}

.toast--warn {
  border-left-color: var(--ui-warn);
}

.toast--error {
  border-left-color: var(--ui-error);
}

.toast__main {
  flex: 1 1 auto;
  min-width: 0;
}

.toast__message {
  margin: 0;
  font-size: var(--ui-font-sm);
}

.toast__detail,
.toast__hint {
  margin: 3px 0 0;
  color: var(--ui-text-dim);
  font-size: var(--ui-font-xs);
  line-height: 1.45;
}

.toast__close {
  flex: none;
  padding: 0 2px;
  border: none;
  background: transparent;
  color: var(--ui-text-dim);
  font-size: 12px;
  line-height: 1.4;
}

.toast__close:hover {
  color: var(--ui-text);
}
</style>
