import { convertFileSrc } from '@tauri-apps/api/core';
import { AudioLines } from 'lucide-react';
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { formatDuration } from '../../lib/format';
import { Callout } from '../ui';
import { isAudioPath } from './shared';

// Plays the meeting's media file. Uses a <video> unless the file is audio
// (by extension, or because the video turned out to have no picture).
export function MediaPlayer({
  path,
  mediaRef,
  durationMs,
  onReady,
  onTimeUpdate,
}: {
  path: string;
  mediaRef: RefObject<HTMLMediaElement | null>;
  durationMs: number | null;
  onReady: () => void;
  onTimeUpdate: (ms: number) => void;
}) {
  const [audioOnly, setAudioOnly] = useState(() => isAudioPath(path));
  const [error, setError] = useState<string | null>(null);
  const src = useMemo(() => convertFileSrc(path), [path]);

  useEffect(() => {
    setAudioOnly(isAudioPath(path));
    setError(null);
  }, [path]);

  const common = {
    src,
    controls: true,
    preload: 'metadata' as const,
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => onTimeUpdate(e.currentTarget.currentTime * 1000),
    onSeeked: (e: React.SyntheticEvent<HTMLMediaElement>) => onTimeUpdate(e.currentTarget.currentTime * 1000),
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
      <div className="rounded-xl border border-line bg-panel p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <AudioLines size={18} />
          </div>
          <div className="min-w-0 text-[13px]">
            <div className="font-medium">Audio recording</div>
            <div className="text-muted">{formatDuration(durationMs)}</div>
          </div>
        </div>
        <audio
          key={src}
          ref={(el) => {
            mediaRef.current = el;
          }}
          {...common}
          onLoadedMetadata={onReady}
          className="w-full"
        />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-black shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <video
        key={src}
        ref={(el) => {
          mediaRef.current = el;
        }}
        {...common}
        onLoadedMetadata={(e) => {
          if (e.currentTarget.videoWidth === 0) setAudioOnly(true);
          else onReady();
        }}
        className="block aspect-video w-full bg-black"
      />
    </div>
  );
}
