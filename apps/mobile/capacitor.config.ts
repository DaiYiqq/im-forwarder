import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor 配置（Android / iOS 共用）。
 *
 * 关键点：
 *  - webDir 指向共享 Web 应用的构建产物 `apps/companion-web/dist`（相对本文件所在目录）；
 *  - server.androidScheme = "http"：局域网网关与桌面伴生 API 都是明文 http/ws，
 *    WebView 以 http://localhost 作为应用源，避免 https 源下 http 请求被当作混合内容拦截；
 *  - android.allowMixedContent：为仍可能出现的混合内容场景兜底（仅在需要时开启，
 *    见 README「安全取舍」）；
 *  - server.cleartext：允许 WebView 访问明文 HTTP（本地网关场景必需）。
 *
 * 不使用任何插件：依赖白名单只有 @capacitor/{core,cli,android,ios}。
 */
const config: CapacitorConfig = {
  appId: "com.daiyiqq.imforwarder",
  appName: "im-forwarder",
  webDir: "../companion-web/dist",
  server: {
    androidScheme: "http",
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
  ios: {
    contentInset: "always",
  },
};

export default config;
