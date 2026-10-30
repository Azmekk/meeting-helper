import { Plug, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { connectObs, disconnectObs, useRecorder } from '../../lib/obs';
import { getSecret, setSecret } from '../../lib/secrets';
import { useSettings } from '../../lib/settings';
import { Badge, Button, Callout, Card, Field, Input, errorMessage, toast } from '../ui';
import { KEY_STORE } from '../../lib/platform';

export default function ConnectionCard() {
  const status = useRecorder((s) => s.status);
  const error = useRecorder((s) => s.error);
  const obsVersion = useRecorder((s) => s.obsVersion);
  const recording = useRecorder((s) => s.recording);
  const settings = useSettings((s) => s.settings);
  const updateSettings = useSettings((s) => s.update);

  const [host, setHost] = useState(settings.obsHost);
  const [port, setPort] = useState(String(settings.obsPort));
  const [password, setPassword] = useState('');
  const [savedPassword, setSavedPassword] = useState<string | null>(null);

  useEffect(() => {
    getSecret('obs_password')
      .then((p) => {
        setSavedPassword(p ?? '');
        setPassword(p ?? '');
      })
      .catch(() => setSavedPassword(''));
  }, []);

  const connected = status === 'connected';
  const connecting = status === 'connecting';

  async function connect() {
    const portNum = Number(port) || 4455;
    try {
      const h = host.trim() || '127.0.0.1';
      if (h !== settings.obsHost || portNum !== settings.obsPort) {
        await updateSettings({ obsHost: h, obsPort: portNum });
      }
      if (password !== savedPassword) {
        await setSecret('obs_password', password);
        setSavedPassword(password);
      }
    } catch (err) {
      toast(`Couldn't save the connection settings: ${errorMessage(err)}`, 'error');
    }
    await connectObs({ password });
  }

  const badge = connected ? (
    <Badge tone="ok">Connected</Badge>
  ) : connecting ? (
    <Badge tone="accent">Connecting…</Badge>
  ) : (
    <Badge>Not connected</Badge>
  );

  return (
    <Card
      title="OBS connection"
      description={connected && obsVersion ? `OBS Studio ${obsVersion}` : 'Meeting Helper records through OBS Studio.'}
      actions={badge}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!connected) void connect();
        }}
      >
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Field label="Host">
            <Input value={host} onChange={(e) => setHost(e.target.value)} disabled={connected || connecting} />
          </Field>
          <Field label="Port">
            <Input
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
              disabled={connected || connecting}
            />
          </Field>
        </div>
        <Field label="Server password" hint={`Stored in ${KEY_STORE}.`}>
          <Input
            type="password"
            value={password}
            placeholder="From Tools → WebSocket Server Settings → Show Connect Info"
            onChange={(e) => setPassword(e.target.value)}
            disabled={connected || connecting}
            autoComplete="off"
          />
        </Field>

        {error && !connected && (
          <Callout tone={connecting ? 'info' : 'warn'} title="Can't reach OBS">
            {error}
          </Callout>
        )}
        {error && connected && <Callout tone="warn">{error}</Callout>}

        <div className="flex items-center gap-2">
          {connected ? (
            <Button
              type="button"
              icon={Unplug}
              onClick={() => void disconnectObs()}
              disabled={recording}
              title={recording ? 'Stop the recording first' : undefined}
            >
              Disconnect
            </Button>
          ) : (
            <Button type="submit" variant="primary" icon={Plug} loading={connecting}>
              Connect
            </Button>
          )}
          {!connected && !connecting && (
            <span className="text-xs text-muted">Meeting Helper also reconnects by itself when OBS starts.</span>
          )}
        </div>
      </form>
    </Card>
  );
}
