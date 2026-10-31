import { defineConfig } from 'vite';
import { hayumeriUpdateApi } from './scripts/update-api';
import { hayumeriWorkspaceApi } from './scripts/workspace-api';

// Launcher writes status and timing JSON while Vite is running.
// Chokidar on Windows can emit EBUSY when watching these transient files.
export default defineConfig({
  plugins: [hayumeriUpdateApi(), hayumeriWorkspaceApi()],
  server: {
    watch: {
      ignored: [
        '**/.runtime/**',
        '**/logs/**',
        '**/server/node_modules/**',
        '**/server/**'
      ]
    }
  }
});
