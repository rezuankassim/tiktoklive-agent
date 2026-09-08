import { defineConfig } from "vite";

// https://vitejs.dev/config
export default defineConfig({
  define: {
    LOCKBAH_UPDATE_URL: JSON.stringify(process.env.LOCKBAH_UPDATE_URL || ""),
  },
});
