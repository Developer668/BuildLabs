import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const publicVoiceHost = (() => {
  const value = process.env.BUILDLABS_VOICE_PUBLIC_BASE_URL?.trim();
  if (!value) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
})();

const localBindingConfig = {
  main: "./worker/index.ts",
};

export default defineConfig({
  server: {
    ...(publicVoiceHost ? { allowedHosts: [publicVoiceHost] } : {}),
    ...(isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : {}),
  },
  plugins: [
    ...vinext(),
    ...cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      config: localBindingConfig,
    }),
  ],
});
