// Settings → Recording: live transcription, the "help me answer" hotkey and
// how rolling notes read the meeting.
import { setLiveEnabled, setOverlayProtected } from '../../lib/live';
import { useSettings } from '../../lib/settings';
import { NotesContextToggle } from '../record/LivePanel';
import { hotkeyLabel } from '../live/shared';
import { Card, SettingRow, Switch } from '../ui';
import { CommitInput, saveSettings } from './common';

const DEFAULT_HOTKEY = 'CommandOrControl+Alt+H';

export function LiveSection() {
  const s = useSettings((st) => st.settings);

  return (
    <Card
      title="Live transcription"
      description="While recording, the audio is also streamed to Soniox real-time (about $0.12 per hour per track) for a live transcript, AI notes and answer suggestions."
    >
      <div className="space-y-5">
        <div className="divide-y divide-line border-b border-line">
          <SettingRow
            title="Transcribe live while recording"
            description="Needs a Soniox key and OBS recording to MKV. The live transcript is saved with the meeting."
          >
            <Switch label="Transcribe live while recording" checked={s.liveEnabled} onChange={(v) => void setLiveEnabled(v)} />
          </SettingRow>
          <SettingRow
            title="Hide the overlay from screen sharing"
            description="Windows only: asks Windows to leave the overlay out of screen shares and recordings."
          >
            <Switch
              label="Hide the overlay from screen sharing"
              checked={s.overlayContentProtected}
              onChange={(v) => void setOverlayProtected(v)}
            />
          </SettingRow>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="live-hotkey" className="text-[13px] font-medium">
            “Help me answer” shortcut
          </label>
          <CommitInput
            id="live-hotkey"
            className="max-w-xs font-mono text-[13px]"
            placeholder={DEFAULT_HOTKEY}
            spellCheck={false}
            value={s.liveHotkey}
            onCommit={(v) => saveSettings({ liveHotkey: v.trim() })}
          />
          <span className="text-xs text-muted">
            Works in any app while live transcription runs. Currently {s.liveHotkey ? hotkeyLabel(s.liveHotkey) : 'off'}.
            Format: <code className="font-mono">CommandOrControl+Alt+H</code>, <code className="font-mono">Ctrl+Shift+F9</code>…
            Leave empty to turn it off.
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Rolling notes</span>
          <NotesContextToggle mode={s.liveNotesContext} />
        </div>
      </div>
    </Card>
  );
}
