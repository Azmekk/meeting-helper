import LivePanel from '../components/record/LivePanel';
import ConnectionCard from '../components/record/ConnectionCard';
import ObsSetupGuide from '../components/record/ObsSetupGuide';
import OutputSettingsCard from '../components/record/OutputSettingsCard';
import RecordPanel from '../components/record/RecordPanel';
import { PageHeader } from '../components/ui';
import { useRecorder } from '../lib/obs';

export default function RecordScreen() {
  const connected = useRecorder((s) => s.connected);

  return (
    <div className="mx-auto max-w-7xl px-8 py-8">
      <PageHeader
        title="Record"
        description="Record an online meeting with OBS. When you stop, it's saved to Meetings and you choose whether to transcribe it."
      />
      <div className="space-y-6">
        <RecordPanel />
        <LivePanel />
        {connected ? (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="space-y-6">
              <ConnectionCard />
              <ObsSetupGuide connected />
            </div>
            <OutputSettingsCard />
          </div>
        ) : (
          // Side by side at equal height, so their edges line up.
          <div className="grid gap-6 lg:grid-cols-2">
            <ConnectionCard className="h-full" />
            <ObsSetupGuide connected={false} className="h-full" />
          </div>
        )}
      </div>
    </div>
  );
}
