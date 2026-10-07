import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { fileURLToPath, URL } from 'node:url'

/**
 * 两套构建目标：
 *  - `pnpm build`          → 单文件 HTML（dist/index.html），双击即可打开，无需服务器
 *  - `pnpm build:multi`    → 常规多文件产物（dist/），用于静态托管/CDN
 *
 * 为什么默认单文件：
 * 浏览器对 `<script type="module">` 强制 CORS 校验，而 `file://` 的 origin 是 null，
 * 因此常规构建产物双击打开会直接白屏。单文件构建把 JS/CSS 内联进 HTML，
 * 绕开模块加载，才真正做到"双击就能用"。
 */
const isMulti = process.env.BUILD_TARGET === 'multi'

export default defineConfig({
  base: './',

  plugins: [
    vue(),
    ...(isMulti ? [] : [viteSingleFile({ removeViteModuleLoader: true })]),
  ],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    // 只绑 ::1 时，127.0.0.1 会 ECONNREFUSED（Windows 上很常见且极易误判为"服务没起来"），
    // 显式监听 IPv4 回环，保证 localhost / 127.0.0.1 两种写法都能访问。
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    open: false,
    watch: {
      // 只监听源码，避免构建产物/文档/脚本目录触发无谓的整页重载。
      // 特别是 scripts/：自动化脚本写入时产生的临时目录会让 Windows 上的
      // 文件监听抛 EBUSY 并直接搞崩 dev server（已实际复现过）。
      ignored: ['**/dist/**', '**/dist-multi/**', '**/docs/**', '**/scripts/**'],
    },
  },

  build: {
    outDir: isMulti ? 'dist-multi' : 'dist',
    emptyOutDir: true,
    // 单文件模式下无需再拆分，禁用体积告警噪音
    chunkSizeWarningLimit: 1500,
    target: 'es2020',
  },
})
