import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Crosshair, FileText, ListFilter, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DeleteMeetingModal } from '../components/meeting/actions';
import { MediaPlayer } from '../components/meeting/MediaPlayer';
import { MeetingHeader } from '../components/meeting/MeetingHeader';
import { PROVIDER_IDS, PROVIDER_LABEL, isJobActive, speakerColor } from '../components/meeting/shared';
import { SpeakersPanel } from '../components/meeting/SpeakersPanel';
import { TranscriptEditor, type SegmentActions } from '../components/meeting/TranscriptEditor';
import {
  Button,
  Callout,
  Card,
  EmptyState,
  IconButton,
  Input,
  Modal,
  Spinner,
  Switch,
  clsx,
  errorMessage,
  toast,
} from '../components/ui';
import * as db from '../lib/db';
import { EXPORT_FORMATS, formatTranscript, safeFileName, type ExportFormat } from '../lib/export';
import { onMeetingChanged, transcribeMeeting, useJobs, type Job, type JobStage } from '../lib/pipeline';
import { useSettings } from '../lib/settings';
import type { Meeting, ProviderId, Segment, Transcript, TranscriptDetail } from '../lib/types';

// Last segment that started at or before `ms`, if we're still inside it (with
// a little slack for gaps between segments).
function findActiveSegment(segments: Segment[], ms: number): number | null {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const s = segments[found];
  return ms <= s.endMs + 1500 ? s.id : null;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export default function MeetingScreen() {
  const { id: idParam } = useParams();
  const meetingId = Number(idParam);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const defaultProvider = useSettings((s) => s.settings.defaultProvider);
  const job = useJobs((s) => s.jobs[meetingId]);

  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [detail, setDetail] = useState<TranscriptDetail | null>(null);
  const [knownNames, setKnownNames] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeId, setActiveId] = useState<number | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [confirmDeleteTranscript, setConfirmDeleteTranscript] = useState(false);
  const [deletingTranscript, setDeletingTranscript] = useState(false);
  const [deleteMeetingOpen, setDeleteMeetingOpen] = useState(false);

  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const pendingSeek = useRef<{ ms: number; play: boolean } | null>(null);
  const detailRef = useRef(detail);
  detailRef.current = detail;

  // ---------- Loading ----------

  const loadDetail = useCallback(async (transcriptId: number | null) => {
    if (transcriptId == null) {
      setDetail(null);
      return;
    }
    setDetail(await db.getTranscriptDetail(transcriptId));
  }, []);

  const loadAll = useCallback(async () => {
    if (!Number.isFinite(meetingId)) {
      setMeeting(null);
      return;
    }
    try {
      const [m, ts] = await Promise.all([db.getMeeting(meetingId), db.listTranscripts(meetingId)]);
      setMeeting(m);
      setTranscripts(ts);
      const tid = m?.activeTranscriptId ?? ts[0]?.id ?? null;
      await loadDetail(tid);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
      setMeeting((cur) => (cur === undefined ? null : cur));
    }
  }, [meetingId, loadDetail]);

  const reloadDetail = useCallback(async () => {
    const tid = detailRef.current?.transcript.id ?? null;
    try {
      await loadDetail(tid);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }, [loadDetail]);

  const refreshKnownNames = useCallback(() => {
    db.listKnownNames()
      .then(setKnownNames)
      .catch(() => {});
  }, []);

  useEffect(() => {
    setMeeting(undefined);
    setDetail(null);
    setActiveId(null);
    loadAll();
    refreshKnownNames();
    return onMeetingChanged((id) => {
      if (id === meetingId) loadAll();
    });
  }, [meetingId, loadAll, refreshKnownNames]);

  // Reload when a job for this meeting finishes or fails.
  const jobStage = job?.stage;
  const prevStage = useRef<JobStage | undefined>(undefined);
  useEffect(() => {
    const prev = prevStage.current;
    prevStage.current = jobStage;
    if (prev && prev !== jobStage && (jobStage === 'done' || jobStage === 'error')) loadAll();
  }, [jobStage, loadAll]);

  // ---------- Speaker colors ----------

  const colorIndex = useMemo(() => {
    const m = new Map<number, number>();
    detail?.speakers.forEach((s, i) => m.set(s.id, i));
    return m;
  }, [detail?.speakers]);
  const colorOf = useCallback((speakerId: number | null) => speakerColor(speakerId == null ? -1 : colorIndex.get(speakerId) ?? -1), [colorIndex]);

  // ---------- Playback ----------

  const seek = useCallback((ms: number, play: boolean) => {
    const el = mediaRef.current;
    const segs = detailRef.current?.segments;
    if (segs) setActiveId(findActiveSegment(segs, ms + 1));
    if (el && el.readyState >= 1) {
      el.currentTime = ms / 1000;
      if (play) el.play().catch(() => {});
    } else {
      pendingSeek.current = { ms, play };
    }
  }, []);

  const onMediaReady = useCallback(() => {
    const p = pendingSeek.current;
    const el = mediaRef.current;
    if (!p || !el) return;
    pendingSeek.current = null;
    el.currentTime = p.ms / 1000;
    if (p.play) el.play().catch(() => {});
  }, []);

  const onTimeUpdate = useCallback((ms: number) => {
    const segs = detailRef.current?.segments;
    if (!segs) return;
    const id = findActiveSegment(segs, ms);
    setActiveId((cur) => (cur === id ? cur : id));
  }, []);

  // Follow playback: keep the active segment in view while playing.
  useEffect(() => {
    if (!follow || activeId == null) return;
    const el = mediaRef.current;
    if (!el || el.paused) return;
    if (isTypingTarget(document.activeElement)) return;
    document.querySelector(`[data-seg="${activeId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeId, follow]);

  const jumpToPlayback = () => {
    setFollow(true);
    if (activeId != null)
      document.querySelector(`[data-seg="${activeId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  // Space toggles play/pause when not typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target) || e.target instanceof HTMLMediaElement) return;
      if (document.querySelector('[role="dialog"]')) return;
      const el = mediaRef.current;
      if (!el) return;
      e.preventDefault();
      if (el.paused) el.play().catch(() => {});
      else el.pause();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Deep link: ?t=<ms>&seg=<segmentId> (from search results).
  const tParam = searchParams.get('t');
  const segParam = searchParams.get('seg');
  const handledLink = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || (!tParam && !segParam)) return;
    const key = `${meetingId}:${tParam}:${segParam}`;
    if (handledLink.current === key) return;
    handledLink.current = key;

    const segId = segParam ? Number(segParam) : null;
    const seg = segId != null ? detail.segments.find((s) => s.id === segId) : undefined;
    const t = tParam != null ? Number(tParam) : seg?.startMs;
    if (t != null && Number.isFinite(t)) seek(t, false);
    if (seg) {
      setFlashId(seg.id);
      requestAnimationFrame(() =>
        document.querySelector(`[data-seg="${seg.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      );
      setTimeout(() => setFlashId((cur) => (cur === seg.id ? null : cur)), 4000);
    }
  }, [detail, tParam, segParam, meetingId, seek]);

  // ---------- Edits (optimistic) ----------

  const mutate = useCallback(
    async (optimistic: (d: TranscriptDetail) => TranscriptDetail, action: () => Promise<unknown>, failMsg: string) => {
      setDetail((d) => (d ? optimistic(d) : d));
      try {
        await action();
      } catch (err) {
        toast(`${failMsg}: ${errorMessage(err)}`, 'error');
        reloadDetail();
      }
    },
    [reloadDetail],
  );

  const actions = useMemo<SegmentActions>(
    () => ({
      seek,
      editText: (segmentId, text) =>
        mutate(
          (d) => ({
            ...d,
            segments: d.segments.map((s) => (s.id === segmentId ? { ...s, text, edited: true } : s)),
          }),
          () => db.updateSegment(segmentId, { text }),
          "Couldn't save the edit",
        ),
      reassign: (segmentId, speakerId) =>
        mutate(
          (d) => ({ ...d, segments: d.segments.map((s) => (s.id === segmentId ? { ...s, speakerId } : s)) }),
          () => db.updateSegment(segmentId, { speakerId }),
          "Couldn't change the speaker",
        ),
      createSpeakerAndAssign: async (segmentId, name) => {
        const tid = detailRef.current?.transcript.id;
        if (tid == null) return;
        try {
          const sp = await db.addSpeaker(tid, name);
          setDetail((d) =>
            d && d.transcript.id === tid
              ? {
                  ...d,
                  speakers: [...d.speakers, sp],
                  segments: d.segments.map((s) => (s.id === segmentId ? { ...s, speakerId: sp.id } : s)),
                }
              : d,
          );
          await db.updateSegment(segmentId, { speakerId: sp.id });
          refreshKnownNames();
        } catch (err) {
          toast(`Couldn't add the speaker: ${errorMessage(err)}`, 'error');
          reloadDetail();
        }
      },
      merge: (segmentId) =>
        mutate(
          (d) => {
            const i = d.segments.findIndex((s) => s.id === segmentId);
            if (i < 0 || i === d.segments.length - 1) return d;
            const cur = d.segments[i];
            const next = d.segments[i + 1];
            const merged: Segment = {
              ...cur,
              text: [cur.text.trim(), next.text.trim()].filter(Boolean).join(' '),
              endMs: Math.max(cur.endMs, next.endMs),
              edited: true,
            };
            return { ...d, segments: [...d.segments.slice(0, i), merged, ...d.segments.slice(i + 2)] };
          },
          () => db.mergeWithNext(segmentId),
          "Couldn't merge the segments",
        ),
      remove: (segmentId) =>
        mutate(
          (d) => ({ ...d, segments: d.segments.filter((s) => s.id !== segmentId) }),
          () => db.deleteSegment(segmentId),
          "Couldn't delete the segment",
        ),
    }),
    [seek, mutate, refreshKnownNames, reloadDetail],
  );

  const renameSpeaker = useCallback(
    (speakerId: number, name: string | null) => {
      mutate(
        (d) => ({ ...d, speakers: d.speakers.map((s) => (s.id === speakerId ? { ...s, name } : s)) }),
        async () => {
          await db.renameSpeaker(speakerId, name);
          refreshKnownNames();
        },
        "Couldn't rename the speaker",
      );
    },
    [mutate, refreshKnownNames],
  );

  const addSpeaker = useCallback(
    async (name: string) => {
      const tid = detailRef.current?.transcript.id;
      if (tid == null) return;
      try {
        const sp = await db.addSpeaker(tid, name);
        setDetail((d) => (d && d.transcript.id === tid ? { ...d, speakers: [...d.speakers, sp] } : d));
        refreshKnownNames();
      } catch (err) {
        toast(`Couldn't add the speaker: ${errorMessage(err)}`, 'error');
      }
    },
    [refreshKnownNames],
  );

  // ---------- Meeting-level actions ----------

  const renameMeeting = async (title: string) => {
    setMeeting((m) => (m ? { ...m, title } : m));
    try {
      await db.updateMeeting(meetingId, { title });
    } catch (err) {
      toast(`Couldn't rename: ${errorMessage(err)}`, 'error');
      loadAll();
    }
  };

  const selectTranscript = async (transcriptId: number) => {
    try {
      await db.setActiveTranscript(meetingId, transcriptId);
      setMeeting((m) => (m ? { ...m, activeTranscriptId: transcriptId } : m));
      setActiveId(null);
      await loadDetail(transcriptId);
    } catch (err) {
      toast(`Couldn't switch transcript: ${errorMessage(err)}`, 'error');
    }
  };

  const transcribe = (provider?: ProviderId) => {
    const p = provider ?? defaultProvider;
    toast(`Transcribing with ${PROVIDER_LABEL[p]}…`);
    setMeeting((m) => (m ? { ...m, status: 'processing', error: null } : m));
    transcribeMeeting(meetingId, p).finally(() => loadAll());
  };

  const exportAs = async (format: ExportFormat) => {
    if (!detail || !meeting) return;
    const f = EXPORT_FORMATS.find((x) => x.id === format)!;
    try {
      const path = await save({
        title: 'Export transcript',
        defaultPath: `${safeFileName(meeting.title)}.${f.ext}`,
        filters: [{ name: f.label, extensions: [f.ext] }],
      });
      if (!path) return;
      await writeTextFile(path, formatTranscript(format, detail, { title: meeting.title, createdAt: meeting.createdAt }));
      toast(`Exported to ${path}`, 'success');
    } catch (err) {
      toast(`Export failed: ${errorMessage(err)}`, 'error');
    }
  };

  const showInFolder = async () => {
    const p = meeting?.mediaPath ?? meeting?.sourcePath;
    if (!p) return;
    try {
      await revealItemInDir(p);
    } catch (err) {
      toast(`Couldn't open the folder: ${errorMessage(err)}`, 'error');
    }
  };

  const deleteTranscript = async () => {
    if (!detail) return;
    setDeletingTranscript(true);
    try {
      await db.deleteTranscript(detail.transcript.id);
      setConfirmDeleteTranscript(false);
      toast('Transcript deleted', 'success');
      await loadAll();
    } catch (err) {
      toast(`Couldn't delete the transcript: ${errorMessage(err)}`, 'error');
    } finally {
      setDeletingTranscript(false);
    }
  };

  // ---------- Render ----------

  if (meeting === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  }
  if (meeting === null) {
    return (
      <div className="mx-auto max-w-5xl px-8 py-8">
        <Card>
          <EmptyState
            icon={FileText}
            title="Meeting not found"
            description={loadError ?? 'It may have been deleted.'}
            action={<Button onClick={() => navigate('/meetings')}>Back to meetings</Button>}
          />
        </Card>
      </div>
    );
  }

  const busy = isJobActive(job) || meeting.status === 'processing';
  const hasMedia = !!(meeting.mediaPath || meeting.sourcePath);
  const segmentCount = detail?.segments.length ?? 0;

  return (
    <div className="mx-auto max-w-7xl px-8 py-8">
      <MeetingHeader
        meeting={meeting}
        job={job}
        transcripts={transcripts}
        activeTranscript={detail?.transcript ?? null}
        defaultProvider={defaultProvider}
        onRename={renameMeeting}
        onSelectTranscript={selectTranscript}
        onTranscribe={transcribe}
        onExport={exportAs}
        onShowInFolder={showInFolder}
        onDeleteTranscript={() => setConfirmDeleteTranscript(true)}
        onDeleteMeeting={() => setDeleteMeetingOpen(true)}
      />

      {loadError && (
        <Callout tone="error" title="Something went wrong loading this meeting" className="mb-6">
          {loadError}
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(300px,400px)_minmax(0,1fr)]">
        {/* Left: player + speakers */}
        <aside className="space-y-5 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:self-start lg:overflow-y-auto lg:pb-2">
          {meeting.mediaPath ? (
            <MediaPlayer
              path={meeting.mediaPath}
              mediaRef={mediaRef}
              durationMs={meeting.durationMs}
              onReady={onMediaReady}
              onTimeUpdate={onTimeUpdate}
            />
          ) : (
            <Callout tone="warn" title="No playable media">
              {meeting.status === 'recording'
                ? 'The recording is still in progress.'
                : meeting.sourcePath
                  ? 'The recording hasn’t been converted to a playable file yet.'
                  : 'The media file for this meeting is missing. The transcript is still available.'}
            </Callout>
          )}

          {detail && (
            <SpeakersPanel
              speakers={detail.speakers}
              segments={detail.segments}
              colorOf={colorOf}
              knownNames={knownNames}
              onRename={renameSpeaker}
              onAdd={addSpeaker}
            />
          )}
        </aside>

        {/* Right: status + transcript */}
        <section className="min-w-0">
          {busy && <ProcessingPanel job={job} />}

          {meeting.status === 'error' && !busy && (
            <Callout tone="error" title="Transcription failed" className="mb-5">
              <p className="break-words">{meeting.error ?? 'Unknown error.'}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => transcribe()}>
                  Retry with {PROVIDER_LABEL[defaultProvider]}
                </Button>
                {PROVIDER_IDS.filter((p) => p !== defaultProvider).map((p) => (
                  <Button key={p} size="sm" variant="ghost" onClick={() => transcribe(p)}>
                    Try {PROVIDER_LABEL[p]}
                  </Button>
                ))}
              </div>
            </Callout>
          )}

          {!detail && !busy && meeting.status !== 'error' && (
            <Card>
              <EmptyState
                icon={Sparkles}
                title={meeting.status === 'recording' ? 'Still recording' : 'No transcript yet'}
                description={
                  meeting.status === 'recording'
                    ? 'You can transcribe the meeting once the recording has stopped.'
                    : hasMedia
                      ? 'Transcribe the recording to get a searchable, editable transcript with speakers.'
                      : 'There is no media file to transcribe.'
                }
                action={
                  hasMedia &&
                  meeting.status !== 'recording' && (
                    <div className="flex flex-wrap justify-center gap-2">
                      {[defaultProvider, ...PROVIDER_IDS.filter((p) => p !== defaultProvider)].map((p, i) => (
                        <Button key={p} variant={i === 0 ? 'primary' : 'secondary'} icon={i === 0 ? Sparkles : undefined} onClick={() => transcribe(p)}>
                          Transcribe with {PROVIDER_LABEL[p]}
                        </Button>
                      ))}
                    </div>
                  )
                }
              />
            </Card>
          )}

          {detail && (
            <>
              <div className="sticky top-0 z-20 -mx-3 mb-1 flex items-center gap-3 bg-bg/90 px-3 py-2.5 backdrop-blur">
                <div className="text-[13px] text-muted">
                  {segmentCount} segment{segmentCount === 1 ? '' : 's'}
                </div>
                <div className="ml-auto flex items-center gap-3">
                  {filterOpen ? (
                    <div className="relative">
                      <ListFilter size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
                      <Input
                        autoFocus
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setFilter('');
                            setFilterOpen(false);
                          }
                        }}
                        placeholder="Find in transcript"
                        className="h-8 w-56 pr-8 pl-8 text-[13px]"
                      />
                      <IconButton
                        size="sm"
                        icon={X}
                        label="Clear filter"
                        onClick={() => {
                          setFilter('');
                          setFilterOpen(false);
                        }}
                        className="absolute top-1/2 right-1 -translate-y-1/2"
                      />
                    </div>
                  ) : (
                    <IconButton icon={ListFilter} label="Find in transcript" onClick={() => setFilterOpen(true)} />
                  )}
                  {meeting.mediaPath && (
                    <>
                      <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted">
                        <Switch checked={follow} onChange={setFollow} label="Follow playback" />
                        Follow playback
                      </label>
                      <IconButton
                        icon={Crosshair}
                        label="Jump to current position"
                        onClick={jumpToPlayback}
                        disabled={activeId == null}
                      />
                    </>
                  )}
                </div>
              </div>

              {segmentCount === 0 ? (
                <p className="px-3 py-10 text-center text-sm text-muted">This transcript has no text.</p>
              ) : (
                <TranscriptEditor
                  segments={detail.segments}
                  speakers={detail.speakers}
                  colorOf={colorOf}
                  activeId={activeId}
                  flashId={flashId}
                  filter={filter}
                  actions={actions}
                  onUserScroll={() => setFollow((f) => (f ? false : f))}
                />
              )}
            </>
          )}
        </section>
      </div>

      <Modal
        open={confirmDeleteTranscript}
        onClose={() => setConfirmDeleteTranscript(false)}
        title="Delete transcript?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDeleteTranscript(false)}>
              Cancel
            </Button>
            <Button variant="danger" icon={Trash2} loading={deletingTranscript} onClick={deleteTranscript}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          This removes the{' '}
          <span className="font-medium text-text">
            {detail ? `${PROVIDER_LABEL[detail.transcript.provider]} · ${detail.transcript.model}` : ''}
          </span>{' '}
          transcript including your edits and speaker names. The recording itself is kept.
          {transcripts.length > 1 && ' The newest remaining transcript will be shown instead.'}
        </p>
      </Modal>

      <DeleteMeetingModal
        meeting={deleteMeetingOpen ? meeting : null}
        onClose={() => setDeleteMeetingOpen(false)}
        onDeleted={() => navigate('/meetings')}
      />
    </div>
  );
}

