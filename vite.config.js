import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.BASE_PATH || '/',
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },
});
