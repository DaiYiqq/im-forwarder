/**
 * 主进程使用的核心复用入口。
 *
 * 这里的每一行都是 **原样复用** 仓库核心（../../../src）的实现，不做任何改写：
 *   · loadConfig：危险键扫描 + strict schema（未知字段即失败）
 *   · runPreflight：合规硬闸（违规只能报错，没有 force / skip 开关）
 *   · evaluateCrossBorderGate：出境闸门状态
 *
 * 该文件同时被 esbuild 打包为 dist/preflight.cjs（供主进程在保存配置前独立调用）
 * 与内联进 dist/main.cjs；两处行为完全一致。
 */

export {
  ConfigError,
  describeConfig,
  findForbiddenConfigKeys,
  loadConfig,
  type LoadConfigOptions,
} from "../../../src/config/load";
export {
  CONSENT_NOTICE_VERSION,
  RISK_NOTICE_VERSION,
  rawConfigSchema,
  type AppConfig,
} from "../../../src/config/schema";
export {
  ComplianceHalt,
  formatPreflightFailure,
  runPreflight,
  type ComplianceViolation,
  type PreflightReport,
} from "../../../src/compliance/preflight";
export { CROSS_BORDER_RISK_NOTICE } from "../../../src/compliance/cross-border";
export { evaluateCrossBorderGate } from "../../../src/compliance/gates";
