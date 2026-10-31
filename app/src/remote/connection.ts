// The phone's WebSocket to remote.rs: encrypts, checks counters, reconnects
// when the phone wakes up or the network comes back, and asks for the current
// state (hello) after every connect. Deltas are applied here (protocol.ts); a
// gap in their sequence asks for a full state again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CLOSE_BAD_KEY, CLOSE_REPAIRED, applyToPhone, type FromPhone, type PhoneState, type ToPhone } from './protocol';
import { FROM_PHONE, TO_PHONE, open, seal } from './crypto';

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'badKey' | 'repaired';

const COUNTER_KEY = 'mh-remote-counter';
// No state within this long after a hello means the socket is dead (common
// after the phone slept); reconnect instead of waiting for TCP to notice.
const HELLO_TIMEOUT_MS = 5000;

// Outgoing counters must increase across page reloads too (the server tracks
// the last one per pairing), so they're based on the clock and remembered.
let lastOut = 0n;
function nextCounter(): bigint {
  try {
    const saved = BigInt(localStorage.getItem(COUNTER_KEY) ?? '0');
    if (saved > lastOut) lastOut = saved;
  } catch {
    // Private mode: the clock alone still increases.
  }
  const now = BigInt(Date.now()) * 1000n;
  lastOut = now > lastOut ? now : lastOut + 1n;
  try {
    localStorage.setItem(COUNTER_KEY, lastOut.toString());
  } catch {
    // ignore
  }
  return lastOut;
}

export function useRemoteConnection(key: Uint8Array | null) {
  const [state, setState] = useState<ConnState>('connecting');
  const [phone, setPhone] = useState<PhoneState | null>(null);
  const current = useRef<PhoneState | null>(null);
  const resyncing = useRef(false);
  const ws = useRef<WebSocket | null>(null);
  const lastIn = useRef(0n);
  const stopped = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const helloTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const sayHello = useRef<() => void>(() => {});

  const sendRaw = useCallback(
    (socket: WebSocket, msg: FromPhone) => {
      if (!key || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(seal(key, FROM_PHONE, nextCounter(), new TextEncoder().encode(JSON.stringify(msg))));
      return true;
    },
    [key],
  );

  const connect = useCallback(() => {
    if (!key || stopped.current) return;
    if (retry.current) clearTimeout(retry.current);
    retry.current = null;
    const old = ws.current;
    if (old && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) return;

    const socket = new WebSocket(`ws://${location.host}/ws`);
    socket.binaryType = 'arraybuffer';
    ws.current = socket;

    const hello = () => {
      if (!sendRaw(socket, { type: 'hello' })) return;
      if (helloTimer.current) clearTimeout(helloTimer.current);
      helloTimer.current = setTimeout(() => socket.close(), HELLO_TIMEOUT_MS);
    };

    socket.onopen = () => {
      attempts.current = 0;
      // Until the hello's state arrives, deltas can't be applied.
      current.current = current.current && { ...current.current, seq: Number.NaN };
      resyncing.current = true;
      setState('open');
      hello();
    };
    socket.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return;
      const opened = open(key, TO_PHONE, new Uint8Array(e.data));
      if (!opened) {
        stopped.current = true;
        setState('badKey');
        socket.close();
        return;
      }
      // Replayed or out-of-date frame.
      if (opened.counter <= lastIn.current) return;
      lastIn.current = opened.counter;
      let msg: ToPhone;
      try {
        msg = JSON.parse(new TextDecoder().decode(opened.msg)) as ToPhone;
      } catch {
        return; // malformed
      }
      const next = applyToPhone(current.current, msg);
      if (!next) {
        // Missed a frame: ask for everything once, ignore deltas until it comes.
        if (!resyncing.current) {
          resyncing.current = true;
          hello();
        }
        return;
      }
      if (msg.type === 'state') {
        // The hello was answered; deltas alone don't prove that (the state
        // frame could have been dropped), so they don't stop the timeout.
        if (helloTimer.current) clearTimeout(helloTimer.current);
        helloTimer.current = null;
      }
      resyncing.current = false;
      current.current = next;
      setPhone(next);
    };
    socket.onclose = (e) => {
      if (ws.current !== socket) return;
      ws.current = null;
      if (helloTimer.current) clearTimeout(helloTimer.current);
      if (e.code === CLOSE_REPAIRED || e.code === CLOSE_BAD_KEY) {
        stopped.current = true;
        setState(e.code === CLOSE_REPAIRED ? 'repaired' : 'badKey');
        return;
      }
      if (stopped.current) return;
      setState('reconnecting');
      const delay = Math.min(5000, 500 * 2 ** attempts.current++);
      retry.current = setTimeout(connect, delay);
    };
    sayHello.current = hello;
  }, [key, sendRaw]);

  useEffect(() => {
    if (!key) return;
    stopped.current = false;
    connect();
    // Phones suspend pages with the screen off; check the socket on wake-up.
    const wake = () => {
      if (document.visibilityState !== 'visible' || stopped.current) return;
      if (ws.current?.readyState === WebSocket.OPEN) sayHello.current();
      else {
        attempts.current = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    return () => {
      stopped.current = true;
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      if (retry.current) clearTimeout(retry.current);
      if (helloTimer.current) clearTimeout(helloTimer.current);
      ws.current?.close();
      ws.current = null;
    };
  }, [key, connect]);

  const send = useCallback((msg: FromPhone) => (ws.current ? sendRaw(ws.current, msg) : false), [sendRaw]);

  return { state, phone, send };
}
