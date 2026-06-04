// Safe decodeURI and decodeURIComponent overrides to handle unescaped '%' in paths/URLs
const originalDecodeURI = globalThis.decodeURI;
globalThis.decodeURI = function (str) {
  if (typeof str !== 'string') return originalDecodeURI(str);
  try {
    return originalDecodeURI(str);
  } catch (e) {
    try {
      // Replace '%' not followed by two hex digits with '%25'
      const safeStr = str.replace(/%(?![0-9a-fA-F]{2})/g, '%25');
      return originalDecodeURI(safeStr);
    } catch {
      return str;
    }
  }
};

const originalDecodeURIComponent = globalThis.decodeURIComponent;
globalThis.decodeURIComponent = function (str) {
  if (typeof str !== 'string') return originalDecodeURIComponent(str);
  try {
    return originalDecodeURIComponent(str);
  } catch (e) {
    try {
      // Replace '%' not followed by two hex digits with '%25'
      const safeStr = str.replace(/%(?![0-9a-fA-F]{2})/g, '%25');
      return originalDecodeURIComponent(safeStr);
    } catch {
      return str;
    }
  }
};


import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    base: './',
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      global: 'window',
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        'stream': path.resolve(__dirname, 'src/lib/stream-mock.js'),
        'assert': path.resolve(__dirname, 'src/lib/assert-mock.js'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâ€”file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
