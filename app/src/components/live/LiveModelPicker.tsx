// Compact per-meeting model picker for live notes / answers, with the one-time
// warning about what a switch does to prompt caching.
import { useState } from 'react';
import { effectiveModel } from '../../lib/ai';
import { setLiveModel, useLive, type LiveAiTask } from '../../lib/live';
import { useSettings } from '../../lib/settings';
import { Button, Modal, Select, Switch, errorMessage, toast } from '../ui';
import { TASK_LABEL, costLabel } from './shared';

export function LiveModelPicker({ task, cost, costUnit }: { task: LiveAiTask; cost: number | null; costUnit: string }) {
  const options = useLive((s) => s.modelOptions);
  const override = useLive((s) => s.overrides[task]);
  const settings = useSettings((s) => s.settings);
  const [pending, setPending] = useState<string | null>(null);
  const [dontShow, setDontShow] = useState(false);

  const fallback = effectiveModel(task, settings);
  const current = override || fallback;
  const list = [...new Set([current, fallback, ...options].filter(Boolean))];

  async function apply(model: string) {
    try {
      await setLiveModel(task, model === fallback ? '' : model);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  function choose(model: string) {
    if (model === current) return;
    if (settings.liveModelSwitchWarningOff) void apply(model);
    else setPending(model);
  }

  async function confirm() {
    if (pending) await apply(pending);
    if (dontShow) await useSettings.getState().update({ liveModelSwitchWarningOff: true });
    setPending(null);
  }

  async function makeDefault() {
    await setLiveModel(task, current, true);
    toast(`${current} is now the default ${task === 'live' ? 'notes' : 'answer'} model.`, 'success');
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-muted">{TASK_LABEL[task]}</span>
        <Select
          value={current}
          onChange={(e) => choose(e.target.value)}
          className="h-7 min-w-0 flex-1 font-mono text-[12px]"
          aria-label={TASK_LABEL[task]}
        >
          {list.map((m) => (
            <option key={m} value={m}>
              {m}
              {m === fallback ? ' (default)' : ''}
            </option>
          ))}
        </Select>
        {override && override !== fallback && (
          <Button size="sm" variant="ghost" onClick={() => void makeDefault()}>
            Make default
          </Button>
        )}
      </div>
      <div className="text-right text-[11px] text-faint">
        {costLabel(cost)} {cost != null && costUnit}
      </div>

      <Modal
        open={pending != null}
        onClose={() => setPending(null)}
        title="Switch model for this meeting?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void confirm()}>
              Switch to {pending}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px] leading-relaxed text-muted">
          <p>
            The transcript so far is cached for the model that last read it. The first request after a switch pays the
            full input price for the whole transcript again, and so does switching back. After that, requests are cached
            on the new model.
          </p>
          <p>Bigger models also cost more per request. The estimate next to the picker shows the cost of the next one.</p>
          <p>The change applies from the next request and only to this meeting. Use “Make default” to keep it.</p>
          <label className="flex items-center gap-2 pt-1 text-text">
            <Switch checked={dontShow} onChange={setDontShow} label="Don't show again" />
            Don't show again
          </label>
        </div>
      </Modal>
    </div>
  );
}
