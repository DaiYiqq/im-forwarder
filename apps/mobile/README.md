# apps/mobile · Capacitor 移动端外壳（Android / iOS）

本目录是 im-forwarder 的 **Capacitor 原生工程**：WebView 加载共享 Web 应用
`apps/companion-web/dist`（`capacitor.config.ts` 的 `webDir` 指向 `../companion-web/dist`）。
Android 产物为 **debug APK（侧载）**；iOS 只提供可构建的 Xcode 工程骨架，不提供 IPA
（iOS 不允许常驻后台转发，且本仓库不使用任何签名身份）。

## 目录

```
apps/mobile/
├─ package.json            scripts: sync / android:debug / android:open / ios:open / icons
├─ capacitor.config.ts     appId com.daiyiqq.imforwarder，webDir ../companion-web/dist
├─ scripts/
│  ├─ prepare-web.mjs      sync 前确保 companion-web/dist 存在（缺失则自动构建）
│  ├─ gradle.mjs           跨平台调用 android/gradlew 构建 APK
│  └─ gen-android-icons.mjs 纯 Node 生成 mipmap 多尺寸图标 + iOS AppIcon
├─ android/                Capacitor Android 工程（由 npx cap add android 生成）
├─ ios/                    Capacitor iOS 工程（由 npx cap add ios 生成；构建需 macOS + Xcode）
└─ README.md
```

## 前置要求

| 目标 | 要求 |
| --- | --- |
| 本地 `npm run sync` | Node ≥ 18、已安装本目录依赖 |
| Android 构建 | JDK 17、Android SDK（compileSdk 34 / build-tools） |
| iOS 构建 | macOS + Xcode 15+、CocoaPods（`pod install`） |

## 命令

```bash
cd apps/mobile
npm ci                       # 或 npm install
npm run sync                 # 确保 companion-web/dist 就绪 → npx cap sync（android + ios）
npm run icons                # 重新生成 Android mipmap 图标与 iOS AppIcon
npm run android:debug        # 需要 JDK17 + Android SDK：构建 debug APK
npm run android:open         # 用 Android Studio 打开
npm run ios:open             # 需 macOS：用 Xcode 打开
```

`npm run sync` 的输出（本机 Windows 验证）：

- 复制 web 资产到 `android/app/src/main/assets/public` 与 `ios/App/App/public`；
- 生成 `android/app/src/main/assets/capacitor.config.json`、`ios/App/App/capacitor.config.json`；
- 更新 Gradle 配置；iOS 侧在本机跳过 `pod install`（未安装 CocoaPods，属预期）。

## Android：构建与侧载

CI（`.github/workflows/release.yml` 的 `android` job）在 ubuntu + 预装 Android SDK 上执行：

```bash
npm ci --prefix apps/mobile
npm --prefix apps/mobile run sync
cd apps/mobile/android
chmod +x gradlew
./gradlew assembleDebug --no-daemon -Dorg.gradle.jvmargs=-Xmx3g
```

默认产物：`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`（Capacitor 默认路径，
CI 会重命名为 `im-forwarder-0.2.0-android-debug.apk`）。

侧载：把 APK 传到 Android 手机 → 允许"安装未知应用"→ 安装。
桌面端与手机需在同一局域网；桌面端要开启「局域网访问 / 伴生服务」并放行防火墙端口。

本机无 Android SDK，因此**未在本机执行 gradle**；`android/` 工程由 `npx cap add android` 生成，
并对以下文件做了调整：

- `app/src/main/AndroidManifest.xml`：`android:label="im-forwarder"`、`android:usesCleartextTraffic="true"`，
  已有 `INTERNET` 权限；
- `app/build.gradle`：`versionCode 2` / `versionName "0.2.0"`；
- `res/mipmap-*`：替换为新生成的图标（脚本可重复执行）；
- `res/values/ic_launcher_background.xml`：adaptive icon 背景色 `#0B1B2B`。

## iOS：工程骨架与构建

`npx cap add ios` 已在本机（Windows）成功生成完整工程骨架
（`ios/App/App.xcodeproj`、`Podfile`、`Info.plist`、Assets 等）。构建仍然**只能在 macOS** 上完成：

```bash
# 在 macOS 上：
cd apps/mobile
npm ci
npm run sync
npm run ios:open        # 或用 Xcode 打开 ios/App/App.xcworkspace
# 首次需要在 Xcode 中执行 pod install（或终端：cd ios/App && pod install）
```

- 未提供 IPA：本仓库没有任何 Apple 签名身份，且 iOS 不允许常驻后台转发；
- `ios/App/App/Info.plist` 已加入 `NSAppTransportSecurity → NSAllowsArbitraryLoads`
  与 `NSLocalNetworkUsageDescription`，用于访问局域网明文 http/ws（见下文安全取舍）；
- 若部署全部使用 https/wss，请删除 ATS 放开段并改用安全传输。

## 安全取舍（明确记录）

1. **明文 HTTP（Android `usesCleartextTraffic` / iOS ATS 放开）**：桌面伴生 API 与 EasyBot 网关
   都在局域网内以 http/ws 提供，且地址由用户运行时填写，无法预先固定域名证书。
   因此允许明文；这意味着**同一局域网内的攻击者可以嗅探/篡改**这些请求，请不要在不可信 Wi-Fi 下使用。
   若你的网关与桌面端支持 https/wss，建议关掉这两处放开（Android 移除属性、iOS 删除 ATS 段）。
2. **`allowMixedContent: true`**：应用源为 `http://localhost`（`androidScheme: "http"`），
   访问 http 网关本身不构成混合内容；该开关是为少数仍以 https 加载外壳的场景兜底。
   不加载任何第三方页面，WebView 不做通用浏览器用途。
3. **不引入任何 Capacitor 插件**（依赖白名单只有 core/cli/android/ios）：没有剪贴板、相机、
   文件、后台服务、推送等能力，减少攻击面；也因此**没有后台转发**（B 模式锁屏即停）。
4. **不添加**：遥测、崩溃上报、自动更新、签名密钥。
5. **`INTERNET` 权限是唯一新增权限**；不申请存储、位置、通讯录等权限。

## 与共享 Web 应用的关系

本目录不包含业务代码。所有 UI/逻辑（连接、状态、路由、日志、B 模式）都在
`apps/companion-web`；这里只做原生壳、配置与图标。修改界面请改 `apps/companion-web`。

> 注意：`npm run sync` 会把 `apps/companion-web/dist` 复制进原生工程的 `public/` 目录，
> 这些副本已被两级 `.gitignore` 忽略（`app/src/main/assets/public`、`ios/App/App/public`），
> 不要手工编辑。
