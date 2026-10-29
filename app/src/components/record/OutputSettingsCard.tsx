import { open } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, CheckCircle2, FolderOpen, MonitorPlay, Wrench } from 'lucide-react';
import { useState } from 'react';
import {
  FORMAT_OPTIONS,
  QUALITY_OPTIONS,
  SIMPLE_ENCODER_OPTIONS,
  configureObs,
  createMeetingScene,
  selectScene,
  setOutputOption,
  useRecorder,
  type OutputField,
} from '../../lib/obs';
import { useSettings } from '../../lib/settings';
import { Button, Callout, Card, Field, Input, Select, errorMessage, toast } from '../ui';

const QUALITY_LABEL: Record<string, string> = { Stream: 'Same as stream (one audio track only)' };

export default function OutputSettingsCard() {
  const output = useRecorder((s) => s.output);
  const setup = useRecorder((s) => s.setup);
  const scenes = useRecorder((s) => s.scenes);
  const currentScene = useRecorder((s) => s.currentScene);
  const recording = useRecorder((s) => s.recording);
  const restartNeeded = useRecorder((s) => s.restartNeeded);
  const lastConfigure = useRecorder((s) => s.lastConfigure);
  const obsScene = useSettings((s) => s.settings.obsScene);

  const [saving, setSaving] = useState<string | null>(null);

  if (!output) return null;
  const disabled = recording || saving !== null;
  const simple = output.mode === 'Simple';

  async function run(key: string, fn: () => Promise<unknown>) {
    setSaving(key);
    try {
      await fn();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(null);
    }
  }

  const change = (field: OutputField, value: string) => run(field, () => setOutputOption(field, value));

  async function chooseFolder() {
    const dir = await open({ directory: true, defaultPath: output?.folder || undefined, title: 'Recording folder' });
    if (typeof dir === 'string' && dir) await change('folder', dir);
  }

  async function fix() {
    await run('fix', async () => {
      const changes = await configureObs();
      toast(changes.length ? 'OBS is set up for Meeting Helper.' : 'Everything was already set up.', 'success');
    });
  }

  const formatKnown = FORMAT_OPTIONS.some((f) => f.value === output.format);
  const encoderKnown = SIMPLE_ENCODER_OPTIONS.some((e) => e.value === output.encoder);
  const qualityHint = QUALITY_OPTIONS.find((q) => q.value === output.quality)?.hint;
  const formatHint = FORMAT_OPTIONS.find((f) => f.value === output.format)?.hint;
  const sceneValue = obsScene && scenes.includes(obsScene) ? obsScene : (currentScene ?? '');

  return (
    <Card
      title="Recording output"
      description={
        recording
          ? 'Locked while recording.'
          : `Read from your OBS profile (${output.mode} output mode). Changes are written back to OBS.`
      }
    >
      <div className="space-y-6">
        {restartNeeded && (
          <Callout tone="warn" title="Restart OBS to apply">
            OBS picks up a new encoder or quality setting only when it starts. Close and reopen OBS before your next
            recording; Meeting Helper reconnects automatically.
          </Callout>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Folder" className="sm:col-span-2" hint="Where OBS writes the recordings.">
            <div className="flex gap-2">
              <Input value={output.folder} readOnly disabled={disabled} className="font-mono text-[13px]" />
              <Button type="button" icon={FolderOpen} onClick={() => void chooseFolder()} disabled={disabled}>
                Choose…
              </Button>
            </div>
          </Field>

          <Field label="Container" hint={formatHint}>
            <Select value={output.format} onChange={(e) => void change('format', e.target.value)} disabled={disabled}>
              {FORMAT_OPTIONS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
              {!formatKnown && <option value={output.format}>{output.format}</option>}
            </Select>
          </Field>

          {simple ? (
            <Field label="Encoder" hint="If your PC lacks the chosen hardware encoder, OBS falls back to x264.">
              <Select
                value={output.encoder}
                onChange={(e) => void change('encoder', e.target.value)}
                disabled={disabled}
              >
                {!encoderKnown && <option value={output.encoder}>{output.encoder || 'Unknown'}</option>}
                {SIMPLE_ENCODER_OPTIONS.map((e) => (
                  <option key={e.value} value={e.value}>
                    {e.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Encoder" hint="Advanced output mode: change the encoder in OBS → Settings → Output.">
              <Input value={output.encoder || 'Same as stream'} readOnly disabled />
            </Field>
          )}

          {simple && (
            <Field label="Quality" hint={qualityHint} className="sm:col-span-2">
              <Select
                value={output.quality}
                onChange={(e) => void change('quality', e.target.value)}
                disabled={disabled}
              >
                {QUALITY_LABEL[output.quality] && <option value={output.quality}>{QUALITY_LABEL[output.quality]}</option>}
                {QUALITY_OPTIONS.map((q) => (
                  <option key={q.value} value={q.value}>
                    {q.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label="Scene"
            className="sm:col-span-2"
            hint="What OBS shows on screen while recording. Picked automatically when you press record."
          >
            <div className="flex gap-2">
              <Select
                value={sceneValue}
                onChange={(e) => void run('scene', () => selectScene(e.target.value))}
                disabled={disabled}
              >
                {!sceneValue && <option value="">Choose a scene</option>}
                {scenes.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
              {!scenes.includes('Meeting') && (
                <Button
                  type="button"
                  icon={MonitorPlay}
                  loading={saving === 'createScene'}
                  disabled={disabled}
                  onClick={() =>
                    void run('createScene', async () => {
                      await createMeetingScene();
                      toast('Created the “Meeting” scene with your main display.', 'success');
                    })
                  }
                >
                  Create “Meeting” scene
                </Button>
              )}
            </div>
          </Field>
        </div>

        {setup && (
          <div className="rounded-lg border border-line bg-sunken/50 p-4">
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium">Audio tracks</div>
                <div className="text-xs text-muted">
                  Your mic and the other participants are recorded on separate tracks so speakers are told apart
                  reliably.
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant={setup.ok ? 'ghost' : 'primary'}
                icon={Wrench}
                loading={saving === 'fix'}
                disabled={disabled}
                onClick={() => void fix()}
              >
                {setup.ok ? 'Re-apply' : 'Fix'}
              </Button>
            </div>
            <ul className="space-y-2">
              {setup.checks.map((c) => (
                <li key={c.id} className="flex gap-2.5 text-[13px]">
                  {c.ok ? (
                    <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" />
                  ) : (
                    <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
                  )}
                  <div className="min-w-0">
                    <div className={c.ok ? 'text-text' : 'font-medium text-text'}>{c.label}</div>
                    {c.detail && !c.ok && <div className="text-xs text-muted">{c.detail}</div>}
                  </div>
                </li>
              ))}
              {setup.micMuted && (
                <li className="flex gap-2.5 text-[13px]">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
                  <div>Your microphone “{setup.micInput}” is muted in OBS.</div>
                </li>
              )}
              {setup.desktopMuted && (
                <li className="flex gap-2.5 text-[13px]">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
                  <div>Desktop audio “{setup.desktopInput}” is muted in OBS.</div>
                </li>
              )}
            </ul>

            {lastConfigure && lastConfigure.changes.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <div className="text-xs font-medium text-text">
                  {lastConfigure.auto ? 'Meeting Helper adjusted OBS:' : 'Changed in OBS:'}
                </div>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-muted">
                  {lastConfigure.changes.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