const STAGES: { id: JobStage; label: string }[] = [
  { id: 'preparing', label: 'Prepare' },
  { id: 'extracting', label: 'Extract audio' },
  { id: 'uploading', label: 'Upload' },
  { id: 'transcribing', label: 'Transcribe' },
  { id: 'saving', label: 'Save' },
];

function ProcessingPanel({ job }: { job: Job | undefined }) {
  const current = job ? STAGES.findIndex((s) => s.id === job.stage) : -1;
  return (
    <div className="mb-5 rounded-xl border border-line bg-panel px-5 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-center gap-3">
        <Spinner size={18} className="text-accent" />
        <div className="min-w-0 flex-1 text-sm font-medium">{job?.message || 'Processing…'}</div>
      </div>
      <div className="mt-3 flex gap-1.5">
        {STAGES.map((s, i) => (
          <div key={s.id} className="min-w-0 flex-1">
            <div
              className={clsx(
                'h-1 rounded-full transition-colors',
                i < current ? 'bg-accent' : i === current ? 'animate-pulse bg-accent' : 'bg-sunken',
              )}
            />
            <div className={clsx('mt-1.5 truncate text-[11px]', i <= current ? 'text-muted' : 'text-faint')}>{s.label}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">You can leave this page; processing continues in the background.</p>
    </div>
  );
}
