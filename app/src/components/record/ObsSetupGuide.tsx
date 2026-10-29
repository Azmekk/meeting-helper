import { openUrl } from '@tauri-apps/plugin-opener';
import { ChevronDown } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Card, IconButton, Steps, clsx } from '../ui';

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}

// How to get OBS talking to Meeting Helper. Expanded while not connected;
// collapsible once connected.
export default function ObsSetupGuide({ connected }: { connected: boolean }) {
  const [open, setOpen] = useState(!connected);
  useEffect(() => setOpen(!connected), [connected]);

  return (
    <Card
      title="Set up OBS"
      description={connected ? 'Done. Here for reference.' : 'One-time setup, about two minutes.'}
      actions={
        <IconButton
          icon={ChevronDown}
          label={open ? 'Collapse' : 'Expand'}
          onClick={() => setOpen((o) => !o)}
          className={clsx('transition-transform', open && 'rotate-180')}
        />
      }
      padded={open}
    >
      {open && (
        <Steps
          steps={[
            <>
              Install <b>OBS Studio 30 or newer</b> from{' '}
              <ExtLink href="https://obsproject.com/download">obsproject.com</ExtLink>. Meeting Helper uses it to
              record your screen and audio.
            </>,
            <>
              Open OBS and go to <b>Tools → WebSocket Server Settings</b>. Tick <b>Enable WebSocket server</b>, keep{' '}
              <b>Server Port</b> at <code>4455</code>, tick <b>Enable Authentication</b>, then click <b>OK</b>.
            </>,
            <>
              In the same window click <b>Show Connect Info</b>, copy the <b>Server Password</b>, paste it into the
              password field above and click <b>Connect</b>.
            </>,
            <>
              That's it. Meeting Helper sets up the audio tracks and recording output automatically (your mic and the
              other participants on separate tracks). <b>Use headphones</b> so your mic only hears you; that keeps
              speaker detection accurate.
            </>,
          ]}
        />
      )}
    </Card>
  );
}
