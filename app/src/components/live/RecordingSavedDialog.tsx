// Shown after every OBS recording: recordings are never transcribed, summarised
// or folded into their folder automatically, so this asks (with the cost) what
// to run. Everything that reads the transcript uses one model and runs in turn,
// so only the first step pays for the whole transcript.
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { effectiveModel } from '../../lib/ai';
import { STEP_OUTPUT_TOKENS, folderSummaryCost, transcriptStepCost, updateFolderFromMeeting } from '../../lib/ai/folder';
import { startSummary, useSummaryJobs } from '../../lib/ai/meeting';
import * as db from '../../lib/db';
import { formatDuration } from '../../lib/format';
import { useLive } from '../../lib/live';
import { dismissProcessing, useRecorder, type ProcessingOffer } from '../../lib/obs';
import { emitMeetingChanged, onMeetingChanged, transcribeMeeting } from '../../lib/pipeline';
import { getProvider } from '../../lib/providers';
import { useSettings } from '../../lib/settings';
import type { Folder, Meeting } from '../../lib/types';
import { AiLanguageSelect } from '../ai/AiLanguageSelect';
import { deleteMeeting } from '../meeting/actions';
import { Button, Modal, Select, Spinner, Switch, errorMessage, toast } from '../ui';
import { costLabel } from './shared';

