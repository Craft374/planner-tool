import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from './shared'

const on = (channel: string) => (cb: (...args: any[]) => void) => {
  ipcRenderer.on(channel, (_e, ...args) => cb(...args))
}

const api: Api = {
  platform: process.platform,
  init: () => ipcRenderer.invoke('init'),
  loadButtons: () => ipcRenderer.invoke('buttons:load'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  newSession: (tab, cwd, cols, rows, resume) => ipcRenderer.invoke('session:new', tab, cwd, cols, rows, resume),
  write: (tab, data) => ipcRenderer.send('pty:write', tab, data),
  resize: (tab, cols, rows) => ipcRenderer.send('pty:resize', tab, cols, rows),
  kill: (tab) => ipcRenderer.send('pty:kill', tab),
  confirm: (message, detail, ok) => ipcRenderer.invoke('confirm', message, detail, ok),
  alert: (message) => ipcRenderer.invoke('alert', message),
  notify: (title, body, tab) => ipcRenderer.send('notify', title, body, tab),
  setBusy: (count) => ipcRenderer.send('busy', count),
  setConfig: (config) => ipcRenderer.send('config:set', config),
  editButtons: () => ipcRenderer.send('buttons:edit'),
  setupStatus: () => ipcRenderer.invoke('setup:status'),
  install: (id) => ipcRenderer.invoke('setup:install', id),
  updateClaude: () => ipcRenderer.invoke('claude:update'),
  readInstructions: (cwd) => ipcRenderer.invoke('instructions:read', cwd),
  saveInstructions: (cwd, text) => ipcRenderer.invoke('instructions:save', cwd, text),
  instructionsTemplate: (role) => ipcRenderer.invoke('instructions:template', role),
  onData: on('pty:data'),
  onExit: on('pty:exit'),
  onHook: on('hook'),
  onFocusTab: on('focus-tab'),
  onUpdateLog: on('update:log'),
  onUpdateProgress: on('update:progress'),
}

contextBridge.exposeInMainWorld('api', api)
