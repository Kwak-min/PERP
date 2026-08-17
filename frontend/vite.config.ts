import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    watch: {
      // ⚠️ 서버 watcher가 휘발성 산출물(테스트 프로필/빌드)을 감시하면
      // 외부 프로세스가 파일을 잠근 상태로 Vite가 EBUSY로 죽는 실수가 잦다.
      ignored: ["**/.artifacts/**", "**/dist/**"],
    },
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/api": "http://127.0.0.1:8111",
      "/health": "http://127.0.0.1:8111",
    },
  },
});
