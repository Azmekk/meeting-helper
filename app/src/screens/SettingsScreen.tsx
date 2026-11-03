import { CloudUpload, EyeOff, Folder, Languages, Mic, Palette, Plug, Sparkles, Star, Wrench, type LucideIcon } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader, clsx } from '../components/ui';
import { AiSection } from '../components/settings/AiSection';
import { AppearanceSection } from '../components/settings/AppearanceSection';
import { BackupSection } from '../components/settings/BackupSection';
import { DataSection } from '../components/settings/DataSection';
import { FfmpegSection } from '../components/settings/FfmpegSection';
import { FoldersSection } from '../components/settings/FoldersSection';
import { LanguageSection } from '../components/settings/LanguageSection';
import { ProviderCard } from '../components/settings/ProviderCard';
import { LiveSection } from '../components/settings/LiveSection';
import { McpSection } from '../components/settings/McpSection';
import { RecordingSection } from '../components/settings/RecordingSection';
import { SecretSection } from '../components/settings/SecretSection';
import { UpdatesSection } from '../components/settings/UpdatesSection';
import { SavedIndicator, loadKeyStatus, useKeyStatus } from '../components/settings/common';
import { useSettings } from '../lib/settings';
import type { ProviderId } from '../lib/types';

type TabId = ProviderId | 'appearance' | 'ai' | 'mcp' | 'language' | 'recording' | 'folders' | 'backup' | 'secret' | 'system';

const PROVIDER_TABS: { id: ProviderId; label: string }[] = [
  { id: 'soniox', label: 'Soniox' },
  { id: 'elevenlabs', label: 'ElevenLabs' },
];

const GENERAL_TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'mcp', label: 'MCP', icon: Plug },
  { id: 'language', label: 'Language', icon: Languages },
  { id: 'recording', label: 'Recording', icon: Mic },
  { id: 'folders', label: 'Folders', icon: Folder },
  { id: 'backup', label: 'Backup', icon: CloudUpload },
  { id: 'secret', label: 'Secret mode', icon: EyeOff },
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
    <div className="mx-auto max-w-7xl px-8 py-8">
      <PageHeader
        title="Settings"
        description="Changes are saved automatically."
        actions={<SavedIndicator />}
      />

      <div className="flex items-start gap-8">
        <nav role="tablist" aria-orientation="vertical" aria-label="Settings sections" className="sticky top-8 w-[180px] shrink-0 space-y-0.5">
          <NavHeading>Transcription</NavHeading>
          {PROVIDER_TABS.map((t) => (
            <Tab key={t.id} active={tab === t.id} onClick={() => select(t.id)}>
              <span
                className={clsx('mx-[3px] h-2 w-2 shrink-0 rounded-full', keys[t.id] ? 'bg-ok' : 'bg-faint/50')}
                title={keys[t.id] ? 'Key saved' : 'No key'}
              />
              {t.label}
              {defaultProvider === t.id && (
                <Star size={12} className="ml-auto fill-current text-accent" aria-label="Default provider" />
              )}
            </Tab>
          ))}
          <NavHeading>General</NavHeading>
          {GENERAL_TABS.map((t) => (
            <Tab key={t.id} active={tab === t.id} onClick={() => select(t.id)}>
              <t.icon size={14} className="shrink-0" />
              {t.label}
            </Tab>
          ))}
        </nav>

        <div role="tabpanel" className="min-w-0 max-w-3xl flex-1 space-y-[18px]">
          {(tab === 'soniox' || tab === 'elevenlabs') && (
            <>
              <p className="text-[13px] text-muted">
                Add a key for at least one provider. The default (<Star size={11} className="inline fill-current text-accent" />)
                is used for new transcriptions; you can pick the other one per meeting.
              </p>
              <ProviderCard key={tab} id={tab} />
            </>
          )}
          {tab === 'appearance' && <AppearanceSection />}
          {tab === 'ai' && <AiSection />}
          {tab === 'mcp' && <McpSection />}
          {tab === 'language' && <LanguageSection />}
          {tab === 'folders' && <FoldersSection />}
          {tab === 'backup' && <BackupSection />}
          {tab === 'secret' && <SecretSection />}
          {tab === 'recording' && (
            <>
              <RecordingSection />
              <LiveSection />
            </>
          )}
          {tab === 'system' && (
            <>
              <UpdatesSection />
              <FfmpegSection />
              <DataSection />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NavHeading({ children }: { children: ReactNode }) {
  return <div className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted first:pt-0">{children}</div>;
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        'flex h-[34px] w-full items-center gap-2.5 whitespace-nowrap rounded-[10px] px-3 text-left text-[14px] transition-colors',
        active ? 'bg-accent-soft font-semibold text-accent-ink' : 'text-text/80 hover:bg-hover hover:text-text',
      )}
    >
      {children}
    </button>
  );
}
