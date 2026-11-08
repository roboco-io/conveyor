/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// index.html의 build 표식. CI가 커밋 SHA를 넣고, 로컬 빌드는 dev로 둔다.
process.env.VITE_BUILD_SHA ??= "dev";

export default defineConfig({
  base: "./",
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
