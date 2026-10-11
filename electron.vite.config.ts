import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    root: 'src/UI',
    build: {
      rollupOptions: {
        input: resolve('src/UI/index.html')
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/UI/src')
      }
    },
    plugins: [react()]
  }
})
