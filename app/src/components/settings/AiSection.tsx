// Settings → AI: provider, API key, custom endpoint, per-task models and the
// output language.
import { Eye, EyeOff, FlaskConical, KeyRound, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AI_PROVIDER_IDS, getAiProvider, sortModels, type AiProvider, type AiProviderId } from '../../lib/ai';
import { estimateCost } from '../../lib/ai/pricing';
import { languageName } from '../../lib/ai/prompts';
import { OUTPUT_LANGUAGES } from '../ai/AiLanguageSelect';
import { KEY_STORE } from '../../lib/platform';
import { deleteSecret, getSecret, setSecret } from '../../lib/secrets';
import { useSettings, type Settings } from '../../lib/settings';
import { Badge, Button, Callout, Card, Field, IconButton, Input, Select, Spinner, Switch, errorMessage, toast } from '../ui';
import { CommitInput, ExtLink, saveSettings } from './common';

const INFO: Record<AiProviderId, { tagline: string; keyUrl?: string; privacy: string }> = {
  anthropic: {
    tagline: 'Claude models. Best quality for summaries and answers.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    privacy: 'Anthropic does not train on API data by default and keeps it for a limited time.',
  },
  openai: {
    tagline: 'GPT models.',
    keyUrl: 'https://platform.openai.com/api-keys',
    privacy: 'OpenAI does not train on API data by default and keeps it for a limited time.',
  },
  deepseek: {
    tagline: 'Low-cost models.',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    privacy:
      'DeepSeek processes and stores data on servers in China. Check that this is acceptable for your meetings and the people in them.',
  },
  custom: {
    tagline: 'Any OpenAI-compatible endpoint: OpenRouter, Ollama, LM Studio, a company gateway…',
    privacy: 'Transcripts go to the endpoint you enter. A local server (Ollama, LM Studio) keeps everything on this computer.',
  },
};


type TestState = { kind: 'idle' } | { kind: 'running' } | { kind: 'ok' } | { kind: 'error'; message: string };
type ModelsState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; ids: string[] } | { kind: 'error'; message: string };

