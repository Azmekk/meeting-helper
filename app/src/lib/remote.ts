// Secret mode, main-window side.
//
// Phone remote: remote.rs runs a LAN server for the phone page. While it runs,
// this module pushes the live snapshot to phones (remote_broadcast; Rust
// encrypts) and turns phone commands (`remote://message`) into the same calls
// the overlay's events trigger in live.ts. The pairing key is kept in the OS
// keyring as `remote_key`, so a paired phone keeps working after a restart.
//
// Hiding: a global shortcut hides the main window completely (and the
// overlay), with no taskbar entry and no toasts until it's shown again.
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { create } from 'zustand';
import { errorMessage } from '../components/ui';
import type { FromPhone, ToPhone } from '../remote/protocol';
import { isHidden, setHiddenFlag } from './hidden';
import { OVERLAY_LABEL, getLiveSnapshot, helpMeAnswer, setLiveModel, useLive } from './live';
import { getSecret, setSecret } from './secrets';
import { getSettings, useSettings } from './settings';

export interface RemoteStatus {
  running: boolean;
  port: number | null;
  addresses: string[]; // LAN IPv4, likeliest first
  clients: number;
}

interface RemoteState {
  status: RemoteStatus;
  key: string | null;
  starting: boolean;
  error: string | null;
  hidden: boolean;
  hotkeyError: string | null;
}

export const useRemote = create<RemoteState>(() => ({
  status: { running: false, port: null, addresses: [], clients: 0 },
  key: null,
  starting: false,
  error: null,
  hidden: false,
  hotkeyError: null,
}));
const set = useRemote.setState;
const get = useRemote.getState;

export function remoteUrl(address: string, port: number, key: string): string {
  return `http://${address}:${port}/#k=${key}`;
}

// ---------- Pairing key ----------

async function ensureKey(): Promise<string> {
  const known = get().key ?? (await getSecret('remote_key'));
  if (known) {
    set({ key: known });
    return known;
  }
  return rePair();
}

// New key: phones paired with the old one are disconnected and must rescan.
export async function rePair(): Promise<string> {
  const key = await invoke<string>('remote_pair');
  await setSecret('remote_key', key);
  set({ key });
  return key;
}

// ---------- Server ----------

export async function startRemote(): Promise<void> {
  set({ starting: true, error: null });
  try {
    const key = await ensureKey();
    const status = await invoke<RemoteStatus>('remote_start', { port: getSettings().remotePort, key });
    set({ status, starting: false });
  } catch (err) {
    set({ starting: false, error: errorMessage(err) });
  }
}

// Phone access from the Record screen or the overlay: turns secret mode on
// (the settings subscriber then starts the server) and waits for the server.
export async function enablePhone(): Promise<void> {
  if (!getSettings().remoteEnabled) {
    try {
      await useSettings.getState().update({ remoteEnabled: true });
    } catch (err) {
      set({ error: errorMessage(err) });
      return;
    }
  }
  if (!get().status.running) await startRemote();
}

// What the overlay shows behind its phone button (it can't read the key itself).
export interface PhoneLinkInfo {
  url: string | null;
  clients: number;
  error: string | null;
}

function sendPhoneLink() {
  const { status, key, error } = get();
  const ip = status.addresses[0];
  const url = status.running && status.port && key && ip ? remoteUrl(ip, status.port, key) : null;
  const noAddress = status.running && !ip ? 'No local network address found. Connect this PC to Wi-Fi.' : null;
  const info: PhoneLinkInfo = { url, clients: status.clients, error: error ?? noAddress };
  void emit('remote://phone-link', info).catch(() => {});
}

export async function stopRemote(): Promise<void> {
  await invoke('remote_stop').catch(() => {});
  await refreshRemoteStatus();
}

export async function refreshRemoteStatus(): Promise<void> {
  try {
    set({ status: await invoke<RemoteStatus>('remote_status') });
  } catch (err) {
    set({ error: errorMessage(err) });
  }
}

// ---------- Snapshot push ----------

const PUSH_EVERY_MS = 200; // at most 5 pushes a second
let lastPush = 0;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let lastAnswerKey = '';

function pushNow() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
  const { status } = get();
  if (!status.running || !status.clients) return;
  lastPush = Date.now();
  const msg: ToPhone = { type: 'state', snap: getLiveSnapshot(), hidden: isHidden(), canHide: canHide() };
  void invoke('remote_broadcast', { payload: JSON.stringify(msg) }).catch(() => {});
}

