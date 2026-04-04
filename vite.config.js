import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: 'Graphics/*', dest: 'Graphics' },
        { src: 'CrazyMusic/*', dest: 'CrazyMusic' },
      ],
    }),
  ],
})
