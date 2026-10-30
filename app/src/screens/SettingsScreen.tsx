import { Languages, Mic, Star, Wrench, type LucideIcon } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader, clsx } from '../components/ui';
import { DataSection } from '../components/settings/DataSection';
import { FfmpegSection } from '../components/settings/FfmpegSection';
import { LanguageSection } from '../components/settings/LanguageSection';
import { ProviderCard } from '../components/settings/ProviderCard';
import { RecordingSection } from '../components/settings/RecordingSection';
import { UpdatesSection } from '../components/settings/UpdatesSection';
import { SavedIndicator, loadKeyStatus, useKeyStatus } from '../components/settings/common';
import { useSettings } from '../lib/settings';
import type { ProviderId } from '../lib/types';

type TabId = ProviderId | 'language' | 'recording' | 'system';

const PROVIDER_TABS: { id: ProviderId; label: string }[] = [
  { id: 'soniox', label: 'Soniox' },
  { id: 'elevenlabs', label: 'ElevenLabs' },
];

const GENERAL_TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'language', label: 'Language', icon: Languages },
  { id: 'recording', label: 'Recording', icon: Mic },
  { id: 'system', label: 'System', icon: Wrench },
];

const TAB_IDS = new Set<string>([...PROVIDER_TABS, ...GENERAL_TABS].map((t) => t.id));

export default function SettingsScreen() {
  // The tab lives in the URL (#/settings?tab=elevenlabs) so other screens can link to it.
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') ?? '';
  const tab: TabId = TAB_IDS.has(requested) ? (requested as TabId) : 'soniox';
  const select = (id: TabId) => setParams({ tab: id }, { replace: true });

  const keys = useKeyStatus();
  const defaultProvider = useSettings((s) => s.settings.defaultProvider);

  useEffect(() => {
    void loadKeyStatus();
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <PageHeader
        title="Settings"
        description="Changes are saved automatically."
        actions={<SavedIndicator />}
      />

      <div role="tablist" aria-label="Settings sections" className="mb-6 flex items-end gap-1 border-b border-line">
        {PROVIDER_TABS.map((t) => (
          <Tab key={t.id} active={tab === t.id} onClick={() => select(t.id)}>
            <span
              className={clsx('h-2 w-2 rounded-full', keys[t.id] ? 'bg-ok' : 'bg-faint/50')}
              title={keys[t.id] ? 'Key saved' : 'No key'}
            />
            {t.label}
            {defaultProvider === t.id && (
              <Star size={12} className="fill-current text-accent" aria-label="Default provider" />
            )}
          </Tab>
        ))}
        <span aria-hidden className="mx-2 mb-2.5 h-5 w-px bg-line" />
        {GENERAL_TABS.map((t) => (
          <Tab key={t.id} active={tab === t.id} onClick={() => select(t.id)}>
            <t.icon size={14} />
            {t.label}
          </Tab>
        ))}
      </div>

      <div role="tabpanel" className="space-y-6">
        {(tab === 'soniox' || tab === 'elevenlabs') && (
          <>
            <p className="text-[13px] text-muted">
              Add a key for at least one provider. The default (<Star size={11} className="inline fill-current text-accent" />)
              is used for new transcriptions; you can pick the other one per meeting.
            </p>
            <ProviderCard key={tab} id={tab} />
          </>
        )}
        {tab === 'language' && <LanguageSection />}
        {tab === 'recording' && <RecordingSection />}
        {tab === 'system' && (
          <>
            <UpdatesSection />
            <FfmpegSection />
            <DataSection />
          </>
        )}
      </div>
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        '-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm transition-colors',
        active ? 'border-accent font-medium text-text' : 'border-transparent text-muted hover:text-text',
      )}
    >
      {children}
    </button>
  );
}
