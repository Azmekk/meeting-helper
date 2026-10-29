import { PageHeader } from '../components/ui';
import { DataSection } from '../components/settings/DataSection';
import { FfmpegSection } from '../components/settings/FfmpegSection';
import { LanguageSection } from '../components/settings/LanguageSection';
import { ProviderCard } from '../components/settings/ProviderCard';
import { RecordingSection } from '../components/settings/RecordingSection';
import { SavedIndicator } from '../components/settings/common';

export default function SettingsScreen() {
  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <PageHeader
        title="Settings"
        description="Changes are saved automatically."
        actions={<SavedIndicator />}
      />

      <div className="space-y-8">
        <section className="space-y-3">
          <div>
            <h2 className="text-[13px] font-semibold tracking-wide text-muted uppercase">Transcription providers</h2>
            <p className="text-xs text-faint">Add a key for at least one. The default is used for new transcriptions.</p>
          </div>
          <ProviderCard id="soniox" />
          <ProviderCard id="elevenlabs" />
        </section>

        <LanguageSection />
        <RecordingSection />
        <FfmpegSection />
        <DataSection />
      </div>
    </div>
  );
}