export function AiSection() {
  const providerId = useSettings((s) => s.settings.aiProvider);
  const baseUrl = useSettings((s) => s.settings.aiCustomBaseUrl);
  const outputLanguage = useSettings((s) => s.settings.aiOutputLanguage);
  const provider = getAiProvider(providerId);
  const info = INFO[provider.id];

  // The saved key, lifted here so the model list can reload when it changes.
  const [key, setKey] = useState<string | null>(null);
  const [keyLoading, setKeyLoading] = useState(true);
  const [models, setModels] = useState<ModelsState>({ kind: 'idle' });

  useEffect(() => {
    let alive = true;
    setKeyLoading(true);
    getSecret(provider.secret)
      .then((v) => alive && setKey(v))
      .catch((err) => alive && toast(`Couldn't read the ${provider.name} key: ${errorMessage(err)}`, 'error'))
      .finally(() => alive && setKeyLoading(false));
    return () => {
      alive = false;
    };
  }, [provider]);

  const canList = !keyLoading && (!!key || !!provider.keyOptional) && (provider.id !== 'custom' || !!baseUrl.trim());

  const loadModels = useCallback(async () => {
    if (!canList) {
      setModels({ kind: 'idle' });
      return;
    }
    setModels({ kind: 'loading' });
    try {
      const ids = await provider.listModels({ apiKey: key ?? '', baseUrl });
      setModels({ kind: 'ok', ids });
    } catch (err) {
      setModels({ kind: 'error', message: errorMessage(err) });
    }
  }, [canList, provider, key, baseUrl]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // Model ids differ per provider, so the per-task choices start over.
  const selectProvider = (id: AiProviderId) =>
    saveSettings({ aiProvider: id, aiLiveModel: '', aiAnswerModel: '', aiSummaryModel: '' });

  return (
    <>
      <Card title="AI assistant" description="Summaries, chat, live notes and “help me answer” use your own API key.">
        <div className="space-y-5">
          <Field label="Provider" hint={info.tagline}>
            <Select value={provider.id} onChange={(e) => selectProvider(e.target.value as AiProviderId)}>
              {AI_PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {getAiProvider(id).name}
                </option>
              ))}
            </Select>
          </Field>

          {provider.id === 'custom' && (
            <Field
              label="Base URL"
              hint="The OpenAI-compatible API root, e.g. https://openrouter.ai/api/v1 or http://localhost:11434/v1 for Ollama."
            >
              <CommitInput
                value={baseUrl}
                onCommit={(v) => saveSettings({ aiCustomBaseUrl: v.trim() })}
                placeholder="https://openrouter.ai/api/v1"
                spellCheck={false}
                className="font-mono text-[13px]"
              />
            </Field>
          )}

          <KeyField
            key={provider.id}
            provider={provider}
            baseUrl={baseUrl}
            saved={key}
            loading={keyLoading}
            onSaved={setKey}
          />

          {info.keyUrl && (
            <p className="text-xs text-muted">
              Get a key at <ExtLink href={info.keyUrl}>{new URL(info.keyUrl).host}</ExtLink>.
            </p>
          )}

          <Callout tone={provider.id === 'deepseek' ? 'warn' : 'info'} title="Privacy">
            Every AI feature sends the meeting transcript (and your briefing notes) to {provider.name}. {info.privacy}
          </Callout>
        </div>
      </Card>

      <Card
        title="Models"
        description="Leave on “Recommended” unless you have a reason to change it. You can also switch models during a meeting."
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={RefreshCw}
            onClick={() => void loadModels()}
            disabled={!canList || models.kind === 'loading'}
          >
            Refresh
          </Button>
        }
      >
        <ModelPickers provider={provider} models={models} canList={canList} />
      </Card>

      <Card
        title="Output language"
        description="The default language of summaries, notes and answers. You can also switch it next to each AI action."
      >
        <Select value={outputLanguage} onChange={(e) => saveSettings({ aiOutputLanguage: e.target.value })}>
          <option value="meeting">Same as the meeting</option>
          {OUTPUT_LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {languageName(code)}
            </option>
          ))}
        </Select>
      </Card>
    </>
  );
}

