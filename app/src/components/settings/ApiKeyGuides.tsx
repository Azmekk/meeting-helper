// "How to get your API key" guides, one per provider. Researched against the
// providers' docs in October 2026; labels we couldn't verify are phrased
// generally on purpose.
import type { ReactNode } from 'react';
import type { ProviderId } from '../../lib/types';
import { Steps } from '../ui';
import { ExtLink } from './common';

interface Guide {
  steps: ReactNode[];
  notes: { title: string; body: ReactNode }[];
}

const GUIDES: Record<ProviderId, Guide> = {
  soniox: {
    steps: [
      <>
        Create an account at <ExtLink href="https://console.soniox.com/signup">console.soniox.com/signup</ExtLink>{' '}
        (or sign in at <ExtLink href="https://console.soniox.com">console.soniox.com</ExtLink> if you already have one).
      </>,
      <>
        Open your project. New accounts start with one called <b>My First Project</b>. API keys belong to a project.
      </>,
      <>
        Go to <b>API Keys</b> and generate a new key. Copy it straight away.
      </>,
      <>
        Make sure the account can pay for usage. Soniox stopped giving free credit to new sign-ups in late 2025, so add
        a payment method or credits in the Console's billing section. If <b>Test key</b> fails with a billing or
        balance error, this is why.
      </>,
      <>
        Paste the key above, then click <b>Save</b> and <b>Test key</b>.
      </>,
    ],
    notes: [
      {
        title: 'What it costs',
        body: (
          <>
            File transcription costs about <b>$0.10 per hour</b> of audio, pay as you go. A one-hour meeting costs about
            10 cents. See <ExtLink href="https://soniox.com/pricing">soniox.com/pricing</ExtLink>.
          </>
        ),
      },
      {
        title: 'Privacy',
        body: (
          <>
            Soniox says it doesn't use your audio or transcripts to train its models. Files sent through the async API
            are deleted automatically after 30 days, and you can delete them sooner in the Console. See{' '}
            <ExtLink href="https://soniox.com/docs/security-and-privacy">Security and privacy</ExtLink>.
          </>
        ),
      },
    ],
  },

  elevenlabs: {
    steps: [
      <>
        Sign in or create an account at <ExtLink href="https://elevenlabs.io/app">elevenlabs.io</ExtLink>.
      </>,
      <>
        Click <b>Developers</b> in the left sidebar, then open the <b>API Keys</b> tab. You can also go straight to{' '}
        <ExtLink href="https://elevenlabs.io/app/api/api-keys">the API keys page</ExtLink>.
      </>,
      <>
        Create a new key and give it a name like <code>Meeting Helper</code>. New keys are restricted by default: turn
        on access to <b>Speech to Text</b> only. Everything else can stay off. You can also set a credit limit for the
        key.
      </>,
      <>
        Copy the key right away. ElevenLabs only shows the full key once; after that you see just its name and last
        four characters.
      </>,
      <>
        Paste the key above, then click <b>Save</b> and <b>Test key</b>.
      </>,
    ],
    notes: [
      {
        title: 'What it costs',
        body: (
          <>
            Scribe v2 file transcription costs about <b>$0.22 per hour</b>. Custom vocabulary (key terms) adds about
            $0.05 per hour. The free plan includes a few hours of speech to text each month (about 4.5 hours when this
            was written). See <ExtLink href="https://elevenlabs.io/pricing/api">elevenlabs.io/pricing/api</ExtLink>.
          </>
        ),
      },
      {
        title: 'Privacy',
        body: (
          <>
            By default ElevenLabs keeps a history of your requests. Zero Retention Mode, which turns that off, is only
            for select enterprise customers. See{' '}
            <ExtLink href="https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode">
              Zero Retention Mode
            </ExtLink>
            .
          </>
        ),
      },
    ],
  },
};

export function ApiKeyGuide({ provider }: { provider: ProviderId }) {
  const guide = GUIDES[provider];
  return (
    <div className="space-y-4">
      <Steps steps={guide.steps} />
      <div className="grid gap-3 sm:grid-cols-2">
        {guide.notes.map((n) => (
          <div key={n.title} className="rounded-lg bg-sunken/70 px-3.5 py-3 text-[12.5px] leading-relaxed">
            <div className="mb-0.5 font-medium text-text">{n.title}</div>
            <div className="text-muted [&_a]:text-accent [&_a]:underline [&_b]:font-medium [&_b]:text-text">
              {n.body}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
