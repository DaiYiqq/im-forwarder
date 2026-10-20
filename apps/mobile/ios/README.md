# ios/ · Capacitor iOS 工程（骨架，需 macOS 构建）

该目录由 `npx cap add ios`（@capacitor/ios 6.2.2）在本机 Windows 上生成，包含完整 Xcode 工程：
`App/App.xcodeproj`、`App/Podfile`、`App/App/Info.plist`、Assets 等。**不提供 IPA**：
仓库没有任何 Apple 签名身份，且 iOS 不允许常驻后台转发（本项目 B 模式仅前台运行）。

## 在 macOS 上构建

```bash
cd apps/mobile
npm ci
npm run sync
# 首次安装 pods：
cd ios/App && pod install && cd -
npm run ios:open          # 打开 ios/App/App.xcworkspace
```

- 需要 macOS + Xcode 15+ 与 CocoaPods；Windows/Linux 上 `cap sync` 会跳过 `pod install`（预期告警）。
- Bundle ID：`com.daiyiqq.imforwarder`；版本：`MARKETING_VERSION = 0.2.0`。
- Web 资源由 `npx cap sync` 复制到 `App/App/public/`（已 gitignore），不要手工编辑。

## 本目录的本地化改动

- `App/App/Info.plist` 增加 `NSAppTransportSecurity → NSAllowsArbitraryLoads` 与
  `NSLocalNetworkUsageDescription`，用于访问同一局域网的明文 http/ws（桌面伴生 API / 网关）。
  若部署全部使用 https/wss，请删除该段以恢复 ATS 默认限制。
- `App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` 由
  `apps/mobile/scripts/gen-android-icons.mjs` 生成（纯 Node 手写 PNG）。

## 不做什么

- 不做签名/公证/TestFlight/App Store 上传；
- 不引入任何 Capacitor 插件（无推送、无后台任务、无文件/相机权限）；
- 不添加崩溃上报、遥测、自动更新。