function KeyField({
  provider,
  baseUrl,
  saved,
  loading,
  onSaved,
}: {
  provider: AiProvider;
  baseUrl: string;
  saved: string | null;
  loading: boolean;
  onSaved: (key: string | null) => void;
}) {
  const [draft, setDraft] = useState(saved ?? '');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  useEffect(() => setDraft(saved ?? ''), [saved]);

  const trimmed = draft.trim();
  const dirty = trimmed !== (saved ?? '');
  const name = provider.name;

  async function save() {
    if (!trimmed) return;
    setBusy('save');
    try {
      await setSecret(provider.secret, trimmed);
      onSaved(trimmed);
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
      await deleteSecret(provider.secret);
      onSaved(null);
      setTest({ kind: 'idle' });
      toast(`${name} key removed`, 'info');
    } catch (err) {
      toast(`Couldn't remove the key: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setTest({ kind: 'running' });
    try {
      await provider.testKey({ apiKey: trimmed || saved || '', baseUrl });
      setTest({ kind: 'ok' });
    } catch (err) {
      setTest({ kind: 'error', message: errorMessage(err) });
    }
  }

  const canTest = !!(trimmed || saved) || !!provider.keyOptional;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`ai-key-${provider.id}`} className="flex items-center gap-2 text-[13px] font-medium">
          API key
          {loading ? (
            <Spinner size={12} />
          ) : saved ? (
            <Badge tone="ok">Key saved</Badge>
          ) : provider.keyOptional ? (
            <Badge>Optional</Badge>
          ) : (
            <Badge>No key</Badge>
          )}
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <KeyRound size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
            <Input
              id={`ai-key-${provider.id}`}
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
        <span className="text-xs text-muted">Stored in {KEY_STORE}, never in the settings file.</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon={FlaskConical}
          onClick={runTest}
          loading={test.kind === 'running'}
          disabled={!canTest || busy !== null}
        >
          Test key
        </Button>
        {saved && (
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
        {dirty && saved && trimmed && <span className="text-xs text-warn">Unsaved change</span>}
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
    </div>
  );
}

const TASKS: { key: keyof Pick<Settings, 'aiLiveModel' | 'aiAnswerModel' | 'aiSummaryModel'>; label: string; hint: string }[] = [
  { key: 'aiLiveModel', label: 'Live notes', hint: 'Runs about once a minute during a meeting. A fast model keeps cost down.' },
  { key: 'aiAnswerModel', label: 'Help me answer', hint: 'Reads the whole meeting so far when you ask for help.' },
  { key: 'aiSummaryModel', label: 'Summaries and chat', hint: 'Meeting summaries, chat and folder work after the meeting.' },
];

// Rough cost of a typical hour-long meeting summary, to make model prices comparable.
function priceHint(model: string): string {
  const usd = estimateCost(model, { inputTokens: 15_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1_500 });
  return usd == null ? '' : ` · ~$${usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)} per summary`;
}

function ModelPickers({ provider, models, canList }: { provider: AiProvider; models: ModelsState; canList: boolean }) {
  const settings = useSettings((s) => s.settings);
  const [showAll, setShowAll] = useState(false);
  const { default: recommended, budget } = provider.recommendedModels;

  if (!canList) {
    return (
      <p className="text-[13px] text-muted">
        {provider.id === 'custom' && !settings.aiCustomBaseUrl.trim()
          ? 'Enter the base URL above to load the available models.'
          : `Save your ${provider.name} key above to load the available models.`}
      </p>
    );
  }
  if (models.kind === 'loading' || models.kind === 'idle') {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <Spinner size={14} /> Loading models…
      </div>
    );
  }

  // Without a list (endpoint doesn't support /models), fall back to typing an id.
  const listed = models.kind === 'ok' ? models.ids : [];
  const { recommended: top, rest } = sortModels(provider, listed);
  const noList = models.kind === 'error' || listed.length === 0;

  return (
    <div className="space-y-5">
      {models.kind === 'error' && (
        <Callout tone="warn" title="Couldn't load the model list">
          {models.message} You can still type a model id.
        </Callout>
      )}

      {TASKS.map((t) => {
        const value = settings[t.key];
        const effective = value || recommended;
        return (
          <Field
            key={t.key}
            label={t.label}
            hint={
              <>
                {t.hint}
                {effective && priceHint(effective)}
              </>
            }
          >
            {noList ? (
              <CommitInput
                value={value}
                onCommit={(v) => saveSettings({ [t.key]: v.trim() })}
                placeholder={recommended || 'model id'}
                spellCheck={false}
                className="font-mono text-[13px]"
              />
            ) : (
              <Select value={value} onChange={(e) => saveSettings({ [t.key]: e.target.value })}>
                <option value="">{recommended ? `Recommended (${recommended})` : 'Choose a model…'}</option>
                {value && !top.includes(value) && !(showAll && rest.includes(value)) && <option value={value}>{value}</option>}
                {top.length > 0 && (
                  <optgroup label="Recommended">
                    {top.map((m) => (
                      <option key={m} value={m}>
                        {m}
                        {m === recommended ? ' (default)' : m === budget ? ' (budget)' : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {showAll && rest.length > 0 && (
                  <optgroup label="All models">
                    {rest.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            )}
          </Field>
        );
      })}

      {!noList && rest.length > 0 && (
        <div className="flex items-center justify-between gap-6">
          <div>
            <div className="text-sm font-medium">Show all models</div>
            <div className="text-xs text-muted">{rest.length} more available from {provider.name}.</div>
          </div>
          <Switch label="Show all models" checked={showAll} onChange={setShowAll} />
        </div>
      )}

      {provider.id === 'anthropic' && (
        <p className="text-xs text-muted">
          The budget model is fine for quick notes but has added details that weren't said in testing; prefer the
          default for summaries and answers.
        </p>
      )}
    </div>
  );
}
