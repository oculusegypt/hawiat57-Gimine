import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const rawPort = process.env.PORT || '3000';
const port = Number(rawPort) || 3000;
const basePath = process.env.BASE_PATH || '/';

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@workspace/api-client-react': path.resolve(import.meta.dirname, '../../lib/api-client-react/src'),
      '@workspace/api-zod': path.resolve(import.meta.dirname, '../../lib/api-zod/src'),
      '@workspace/db': path.resolve(import.meta.dirname, '../../lib/db/src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          // خرائط Leaflet — كبيرة ومستقلة
          if (id.includes('leaflet')) return 'vendor-leaflet';
          // الرسوم البيانية
          if (id.includes('recharts') || id.includes('/d3-') || id.includes('d3/')) return 'vendor-charts';
          // الحركة
          if (id.includes('framer-motion')) return 'vendor-motion';
          // محرر النصوص TipTap
          if (id.includes('@tiptap')) return 'vendor-editor';
          // مكونات Radix UI
          if (id.includes('@radix-ui')) return 'vendor-radix';
          // React core
          if (id.includes('react-dom') || id.includes('react/') || id.includes('scheduler')) return 'vendor-react';
          // مكتبات نماذج وتحقق
          if (id.includes('react-hook-form') || id.includes('zod') || id.includes('@hookform')) return 'vendor-forms';
          // الأيقونات
          if (id.includes('lucide-react')) return 'vendor-icons';
          // مكتبات التاريخ والمساعدة
          if (id.includes('date-fns') || id.includes('clsx') || id.includes('class-variance') || id.includes('tailwind-merge')) return 'vendor-utils';
        }
      }
    }
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      // Uploaded media is served by the API service in development, while
      // production serves the same /uploads path from the Hostinger web root.
      '/uploads': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
