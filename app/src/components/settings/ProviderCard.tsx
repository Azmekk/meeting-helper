import { ChevronDown, Eye, EyeOff, FlaskConical, KeyRound, Save, Star, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getProvider } from '../../lib/providers';
import type { SttProvider } from '../../lib/providers/types';
import { deleteSecret, getSecret, setSecret, type SecretName } from '../../lib/secrets';
import { useSettings } from '../../lib/settings';
import type { ProviderId } from '../../lib/types';
import { Badge, Button, Callout, Card, IconButton, Input, Spinner, clsx, errorMessage, toast } from '../ui';
import { ApiKeyGuide } from './ApiKeyGuides';
import { saveSettings } from './common';

// Fallbacks in case the provider module isn't wired up yet.
const META: Record<ProviderId, { name: string; secret: SecretName; tagline: string }> = {
  soniox: {
    name: 'Soniox',
    secret: 'soniox_api_key',
    tagline: 'Uses every language hint and handles meetings that switch between Bulgarian and English.',
  },
  elevenlabs: {
    name: 'ElevenLabs',
    secret: 'elevenlabs_api_key',
    tagline: 'Scribe v2. Uses only the main language hint.',
  },
};

type TestState = { kind: 'idle' } | { kind: 'running' } | { kind: 'ok' } | { kind: 'error'; message: string };

export function ProviderCard({ id }: { id: ProviderId }) {
  const provider = getProvider(id) as SttProvider | undefined;
  const meta = META[id];
  const name = provider?.name ?? meta.name;
  const secretName = provider?.secret ?? meta.secret;

  const isDefault = useSettings((s) => s.settings.defaultProvider === id);

  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    getSecret(secretName)
      .then((v) => {
        if (!alive) return;
        setSaved(v);
        setDraft(v ?? '');
        setGuideOpen(!v);
      })
      .catch((err) => {
        if (alive) toast(`Couldn't read the ${name} key: ${errorMessage(err)}`, 'error');
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [secretName, name]);

  const trimmed = draft.trim();
  const dirty = trimmed !== (saved ?? '');
  const hasKey = !!saved;

  async function save() {
    if (!trimmed) return;
    setBusy('save');
    try {
      await setSecret(secretName, trimmed);
      setSaved(trimmed);
      setDraft(trimmed);
      setReveal(false);
      setTest({ kind: 'idle' });
      toast(`${name} key saved`, 'success');
    } catch (err) {
      toast(`Couldn't save the key: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    try {
      await deleteSecret(secretName);
      setSaved(null);
      setDraft('');
      setTest({ kind: 'idle' });
      setGuideOpen(true);
      toast(`${name} key removed`, 'info');
    } catch (err) {
      toast(`Couldn't remove the key: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    const key = trimmed || saved;
    if (!key) return;
    if (!provider) {
      setTest({ kind: 'error', message: 'This provider is not available in this build yet.' });
      return;
    }
    setTest({ kind: 'running' });
    try {
      await provider.testKey(key);
      setTest({ kind: 'ok' });
    } catch (err) {
      setTest({ kind: 'error', message: errorMessage(err) });
    }
  }

  const price = provider?.usdPerHour;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {name}
          {loading ? (
            <Spinner size={13} />
          ) : hasKey ? (
            <Badge tone="ok">Key saved</Badge>
          ) : (
            <Badge>No key</Badge>
          )}
          {isDefault && (
            <Badge tone="accent">
              <Star size={11} className="fill-current" /> Default
            </Badge>
          )}
        </span>
      }
      description={
        <>
          {meta.tagline}
          {price != null && (
            <span className="mt-0.5 block text-faint">
              About ${price.toFixed(2)} per hour of audio{provider?.model ? ` · model ${provider.model}` : ''}
            </span>
          )}
        </>
      }
      actions={
        !isDefault && (
          <Button size="sm" variant="ghost" icon={Star} onClick={() => saveSettings({ defaultProvider: id })}>
            Use by default
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`key-${id}`} className="text-[13px] font-medium">
            API key
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <KeyRound size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
              <Input
                id={`key-${id}`}
                type={reveal ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                placeholder={loading ? 'Loading…' : `Paste your ${name} API key`}
                disabled={loading}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (test.kind !== 'running') setTest({ kind: 'idle' });
                }}
                onKeyDown={(e) => e.key === 'Enter' && dirty && trimmed && save()}
                className="pr-9 pl-8 font-mono text-[13px]"
              />
              <IconButton
                icon={reveal ? EyeOff : Eye}
                label={reveal ? 'Hide key' : 'Show key'}
                size="sm"
                onClick={() => setReveal((r) => !r)}
                className="absolute top-1/2 right-1.5 -translate-y-1/2"
              />
            </div>
            <Button
              variant="primary"
              icon={Save}
              onClick={save}
              loading={busy === 'save'}
              disabled={!dirty || !trimmed || busy !== null}
            >
              Save
            </Button>
          </div>
          <span className="text-xs text-muted">Stored in Windows Credential Manager, never in the settings file.</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            icon={FlaskConical}
            onClick={runTest}
            loading={test.kind === 'running'}
            disabled={!(trimmed || saved) || busy !== null}
          >
            Test key
          </Button>
          {hasKey && (
            <Button
              size="sm"
              variant="danger"
              icon={Trash2}
              onClick={remove}
              loading={busy === 'remove'}
              disabled={busy !== null}
            >
              Remove
            </Button>
          )}
          {dirty && hasKey && trimmed && <span className="text-xs text-warn">Unsaved change</span>}
        </div>

        {test.kind === 'ok' && (
          <Callout tone="success" title="The key works">
            {name} accepted it{dirty ? '. Remember to save it.' : '.'}
          </Callout>
        )}
        {test.kind === 'error' && (
          <Callout tone="error" title="The key didn't work">
            {test.message}
          </Callout>
        )}

        <div className="rounded-lg border border-line">
          <button
            type="button"
            onClick={() => setGuideOpen((o) => !o)}
            aria-expanded={guideOpen}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-4 py-2.5 text-left text-[13px] font-medium transition-colors hover:bg-hover"
          >
            How to get your {name} API key
            <ChevronDown size={15} className={clsx('text-muted transition-transform', guideOpen && 'rotate-180')} />
          </button>
          {guideOpen && (
            <div className="border-t border-line px-4 py-4">
              <ApiKeyGuide provider={id} />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
