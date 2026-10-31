// Settings → Secret mode: the phone remote (QR pairing, server) and the
// shortcut that hides the main window. See lib/remote.ts.
import { Eye, KeyRound, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { enablePhone, rePair, refreshRemoteStatus, remoteUrl, useRemote } from '../../lib/remote';
import { useSettings } from '../../lib/settings';
import { hotkeyLabel } from '../live/shared';
import { QrCode } from '../remote/PhoneLink';
import { Button, Callout, Card, Select, SettingRow, Switch, errorMessage, toast } from '../ui';
import { CommitInput, saveSettings } from './common';

const DEFAULT_HOTKEY = 'CommandOrControl+Alt+M';

export function SecretSection() {
  const s = useSettings((st) => st.settings);
  const { status, key, starting, error, hotkeyError } = useRemote();
  const [address, setAddress] = useState('');
  const [showQr, setShowQr] = useState(false);
  const [repairing, setRepairing] = useState(false);

  useEffect(() => {
    void refreshRemoteStatus();
  }, []);

  const ip = status.addresses.includes(address) ? address : (status.addresses[0] ?? '');
  const url = status.running && status.port && key && ip ? remoteUrl(ip, status.port, key) : null;

  const repair = async () => {
    setRepairing(true);
    try {
      await rePair();
      toast('New pairing key made. Scan the new QR code on your phone.', 'success');
    } catch (err) {
      toast(`Couldn't make a new key: ${errorMessage(err)}`, 'error');
    } finally {
      setRepairing(false);
    }
  };

  return (
    <>
      <Card
        title="Secret mode"
        description="Use live transcription, notes and “help me answer” from your phone while nothing shows on this PC, so you can share your whole screen."
      >
        <div className="space-y-5">
          <div className="divide-y divide-line border-b border-line">
            <SettingRow
              title="Phone remote and hide shortcut"
              description="Runs a small server on your local network for the phone page, and turns on the hide shortcut."
            >
              <Switch label="Secret mode" checked={s.remoteEnabled} onChange={(v) => void saveSettings({ remoteEnabled: v })} />
            </SettingRow>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="remote-port" className="text-[13px] font-medium">
                Port
              </label>
              <CommitInput
                id="remote-port"
                className="font-mono text-[13px]"
                placeholder="4810"
                value={String(s.remotePort)}
                onCommit={(v) => {
                  const port = Number(v.trim());
                  if (Number.isInteger(port) && port >= 1024 && port <= 65535) void saveSettings({ remotePort: port });
                  else toast('The port must be a number between 1024 and 65535.', 'error');
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="secret-hotkey" className="text-[13px] font-medium">
                Hide / show shortcut
              </label>
              <CommitInput
                id="secret-hotkey"
                className="font-mono text-[13px]"
                placeholder={DEFAULT_HOTKEY}
                spellCheck={false}
                value={s.secretHotkey}
                onCommit={(v) => void saveSettings({ secretHotkey: v.trim() })}
              />
            </div>
          </div>
          <p className="-mt-3 text-xs text-muted">
            {s.secretHotkey ? hotkeyLabel(s.secretHotkey) : 'No shortcut'} hides this window completely (no taskbar entry,
            no pop-ups, the overlay too) and brings it back. Live transcription keeps running. The window can only be hidden
            while the shortcut works.
          </p>
          {hotkeyError && <Callout tone="error">{hotkeyError}</Callout>}

          <div className="rounded-2xl border border-line p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Smartphone size={16} className="text-muted" />
              <span className="flex-1 text-sm font-medium">
                {status.running
                  ? `Server running on port ${status.port} · ${status.clients} phone${status.clients === 1 ? '' : 's'} connected`
                  : 'Server not running'}
              </span>
              <Button size="sm" icon={Smartphone} loading={starting} onClick={() => void enablePhone()}>
                Test with phone
              </Button>
              <Button size="sm" icon={KeyRound} loading={repairing} onClick={() => void repair()}>
                Re-pair (new key)
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted">
              “Test with phone” turns secret mode on and starts the server now, so Windows Firewall asks for access before your meeting. Allow it
              on private networks.
            </p>
            {error && (
              <Callout tone="error" className="mt-3">
                {error}
              </Callout>
            )}

            {status.running && !status.addresses.length && (
              <Callout tone="warn" className="mt-3">
                No local network address found. Connect this PC to Wi-Fi or Ethernet (or your phone’s hotspot).
              </Callout>
            )}

            {url && (
              <div className="mt-4 flex flex-wrap items-start gap-5">
                {showQr ? (
                  <QrCode text={url} />
                ) : (
                  // The QR code holds the key; keep it off screen shares unless asked.
                  <button
                    type="button"
                    onClick={() => setShowQr(true)}
                    className="flex h-44 w-44 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line text-[13px] text-muted hover:bg-hover"
                  >
                    <Eye size={18} />
                    Show QR code
                  </button>
                )}
                <div className="min-w-0 flex-1 space-y-2 text-[13px]">
                  <p>Scan with your phone’s camera, or open the address on the phone and add the key from this PC.</p>
                  {status.addresses.length > 1 && (
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted">Network address (pick the one your phone is on)</span>
                      <Select value={ip} onChange={(e) => setAddress(e.target.value)} className="max-w-56 font-mono text-[13px]">
                        {status.addresses.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </Select>
                    </label>
                  )}
                  <p className="font-mono text-xs break-all text-muted">
                    http://{ip}:{status.port}/{showQr ? `#k=${key}` : '#k=…'}
                  </p>
                  <p className="text-xs text-muted">Re-pair makes a new key and disconnects phones that used the old one.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>

      <Card title="Tips">
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-muted">
          <li>
            If the phone can’t connect, the Wi-Fi may isolate devices from each other (common on guest and office
            networks). Turn on your phone’s hotspot and connect this PC to it.
          </li>
          <li>Raise the phone’s screen timeout during the meeting; the page reconnects by itself when it wakes up.</li>
          <li>Minimize OBS to its tray icon so it doesn’t show on the taskbar either.</li>
          <li>
            Messages between the phone and this PC are encrypted with the key in the QR code, which never goes over the
            network. That protects against eavesdropping on the network, but not against someone on it who can swap the
            page itself before it loads. Use a network you trust, or your phone’s hotspot.
          </li>
          <li>
            Privacy (GDPR): people agreeing to be recorded doesn’t automatically mean they agree to live AI processing of
            the call. Make sure your consent covers it.
          </li>
        </ul>
      </Card>
    </>
  );
}
