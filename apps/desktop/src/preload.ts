/**
 * preload：渲染进程唯一的能力边界。
 *
 * 安全约束（与 main.ts 的 webPreferences 一致）：
 *   · contextIsolation: true、nodeIntegration: false、sandbox: true；
 *   · 只暴露下面这些**具名函数**，不暴露 ipcRenderer / require / process；
 *   · 没有任何"读取任意文件""执行任意命令""读取令牌明文"的通道；
 *   · 事件订阅返回取消函数，避免渲染进程反复重载后监听器泄漏。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AppInfo,
  CompanionState,
  ConfigState,
  ControlResult,
  DesktopApi,
  LogRecord,
  SaveResult,
  StatusSnapshot,
  TokenStatus,
  ValidationResult,
} from "./ipc";
import { IPC } from "./ipc";

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    callback(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: DesktopApi = {
  getStatus: () => ipcRenderer.invoke(IPC.statusGet) as Promise<StatusSnapshot>,
  getConfig: () => ipcRenderer.invoke(IPC.configRead) as Promise<ConfigState>,
  getExampleConfig: () => ipcRenderer.invoke(IPC.configExample) as Promise<string>,
  validateConfig: (yaml: string) =>
    ipcRenderer.invoke(IPC.configValidate, yaml) as Promise<ValidationResult>,
  saveConfig: (yaml: string) => ipcRenderer.invoke(IPC.configSave, yaml) as Promise<SaveResult>,
  getTokenStatus: () => ipcRenderer.invoke(IPC.tokenStatus) as Promise<TokenStatus>,
  setToken: (token: string) => ipcRenderer.invoke(IPC.tokenSet, token) as Promise<TokenStatus>,
  clearToken: () => ipcRenderer.invoke(IPC.tokenClear) as Promise<TokenStatus>,
  start: () => ipcRenderer.invoke(IPC.coreStart) as Promise<ControlResult>,
  stop: () => ipcRenderer.invoke(IPC.coreStop) as Promise<ControlResult>,
  getCompanionState: () => ipcRenderer.invoke(IPC.companionState) as Promise<CompanionState>,
  setLanMode: (enabled: boolean, acknowledged: boolean) =>
    ipcRenderer.invoke(IPC.companionLanMode, { enabled, acknowledged }) as Promise<CompanionState>,
  setCompanionPort: (port: number) =>
    ipcRenderer.invoke(IPC.companionPort, port) as Promise<CompanionState>,
  newPairCode: () => ipcRenderer.invoke(IPC.companionNewPairCode) as Promise<CompanionState>,
  getLogs: (limit?: number) => ipcRenderer.invoke(IPC.logsList, limit) as Promise<LogRecord[]>,
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<boolean>,
  onStatus: (callback: (status: StatusSnapshot) => void) => subscribe(IPC.statusChanged, callback),
  onLog: (callback: (record: LogRecord) => void) => subscribe(IPC.logNew, callback),
  onCompanion: (callback: (state: CompanionState) => void) =>
    subscribe(IPC.companionChanged, callback),
};

contextBridge.exposeInMainWorld("desktop", api);
