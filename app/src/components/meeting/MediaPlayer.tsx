import { convertFileSrc } from '@tauri-apps/api/core';
import { AudioLines, Maximize2, Minimize2, Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { formatDuration, formatTimestamp } from '../../lib/format';
import { Button, Callout, IconButton, clsx } from '../ui';
import { isAudioPath } from './shared';

// Plays the meeting's media file. Uses a <video> unless the file is audio
// (by extension, or because the video turned out to have no picture). A video
// is either a small bar above the panels or expanded to the page's full width;
// both are the same element, so switching doesn't interrupt playback.
export function MediaPlayer({
  path,
  mediaRef,
  durationMs,
  expanded,
  onToggleExpanded,
  onReady,
  onTimeUpdate,
}: {
  path: string;
  mediaRef: RefObject<HTMLMediaElement | null>;
  durationMs: number | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onReady: () => void;
  onTimeUpdate: (ms: number) => void;
}) {
  const [audioOnly, setAudioOnly] = useState(() => isAudioPath(path));
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [lengthMs, setLengthMs] = useState(durationMs ?? 0);
  const src = useMemo(() => convertFileSrc(path), [path]);

  useEffect(() => {
    setAudioOnly(isAudioPath(path));
    setError(null);
    setPlaying(false);
    setCurrentMs(0);
    setLengthMs(durationMs ?? 0);
  }, [path, durationMs]);

  const track = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    const ms = e.currentTarget.currentTime * 1000;
    setCurrentMs(ms);
    onTimeUpdate(ms);
  };
  const common = {
    src,
    preload: 'metadata' as const,
    onTimeUpdate: track,
    onSeeked: track,
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onError: () => setError("This file can't be played here. The format or codec may not be supported by the built-in player."),
  };

  if (error) {
    return (
      <Callout tone="warn" title="Can't play media">
        {error}
      </Callout>
    );
  }

  if (audioOnly) {
    return (
      <div className="surface flex flex-wrap items-center gap-3 rounded-card p-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
          <AudioLines size={18} />
        </div>
        <div className="shrink-0 text-[13px]">
          <div className="font-medium">Audio recording</div>
          <div className="text-muted">{formatDuration(durationMs)}</div>
        </div>
        <audio
          key={src}
          ref={(el) => {
            mediaRef.current = el;
          }}
          {...common}
          controls
          onLoadedMetadata={onReady}
          className="h-10 min-w-56 flex-1"
        />
      </div>
    );
  }

  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  return (
    <div className={clsx(expanded ? 'relative overflow-hidden rounded-card bg-black shadow-card' : 'surface flex flex-wrap items-center gap-3 rounded-card p-2.5')}>
      <video
        key={src}
        ref={(el) => {
          mediaRef.current = el;
        }}
        {...common}
        controls={expanded}
        onLoadedMetadata={(e) => {
          if (e.currentTarget.videoWidth === 0) {
            setAudioOnly(true);
            return;
          }
          if (Number.isFinite(e.currentTarget.duration)) setLengthMs(e.currentTarget.duration * 1000);
          onReady();
        }}
        className={clsx(expanded ? 'block aspect-video max-h-[62vh] w-full bg-black' : 'h-14 w-24 shrink-0 rounded-xl bg-black object-cover')}
      />
      {expanded ? (
        <Button size="sm" variant="secondary" icon={Minimize2} onClick={onToggleExpanded} className="absolute top-3 right-3 bg-black/70 text-white hover:bg-black/85">
          Mini player
        </Button>
      ) : (
        <>
          <IconButton icon={playing ? Pause : Play} label={playing ? 'Pause' : 'Play'} onClick={togglePlay} />
          <span className="shrink-0 text-[13px] whitespace-nowrap text-muted tabular-nums">
            {formatTimestamp(currentMs)} / {formatTimestamp(lengthMs)}
          </span>
          <input
            type="range"
            aria-label="Position"
            min={0}
            max={Math.max(1, lengthMs)}
            value={Math.min(currentMs, lengthMs)}
            onChange={(e) => {
              const el = mediaRef.current;
              if (el) el.currentTime = Number(e.target.value) / 1000;
            }}
            className="min-w-32 flex-1 accent-accent"
          />
          <Button size="sm" variant="secondary" icon={Maximize2} onClick={onToggleExpanded}>
            Expand video
          </Button>
        </>
      )}
    </div>
  );
}
