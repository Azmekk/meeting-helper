// The obs-websocket v5 connection: connecting, retrying with backoff while OBS
// is closed, and raw profile parameter access. One module-level socket, so the
// connection survives moving between screens.
import OBSWebSocket from 'obs-websocket-js';
import { errorMessage } from '../errors';
import { getSecret } from '../secrets';
import { getSettings } from '../settings';
import { useRecorder } from './store';

const set = useRecorder.setState;
const get = useRecorder.getState;

export const obs = new OBSWebSocket();
let manualDisconnect = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 3000;

// What the rest of the recorder does on connection events (see initRecorder).
export interface ConnectionHandlers {
  // Connected: read OBS's state. A failure is logged and the connection kept.
  onConnected: () => Promise<void>;
  // Nothing is listening: OBS is closed (so it can't be recording).
  onNotRunning: () => void;
}
let handlers: ConnectionHandlers | null = null;

class ObsConnectError extends Error {
  constructor(
    message: string,
    public retry: boolean,
    // Nothing is listening: OBS is closed (so it can't be recording).
    public notRunning = false,
  ) {
    super(message);
  }
}

function describeConnectError(err: unknown, hadPassword: boolean): ObsConnectError {
  const code = typeof err === 'object' && err && 'code' in err ? Number((err as { code: unknown }).code) : NaN;
  if (code === 4009) {
    return new ObsConnectError(
      hadPassword
        ? 'Wrong password. Copy the Server Password again from OBS → Tools → WebSocket Server Settings → Show Connect Info.'
        : 'OBS asks for a password. Paste the Server Password from OBS → Tools → WebSocket Server Settings → Show Connect Info.',
      false,
    );
  }
  if (code === 4010) {
    return new ObsConnectError('This OBS version is too old for Meeting Helper. Install OBS 30 or newer.', false);
  }
  if (code === 4008) {
    return new ObsConnectError('OBS is shutting down.', true);
  }
  const msg = errorMessage(err);
  if (msg === 'timeout') {
    return new ObsConnectError("OBS didn't answer. Check the host and port.", true);
  }
  return new ObsConnectError(
    "OBS isn't running, or its WebSocket server is off (OBS → Tools → WebSocket Server Settings).",
    true,
    true,
  );
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry() {
  clearRetry();
  if (manualDisconnect) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connectObs({ quiet: true });
  }, retryDelay);
  retryDelay = Math.min(Math.round(retryDelay * 1.6), 30000);
}

// Connects using host/port from settings and the stored password, unless a
// password is passed in. Resolves true on success; never throws.
// `quiet`: background attempt; doesn't flip the status badge to "connecting".
let inFlight: Promise<boolean> | null = null;

export async function connectObs(opts: { password?: string; quiet?: boolean } = {}): Promise<boolean> {
  if (inFlight) {
    const ok = await inFlight;
    if (ok || opts.quiet) return ok;
  }
  if (get().connected) return true;
  inFlight = doConnect(opts);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function doConnect(opts: { password?: string; quiet?: boolean }): Promise<boolean> {
  clearRetry();
  manualDisconnect = false;
  if (!opts.quiet) set({ status: 'connecting', error: null });

  const { obsHost, obsPort } = getSettings();
  let password = opts.password;
  if (password === undefined) {
    try {
      password = (await getSecret('obs_password')) ?? '';
    } catch {
      password = '';
    }
  }

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      obs.connect(`ws://${obsHost || '127.0.0.1'}:${obsPort || 4455}`, password || undefined),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 8000);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (err) {
    const e = describeConnectError(err, !!password);
    try {
      await obs.disconnect();
    } catch {
      /* ignore */
    }
    set({ status: 'disconnected', connected: false, error: e.message });
    if (e.notRunning) handlers?.onNotRunning();
    if (e.retry) scheduleRetry();
    return false;
  }

  retryDelay = 3000;
  set({ status: 'connected', connected: true, error: null });
  try {
    await handlers?.onConnected();
  } catch (err) {
    // Connected, but reading state failed; keep the connection.
    console.warn('OBS: reading state failed', err);
  }
  return true;
}

export async function disconnectObs(): Promise<void> {
  manualDisconnect = true;
  clearRetry();
  try {
    await obs.disconnect();
  } catch {
    /* ignore */
  }
  set({ status: 'disconnected', connected: false, error: null });
}

// Registers the connection handlers and reacts to OBS closing the connection.
export function watchConnection(h: ConnectionHandlers): void {
  handlers = h;
  obs.on('ConnectionClosed', () => {
    const wasConnected = get().connected;
    set({ connected: false, status: 'disconnected', busy: null });
    if (!wasConnected) return;
    if (!manualDisconnect) {
      // OBS closed (or restarted): pending output changes are applied on its next start.
      set({ restartNeeded: false });
      if (get().recording) {
        // If OBS is still recording, reconnecting restores the state from GetRecordStatus.
        set({
          recording: false,
          startedAt: null,
          paused: false,
          pausedAt: null,
          error:
            'Lost the connection to OBS during a recording. If OBS closed, import the file from its recording folder on the Meetings screen.',
        });
      }
      retryDelay = 3000;
      scheduleRetry();
    }
  });
}

export function requireConnected() {
  if (!get().connected) throw new Error("Not connected to OBS.");
}

// ---------- Profile parameters ----------

export async function getParam(section: string, name: string): Promise<string | null> {
  const r = await obs.call('GetProfileParameter', { parameterCategory: section, parameterName: name });
  return r.parameterValue ?? r.defaultParameterValue ?? null;
}

export async function setParam(section: string, name: string, value: string): Promise<void> {
  await obs.call('SetProfileParameter', { parameterCategory: section, parameterName: name, parameterValue: value });
}