// Driven by store changes rather than a timer loop, because a hidden window's
// timers can be throttled hard; the trailing timer only covers the last change.
function schedulePush() {
  const { status } = get();
  if (!status.running || !status.clients) return;
  // A new answer, or one finishing or failing, goes out at once.
  const a = useLive.getState().answer;
  const answerKey = a ? `${a.id}:${a.busy}:${a.error ?? ''}` : '';
  const since = Date.now() - lastPush;
  if (answerKey !== lastAnswerKey || since >= PUSH_EVERY_MS) {
    lastAnswerKey = answerKey;
    pushNow();
    return;
  }
  pushTimer ??= setTimeout(pushNow, PUSH_EVERY_MS - since);
}

function onPhoneMessage(msg: FromPhone) {
  switch (msg?.type) {
    case 'hello':
      pushNow();
      break;
    case 'help':
      void helpMeAnswer();
      break;
    case 'ask':
      void helpMeAnswer(msg.question ?? '');
      break;
    case 'set-model':
      if (msg.task === 'live' || msg.task === 'answer') void setLiveModel(msg.task, msg.model ?? '');
      break;
    case 'set-hidden':
      void setHidden(!!msg.hidden);
      break;
  }
}

// ---------- Hide / show ----------

let registeredHotkey: string | null = null;
let overlayWasVisible = false;
let releaseKeepAlive: (() => void) | null = null;

// Only hide when the shortcut works, or the window could be lost until restart.
function canHide(): boolean {
  return registeredHotkey != null;
}

export async function setHidden(hide: boolean): Promise<void> {
  if (hide === isHidden()) return;
  if (hide && !canHide()) return;
  const win = getCurrentWindow();
  const overlay = await WebviewWindow.getByLabel(OVERLAY_LABEL).catch(() => null);
  try {
    if (hide) {
      setHiddenFlag(true);
      overlayWasVisible = !!overlay && (await overlay.isVisible().catch(() => false));
      if (overlayWasVisible) await overlay?.hide();
      await win.setSkipTaskbar(true);
      await win.hide();
      holdKeepAlive();
    } else {
      await win.show();
      await win.setSkipTaskbar(false);
      await win.unminimize();
      await win.setFocus();
      if (overlayWasVisible) await overlay?.show();
      overlayWasVisible = false;
      releaseKeepAlive?.();
      releaseKeepAlive = null;
      setHiddenFlag(false);
    }
  } catch (err) {
    console.warn('Could not change window visibility', err);
  }
  set({ hidden: isHidden() });
  pushNow();
}

export function toggleHidden(): Promise<void> {
  return setHidden(!isHidden());
}

// WebView2 can't turn background throttling off (backgroundThrottling in
// tauri.conf.json only works on macOS). A pending Web Lock keeps a hidden page
// from being frozen, which is the workaround Tauri suggests.
function holdKeepAlive() {
  if (releaseKeepAlive || !navigator.locks) return;
  void navigator.locks
    .request('meeting-helper-secret-mode', () => new Promise<void>((resolve) => (releaseKeepAlive = resolve)))
    .catch(() => {});
}

async function syncHotkey() {
  const s = getSettings();
  const key = s.remoteEnabled ? s.secretHotkey.trim() : '';
  if (key === registeredHotkey) return;
  if (registeredHotkey) {
    const old = registeredHotkey;
    registeredHotkey = null;
    await unregister(old).catch(() => {});
  }
  set({ hotkeyError: null });
  if (!key) return;
  try {
    await register(key, (e) => {
      if (e.state === 'Pressed') void toggleHidden();
    });
    registeredHotkey = key;
  } catch (err) {
    set({ hotkeyError: `Couldn't register ${key}: ${errorMessage(err)}` });
  }
}

// ---------- Init ----------

let initialized = false;

// Called once from App.tsx in the main window, after settings are loaded.
export function initRemote(): void {
  if (initialized) return;
  initialized = true;

  void listen<FromPhone>('remote://message', (e) => onPhoneMessage(e.payload));
  void listen<number>('remote://clients', (e) => {
    set((s) => ({ status: { ...s.status, clients: e.payload } }));
    pushNow();
  });
  void listen('remote://phone-link-request', () => void enablePhone().then(sendPhoneLink));
  useRemote.subscribe((s, prev) => {
    if (s.status !== prev.status || s.key !== prev.key || s.error !== prev.error) sendPhoneLink();
  });
  useLive.subscribe(schedulePush);

  useSettings.subscribe((s, prev) => {
    const a = s.settings;
    const b = prev.settings;
    if (a.remoteEnabled !== b.remoteEnabled || a.secretHotkey !== b.secretHotkey) void syncHotkey();
    if (a.remoteEnabled !== b.remoteEnabled) void (a.remoteEnabled ? startRemote() : stopRemote());
    else if (a.remotePort !== b.remotePort && get().status.running) void startRemote();
    schedulePush();
  });

  void syncHotkey();
  if (getSettings().remoteEnabled) void startRemote();
}