export function RecordingSavedDialog() {
  const offer = useRecorder((s) => s.processing[0] ?? null);
  const settings = useSettings((s) => s.settings);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [transcribe, setTranscribe] = useState(true);
  const [summarize, setSummarize] = useState(true);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [templates, setTemplates] = useState(0);
  const [folderSummary, setFolderSummary] = useState(settings.folderAiPreselect);
  const [tasks, setTasks] = useState(settings.folderAiPreselect);
  const [extraction, setExtraction] = useState(settings.folderAiPreselect);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The model for this meeting only; the setting stays as it is.
  const modelOptions = useLive((s) => s.modelOptions);
  const [aiModel, setAiModel] = useState(() => effectiveModel('summary'));
  // Kept while the modal fades out after the offer is gone.
  const [shown, setShown] = useState<ProcessingOffer | null>(null);
  if (offer && offer !== shown) setShown(offer);

  const meetingId = offer?.meetingId;
  useEffect(() => {
    if (meetingId == null) return;
    setMeeting(null);
    setTranscribe(true);
    setSummarize(true);
    setFolderSummary(settings.folderAiPreselect);
    setTasks(settings.folderAiPreselect);
    setExtraction(settings.folderAiPreselect);
    setConfirmDelete(false);
    setAiModel(effectiveModel('summary'));
    // A live meeting is offered while the recording is still being imported
    // (remuxed); transcription needs the final media file.
    let alive = true;
    const load = () =>
      void db.getMeeting(meetingId).then((m) => {
        if (!alive) return;
        // Deleted elsewhere: nothing left to ask about.
        if (!m) dismissProcessing(meetingId);
        else setMeeting(m);
      });
    load();
    const off = onMeetingChanged((id) => id === meetingId && load());
    return () => {
      alive = false;
      off();
    };
    // Only a new offer resets the choices.
  }, [meetingId, settings.folderAiPreselect]);

  const folderId = meeting?.folderId ?? null;
  useEffect(() => {
    setFolder(null);
    setTemplates(0);
    if (folderId == null) return;
    let alive = true;
    void Promise.all([db.getFolder(folderId), db.listExtractionTemplates(folderId)]).then(([f, list]) => {
      if (!alive) return;
      setFolder(f);
      setTemplates(list.length);
    });
    return () => {
      alive = false;
    };
  }, [folderId]);

  const view = offer ?? shown;
  if (!view) return null;
  const close = () => dismissProcessing(view.meetingId);

  const provider = getProvider(settings.defaultProvider);
  const durationMs = meeting?.durationMs || view.durationMs;
  const tracks = (meeting?.splitTracks ?? settings.splitTracks) ? 2 : 1;
  const cost = durationMs ? (durationMs / 3_600_000) * provider.usdPerHour * tracks : null;
  const failed = meeting?.status === 'error' && !meeting.mediaPath;
  const ready = !!meeting && meeting.status !== 'recording' && !!meeting.mediaPath;
  // Without any transcript there's nothing to summarise.
  const canSummarize = view.live || transcribe;
  const title = meeting?.title ?? 'The meeting';
  const summaryOn = summarize && canSummarize;
  const folderSummaryOn = !!folder && summaryOn && folderSummary;
  const tasksOn = !!folder && canSummarize && tasks;
  const extractionOn = !!folder && canSummarize && templates > 0 && extraction;
  const anyAi = summaryOn || folderSummaryOn || tasksOn || extractionOn;

  // The first step to read the transcript pays for it; the ones after read it cached.
  const stepCost = (output: number, cached: boolean) => transcriptStepCost(aiModel, durationMs, output, cached);
  const summaryCost = stepCost(STEP_OUTPUT_TOKENS.summary, false);
  const tasksCost = stepCost(STEP_OUTPUT_TOKENS.tasks, summaryOn);
  const extractionCached = summaryOn || tasksOn;
  const firstExtraction = stepCost(STEP_OUTPUT_TOKENS.extraction, extractionCached);
  const nextExtraction = stepCost(STEP_OUTPUT_TOKENS.extraction, true);
  const extractionCost = firstExtraction == null || nextExtraction == null ? null : firstExtraction + nextExtraction * (templates - 1);

  function go() {
    const id = view!.meetingId;
    const model = aiModel;
    const summary = summaryOn;
    const steps = { folderSummary: folderSummaryOn, tasks: tasksOn, extraction: extractionOn, model };
    close();
    const runAi = async () => {
      // A failed or stopped summary leaves nothing to build the folder summary on.
      if (summary && !(await runSummary(id, model))) return;
      await updateFolderFromMeeting(id, steps);
    };
    if (transcribe) {
      // Run the AI after the full transcript replaces the live one.
      void transcribeMeeting(id).then(async () => {
        // Don't run it on a failed transcription.
        if ((await db.getMeeting(id))?.status === 'ready') await runAi();
      });
    } else {
      void runAi();
    }
  }

  async function remove() {
    if (!meeting) return;
    setDeleting(true);
    try {
      await deleteMeeting(meeting, true);
      emitMeetingChanged(meeting.id);
      close();
      toast('Recording deleted', 'success');
    } catch (err) {
      toast(`Couldn't delete the recording: ${errorMessage(err)}`, 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal
      open={!!offer}
      onClose={close}
      title={confirmDelete ? 'Delete this recording?' : 'Recording saved'}
      footer={
        confirmDelete ? (
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Keep it
            </Button>
            <Button variant="danger" icon={Trash2} loading={deleting} onClick={() => void remove()}>
              Delete
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Not now
            </Button>
            <Button variant="danger" icon={Trash2} onClick={() => setConfirmDelete(true)} disabled={!ready && !failed}>
              Delete recording
            </Button>
            <Button
              variant="primary"
              onClick={go}
              disabled={!ready || (!transcribe && !anyAi)}
            >
              {!ready && !failed ? 'Preparing the recording…' : 'Start'}
            </Button>
          </>
        )
      }
    >
      {confirmDelete ? (
        <p className="text-[13px] text-muted">
          <span className="font-medium text-text">{title}</span>, its transcripts and its recording file
          {meeting?.mediaPath && meeting.sourcePath && meeting.mediaPath !== meeting.sourcePath ? 's' : ''} will be
          deleted. This can't be undone.
        </p>
      ) : (
        <div className="space-y-4 text-[13px]">
          <p className="text-muted">
            “{title}” ({formatDuration(durationMs)}) is saved to Meetings.{' '}
            {view.live
              ? 'Its live transcript is saved too; the full transcription is usually more accurate (better speaker separation, no missed words while reconnecting).'
              : 'It isn’t transcribed yet. If you skip this, you can transcribe it later from the meeting page.'}
          </p>
          <label className="flex items-center justify-between gap-4">
            <span>
              Transcribe with {provider.name} <span className="text-muted">({costLabel(cost)})</span>
            </span>
            <Switch checked={transcribe} onChange={setTranscribe} label="Transcribe" />
          </label>
          {transcribe && meeting && (
            <label className="flex items-center justify-between gap-4 pl-4">
              <span>
                Someone was here with me{' '}
                <span className="text-muted">(transcribe everyone together instead of labelling your mic as you)</span>
              </span>
              <Switch
                checked={!(meeting.splitTracks ?? settings.splitTracks)}
                onChange={(on) =>
                  void db
                    .updateMeeting(meeting.id, { splitTracks: !on })
                    .then(() => emitMeetingChanged(meeting.id))
                    .catch((err) => toast(errorMessage(err), 'error'))
                }
                label="Someone was here with me"
              />
            </label>
          )}
          <label className="flex items-center justify-between gap-4">
            <span className={canSummarize ? undefined : 'text-muted'}>
              Generate summary{' '}
              <span className="text-muted">
                {!canSummarize
                  ? '(needs a transcript)'
                  : transcribe
                    ? view.live
                      ? '(after the full transcription)'
                      : '(after transcription)'
                    : '(from the live transcript)'}
                {canSummarize && ` ${costLabel(summaryCost)}`}
              </span>
            </span>
            <Switch checked={summaryOn} onChange={setSummarize} disabled={!canSummarize} label="Generate summary" />
          </label>
          {folder && canSummarize && (
            <div className="space-y-3 border-t border-line pt-3">
              <div className="text-xs font-medium text-muted">In “{folder.name}”</div>
              <FolderToggle
                label="Update the folder summary"
                hint={summaryOn ? costLabel(folderSummaryCost()) : 'needs the meeting summary'}
                checked={folderSummaryOn}
                onChange={setFolderSummary}
                disabled={!summaryOn}
              />
              <FolderToggle label="Update tasks" hint={stepHint(tasksCost, summaryOn)} checked={tasksOn} onChange={setTasks} />
              {templates > 0 && (
                <FolderToggle
                  label={templates === 1 ? 'Fill in the extraction table' : `Fill in ${templates} extraction tables`}
                  hint={stepHint(extractionCost, extractionCached)}
                  checked={extractionOn}
                  onChange={setExtraction}
                />
              )}
            </div>
          )}
          {anyAi && canSummarize && (
            <div className="flex flex-wrap items-center gap-2 pl-0.5">
              <span className="text-muted">AI model</span>
              <Select
                aria-label="AI model"
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
                className="h-[30px] w-auto max-w-64 text-[12.5px]"
              >
                {[...new Set([aiModel, ...modelOptions])].filter(Boolean).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
              <span className="text-muted">in</span>
              <AiLanguageSelect />
            </div>
          )}
          {failed ? (
            <p className="text-danger">{meeting?.error ?? 'The recording couldn’t be imported.'}</p>
          ) : (
            !ready && (
              <div className="flex items-center gap-2 text-muted">
                <Spinner size={13} /> Converting the recording…
              </div>
            )
          )}
        </div>
      )}
    </Modal>
  );
}

function stepHint(cost: number | null, cached: boolean): string {
  return cached ? `${costLabel(cost)}, reuses the cached transcript` : costLabel(cost);
}

function FolderToggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span className={disabled ? 'text-muted' : undefined}>
        {label} <span className="text-muted">({hint})</span>
      </span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </label>
  );
}

// Through the shared job, so the meeting page shows it running.
async function runSummary(meetingId: number, model: string) {
  const doc = await startSummary(meetingId, { model });
  const error = useSummaryJobs.getState()[meetingId]?.error;
  if (doc) toast('Summary ready.', 'success');
  else if (error) toast(`Couldn't summarise: ${error}`, 'error');
  return doc;
}
