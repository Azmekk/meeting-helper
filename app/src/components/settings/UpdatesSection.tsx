import { RefreshCw } from 'lucide-react';
import { useSettings } from '../../lib/settings';
import { checkForUpdate, useUpdate } from '../../lib/updates';
import { Button, Card, SettingRow, Switch, toast } from '../ui';
import { saveSettings } from './common';

export function UpdatesSection() {
  const enabled = useSettings((s) => s.settings.checkForUpdates);
  const { current, available, phase, checking, error } = useUpdate();

  async function checkNow() {
    const found = await checkForUpdate(true);
    const { error, phase } = useUpdate.getState();
    if (error) toast(`Couldn't check for updates: ${error}`, 'error');
    else if (!found) toast("You're on the latest version", 'success');
    else if (phase === 'downloading') toast(`Downloading version ${found.version} in the background`, 'success');
    // Otherwise a found update opens the popup by itself.
  }

  return (
    <Card title="Updates" description="Meeting Helper downloads new versions in the background and installs them when you choose to restart.">
      <div className="divide-y divide-line">
        <SettingRow
          title="Check for new versions"
          description="Looks at the project's GitHub releases when the app starts and every few hours, and downloads any new version. Nothing is downloaded with this off."
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
            {available && (
              <div className="text-accent">
                Version {available.version} is {phase === 'idle' ? 'available' : phase === 'downloading' ? 'downloading…' : 'ready to install'}
              </div>
            )}
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
