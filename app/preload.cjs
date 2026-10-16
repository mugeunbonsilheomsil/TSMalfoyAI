const { contextBridge, ipcRenderer } = require("electron");

const call = async (ch, ...a) => { const r = await ipcRenderer.invoke(ch, ...a); if (!r.ok) throw new Error(r.error); return r.data; };
const on = (ch, fn) => { const h = (_e, d) => fn(d); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

contextBridge.exposeInMainWorld("api", {
  state: () => call("app:state"),
  setup: { detect: () => call("setup:detect"), chooseDir: () => call("setup:chooseDir"), start: (o) => call("setup:start", o), cancel: () => call("setup:cancel") },
  conv: { list: () => call("conv:list"), open: (id) => call("conv:open", id), create: () => call("conv:new"), remove: (id) => call("conv:delete", id), rename: (id, t) => call("conv:rename", id, t) },
  chat: { send: (id, p) => call("chat:send", id, p), regenerate: (id) => call("chat:regenerate", id), alt: (id, m, a) => call("chat:alt", id, m, a), rate: (id, m, v) => call("chat:rate", id, m, v), stop: () => call("chat:stop") },
  story: { points: () => call("story:points"), create: (o) => call("story:create", o), begin: (id) => call("story:begin", id) },
  voice: { status: () => call("voice:status"), install: () => call("voice:install"), warm: () => call("voice:warm"), turn: (id, wav) => call("voice:turn", id, wav), read: (id, m) => call("voice:read", id, m), stop: () => call("voice:stop") },
  mail: { list: () => call("mail:list"), read: (id) => call("mail:read", id), test: () => call("mail:test") },
  settings: { set: (p) => call("settings:set", p) },
  data: { open: () => call("data:open"), forget: () => call("data:forget"), deleteAll: () => call("data:deleteAll"), reinstall: () => call("data:reinstall") },
  on,
});
