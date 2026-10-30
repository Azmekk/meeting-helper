import { RefreshCw } from 'lucide-react';
import { useSettings } from '../../lib/settings';
import { checkForUpdate, useUpdate } from '../../lib/updates';
import { Button, Card, SettingRow, Switch, toast } from '../ui';
import { saveSettings } from './common';

export function UpdatesSection() {
  const enabled = useSettings((s) => s.settings.checkForUpdates);
  const { current, available, checking, error } = useUpdate();

  async function checkNow() {
    const found = await checkForUpdate(true);
    const { error } = useUpdate.getState();
    if (error) toast(`Couldn't check for updates: ${error}`, 'error');
    else if (!found) toast("You're on the latest version", 'success');
    // A found update opens the popup by itself.
  }

  return (
    <Card title="Updates" description="Meeting Helper tells you when a new version is out. You download and install it yourself.">
      <div className="divide-y divide-line">
        <SettingRow
          title="Check for new versions"
          description="Looks at the project's GitHub releases when the app starts and every few hours."
        >
          <Switch
            label="Check for new versions"
            checked={enabled}
            onChange={(v) => saveSettings({ checkForUpdates: v })}
          />
        </SettingRow>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
          <div className="text-[13px]">
            <div>
              You have version <b>{current ?? '…'}</b>
            </div>
            {available && <div className="text-accent">Version {available.version} is available</div>}
            {error && <div className="text-danger">Last check failed: {error}</div>}
          </div>
          <Button icon={RefreshCw} onClick={checkNow} loading={checking}>
            Check now
          </Button>
        </div>
      </div>
    </Card>
  );
}
