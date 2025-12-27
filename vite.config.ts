import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  // Set the third parameter to '' to load all env regardless of the `VITE_` prefix.
  const env = loadEnv(mode, (process as any).cwd(), '');

  // Check both possible variable names
  const apiKey = env.VITE_GEMINI_API_KEY || env.API_KEY;

  return {
    plugins: [react()],
    define: {
      // Shims process.env.API_KEY to the found value
      'process.env.API_KEY': JSON.stringify(apiKey),
    },
    build: {
      outDir: 'dist',
    }
  };
});