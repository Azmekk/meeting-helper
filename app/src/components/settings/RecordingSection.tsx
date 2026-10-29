import { useSettings } from '../../lib/settings';
import { Card, SettingRow, Switch } from '../ui';
import { CommitInput, saveSettings } from './common';

export function RecordingSection() {
  const s = useSettings((st) => st.settings);

  return (
    <Card title="Recording & processing">
      <div className="space-y-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="self-name" className="text-[13px] font-medium">
            Your name
          </label>
          <CommitInput
            id="self-name"
            className="max-w-xs"
            placeholder="Me"
            value={s.selfName}
            onCommit={(v) => saveSettings({ selfName: v.trim() || 'Me' })}
          />
          <span className="text-xs text-muted">Used as the speaker name for your microphone.</span>
        </div>

        <div className="divide-y divide-line border-t border-line">
          <SettingRow
            title="Transcribe my microphone separately"
            description={
              <>
                Your mic is transcribed on its own, so your lines are always labelled as you. Wear headphones,
                otherwise your mic also picks up the other people. If a recording has only one audio track, the app
                falls back to a single mixed track.
              </>
            }
          >
            <Switch
              label="Transcribe my microphone separately"
              checked={s.splitTracks}
              onChange={(v) => saveSettings({ splitTracks: v })}
            />
          </SettingRow>
          <SettingRow
            title="Transcribe automatically"
            description="Start transcribing as soon as a recording stops or a file is imported."
          >
            <Switch
              label="Transcribe automatically"
              checked={s.autoTranscribe}
              onChange={(v) => saveSettings({ autoTranscribe: v })}
            />
          </SettingRow>
          <SettingRow
            title="Keep the original MKV"
            description="OBS recordings are converted to MP4 for playback. Turn this on to keep the original .mkv file as well."
          >
            <Switch
              label="Keep the original MKV"
              checked={s.keepOriginalMkv}
              onChange={(v) => saveSettings({ keepOriginalMkv: v })}
            />
          </SettingRow>
        </div>
      </div>
    </Card>
  );
}
