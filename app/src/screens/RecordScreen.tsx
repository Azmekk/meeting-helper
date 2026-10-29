import ConnectionCard from '../components/record/ConnectionCard';
import ObsSetupGuide from '../components/record/ObsSetupGuide';
import OutputSettingsCard from '../components/record/OutputSettingsCard';
import RecordPanel from '../components/record/RecordPanel';
import { PageHeader } from '../components/ui';
import { useRecorder } from '../lib/obs';

export default function RecordScreen() {
  const connected = useRecorder((s) => s.connected);

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <PageHeader
        title="Record"
        description="Record an online meeting with OBS. When you stop, it's imported and transcribed automatically."
      />
      <div className="space-y-6">
        <RecordPanel />
        {connected ? (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="space-y-6">
              <ConnectionCard />
              <ObsSetupGuide connected />
            </div>
            <OutputSettingsCard />
          </div>
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <ConnectionCard />
            <ObsSetupGuide connected={false} />
          </div>
        )}
      </div>
    </div>
  );
}
