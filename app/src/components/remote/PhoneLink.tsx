// The phone page's address and QR code, shared by Settings → Secret mode and
// the Record screen. See lib/remote.ts for the server and pairing key.
import { Eye, Smartphone } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'react';
import { enablePhone, refreshRemoteStatus, remoteUrl, useRemote } from '../../lib/remote';
import { useSettings } from '../../lib/settings';
import { Button, Callout, Select, clsx } from '../ui';

// The URL a phone should open, or null while the server isn't running.
export function usePhoneUrl(address: string) {
  const { status, key } = useRemote();
  const ip = status.addresses.includes(address) ? address : (status.addresses[0] ?? '');
  const url = status.running && status.port && key && ip ? remoteUrl(ip, status.port, key) : null;
  return { ip, url };
}

export function PhoneLink({ autoReveal = false }: { autoReveal?: boolean }) {
  const enabled = useSettings((s) => s.settings.remoteEnabled);
  const { status, key, starting, error } = useRemote();
  const [address, setAddress] = useState('');
  const [showQr, setShowQr] = useState(autoReveal);
  const { ip, url } = usePhoneUrl(address);

  useEffect(() => {
    void refreshRemoteStatus();
  }, []);

  if (!enabled || (!status.running && !starting)) {
    return (
      <div className="space-y-3 text-[13px]">
        <p className="text-muted">
          Follow the transcript, notes and “help me answer” on your phone. Your phone has to be on the same Wi-Fi as this
          PC.
        </p>
        <Button icon={Smartphone} variant="primary" loading={starting} onClick={() => void enablePhone()}>
          Turn on phone access
        </Button>
        <p className="text-xs text-muted">This also turns on secret mode and its hide shortcut (Settings → Secret mode).</p>
        {error && <Callout tone="error">{error}</Callout>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px]">
        {status.clients
          ? `${status.clients} phone${status.clients === 1 ? '' : 's'} connected.`
          : 'Scan with your phone’s camera. Your phone has to be on the same Wi-Fi as this PC.'}
      </p>
      {error && <Callout tone="error">{error}</Callout>}
      {status.running && !status.addresses.length && (
        <Callout tone="warn">
          No local network address found. Connect this PC to Wi-Fi or Ethernet (or your phone’s hotspot).
        </Callout>
      )}
      {url && (
        <div className="flex flex-wrap items-start gap-5">
          {showQr ? (
            <QrCode text={url} />
          ) : (
            // The QR code holds the key; keep it off screen shares unless asked.
            <button
              type="button"
              onClick={() => setShowQr(true)}
              className="flex h-44 w-44 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line text-[13px] text-muted hover:bg-hover"
            >
              <Eye size={18} />
              Show QR code
            </button>
          )}
          <div className="min-w-0 flex-1 space-y-2 text-[13px]">
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
            <p className="text-xs text-muted">
              If the phone can’t connect, the Wi-Fi may keep devices apart (common on guest and office networks). Use your
              phone’s hotspot instead.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// Dark modules on white, regardless of theme, so phone cameras read it reliably.
export function QrCode({ text, className }: { text: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { size: n, path: d };
  }, [text]);
  const margin = 2;
  return (
    <svg
      viewBox={`${-margin} ${-margin} ${size + margin * 2} ${size + margin * 2}`}
      className={clsx('rounded-lg bg-white', className ?? 'h-44 w-44')}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Pairing QR code"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
