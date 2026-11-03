// The meeting's player: a compact bar above the panels, or the video at full
// width with its controls over the picture. Both are the same element, so
// switching doesn't interrupt playback. Shortcuts work from anywhere on the page
// (see useShortcuts), not just after clicking the video.
import { convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  AudioLines,
  Fullscreen,
  Maximize2,
  Minimize,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { formatTimestamp } from '../../lib/format';
import { Callout, clsx } from '../ui';
import { isAudioPath } from './shared';

const SKIP_MS = 5000;
const FINE_SKIP_MS = 1000;
const LONG_SKIP_MS = 15_000;
const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
const HIDE_CONTROLS_MS = 2500;
const PREFS_KEY = 'player-prefs';

const SHORTCUTS = 'Space: play or pause · ←/→: 5 s · Shift+←/→: 1 s · J/L: 15 s · ↑/↓: volume · M: mute · F: full screen';

interface Prefs {
  volume: number;
  muted: boolean;
  speed: number;
}

function readPrefs(): Prefs {
  try {
    return { volume: 1, muted: false, speed: 1, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return { volume: 1, muted: false, speed: 1 };
  }
}

function writePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* only a convenience */
  }
}

// A field being typed in keeps its keys. Sliders, switches and buttons don't
// count, so a click on one of those doesn't take the shortcuts away.
function takesTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el instanceof HTMLInputElement) return !['range', 'checkbox', 'radio', 'button'].includes(el.type);
  return false;
}

function useShortcuts(handlers: {
  togglePlay: () => void;
  skip: (ms: number) => void;
  changeVolume: (delta: number) => void;
  toggleMute: () => void;
  toggleFullscreen: () => void;
}) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    // Whether focus got where it is by tabbing. :focus-visible can't tell: a clicked
    // button starts matching it as soon as any key is pressed.
    let tabbed = false;
    const onPointer = () => {
      tabbed = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Tab') tabbed = true;
      if (e.ctrlKey || e.metaKey || e.altKey || takesTyping(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const h = latest.current;
      let action: (() => void) | null = null;
      switch (e.code) {
        case 'Space':
          // Tabbing to a button and pressing Space should still press that button.
          if (tabbed && e.target !== document.body) return;
          action = e.repeat ? () => {} : h.togglePlay;
          break;
        case 'ArrowLeft':
          action = () => h.skip(e.shiftKey ? -FINE_SKIP_MS : -SKIP_MS);
          break;
        case 'ArrowRight':
          action = () => h.skip(e.shiftKey ? FINE_SKIP_MS : SKIP_MS);
          break;
        case 'KeyJ':
          action = () => h.skip(-LONG_SKIP_MS);
          break;
        case 'KeyL':
          action = () => h.skip(LONG_SKIP_MS);
          break;
        case 'ArrowUp':
          action = () => h.changeVolume(0.05);
          break;
        case 'ArrowDown':
          action = () => h.changeVolume(-0.05);
          break;
        case 'KeyM':
          action = h.toggleMute;
          break;
        case 'KeyF':
          action = h.toggleFullscreen;
          break;
      }
      if (!action) return;
      e.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, []);
}

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
  const [prefs, setPrefs] = useState(readPrefs);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsShown, setControlsShown] = useState(true);
  const [flash, setFlash] = useState<{ text: string; key: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const src = useMemo(() => convertFileSrc(path), [path]);

  useEffect(() => {
    setAudioOnly(isAudioPath(path));
    setError(null);
    setPlaying(false);
    setCurrentMs(0);
    setLengthMs(durationMs ?? 0);
  }, [path, durationMs]);

  const applyPrefs = useCallback((el: HTMLMediaElement | null, p: Prefs) => {
    if (!el) return;
    el.volume = p.volume;
    el.muted = p.muted;
    el.playbackRate = p.speed;
  }, []);

  const updatePrefs = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    writePrefs(next);
    applyPrefs(mediaRef.current, next);
  };

  const showFlash = (text: string) => {
    setFlash({ text, key: Date.now() });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 700);
  };

  // While playing at full width, the controls get out of the way until the mouse moves.
  const wakeControls = useCallback(() => {
    setControlsShown(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsShown(false), HIDE_CONTROLS_MS);
  }, []);
  useEffect(() => {
    if (playing) wakeControls();
    else {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setControlsShown(true);
    }
  }, [playing, wakeControls]);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  const seekTo = (ms: number) => {
    const el = mediaRef.current;
    if (!el) return;
    const target = Math.max(0, Math.min(ms, lengthMs || ms));
    el.currentTime = target / 1000;
    setCurrentMs(target);
  };

  const skip = (ms: number) => {
    const el = mediaRef.current;
    if (!el) return;
    seekTo(el.currentTime * 1000 + ms);
    showFlash(`${ms > 0 ? '+' : '−'}${Math.abs(ms) / 1000} s`);
    wakeControls();
  };

  const changeVolume = (delta: number) => {
    const volume = Math.round(Math.max(0, Math.min(1, prefs.volume + delta)) * 100) / 100;
    updatePrefs({ volume, muted: volume === 0 });
    showFlash(`Volume ${Math.round(volume * 100)}%`);
    wakeControls();
  };

  const toggleMute = () => {
    updatePrefs({ muted: !prefs.muted, volume: prefs.muted && prefs.volume === 0 ? 0.5 : prefs.volume });
  };

  const nextSpeed = () => {
    const speed = SPEEDS[(SPEEDS.indexOf(prefs.speed) + 1) % SPEEDS.length];
    updatePrefs({ speed });
    showFlash(`${speed}×`);
  };

  const toggleFullscreen = () => {
    if (audioOnly) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void box.current?.requestFullscreen().catch(() => {});
  };

  // The page going full screen only fills the webview, so take the window along.
  useEffect(() => {
    const onChange = () => {
      const on = document.fullscreenElement != null;
      setFullscreen(on);
      void getCurrentWindow()
        .setFullscreen(on)
        .catch(() => {});
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useShortcuts({ togglePlay, skip, changeVolume, toggleMute, toggleFullscreen });

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
    onDurationChange: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      if (Number.isFinite(e.currentTarget.duration)) setLengthMs(e.currentTarget.duration * 1000);
    },
    onError: () => setError("This file can't be played here. The format or codec may not be supported by the built-in player."),
  };
  const attach = (el: HTMLMediaElement | null) => {
    mediaRef.current = el;
    applyPrefs(el, prefs);
  };

  if (error) {
    return (
      <Callout tone="warn" title="Can't play media">
        {error}
      </Callout>
    );
  }

  const overVideo = expanded && !audioOnly;
  const VolumeIcon = prefs.muted || prefs.volume === 0 ? VolumeX : prefs.volume < 0.5 ? Volume1 : Volume2;

  const transport = (
    <>
      <Control label="Back 5 seconds (←)" onClick={() => skip(-SKIP_MS)} dark={overVideo}>
        <SkipIcon icon={RotateCcw} />
      </Control>
      <Control label={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={togglePlay} dark={overVideo} primary>
        {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" className="translate-x-px" />}
      </Control>
      <Control label="Forward 5 seconds (→)" onClick={() => skip(SKIP_MS)} dark={overVideo}>
        <SkipIcon icon={RotateCw} />
      </Control>
    </>
  );
  const time = (
    <span className={clsx('shrink-0 text-[12.5px] whitespace-nowrap tabular-nums', overVideo ? 'text-white/85' : 'text-muted')}>
      {formatTimestamp(currentMs)} / {formatTimestamp(lengthMs)}
    </span>
  );
  const scrubber = <Scrubber currentMs={currentMs} lengthMs={lengthMs} dark={overVideo} onSeek={seekTo} />;
  const volume = (
    <div className="flex shrink-0 items-center gap-1">
      <Control label={prefs.muted ? 'Unmute (M)' : 'Mute (M)'} onClick={toggleMute} dark={overVideo}>
        <VolumeIcon size={16} />
      </Control>
      <input
        type="range"
        aria-label="Volume"
        title={`Volume ${Math.round(prefs.volume * 100)}%`}
        min={0}
        max={1}
        step={0.01}
        value={prefs.muted ? 0 : prefs.volume}
        onChange={(e) => {
          const v = Number(e.target.value);
          updatePrefs({ volume: v, muted: v === 0 });
        }}
        className={clsx('h-1 w-20 cursor-pointer', overVideo ? 'accent-white' : 'accent-accent')}
      />
    </div>
  );
  const speed = (
    <button
      type="button"
      title="Playback speed"
      aria-label={`Playback speed ${prefs.speed} times. Press for the next speed.`}
      onClick={nextSpeed}
      className={clsx(
        'h-8 min-w-10 shrink-0 rounded-full px-2 text-[12.5px] font-semibold tabular-nums transition-colors',
        overVideo ? 'text-white hover:bg-white/15' : 'text-muted hover:bg-hover hover:text-text',
      )}
    >
      {prefs.speed}×
    </button>
  );

  if (audioOnly) {
    return (
      <div className="surface relative flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card p-2.5" title={SHORTCUTS}>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
          <AudioLines size={18} />
        </div>
        <audio
          key={src}
          ref={attach}
          {...common}
          onLoadedMetadata={(e) => {
            common.onDurationChange(e);
            onReady();
          }}
        />
        {transport}
        {time}
        {scrubber}
        {volume}
        {speed}
      </div>
    );
  }

  return (
    <div
      ref={box}
      onMouseMove={overVideo ? wakeControls : undefined}
      className={clsx(
        overVideo
          ? clsx('group relative overflow-hidden bg-black', !fullscreen && 'rounded-card shadow-card', playing && !controlsShown && 'cursor-none')
          : 'surface relative flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card p-2.5',
      )}
    >
      <video
        key={src}
        ref={attach}
        {...common}
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onLoadedMetadata={(e) => {
          if (e.currentTarget.videoWidth === 0) {
            setAudioOnly(true);
            return;
          }
          common.onDurationChange(e);
          onReady();
        }}
        className={clsx(
          'cursor-pointer bg-black',
          overVideo ? (fullscreen ? 'block h-screen w-full' : 'block aspect-video max-h-[calc(100vh-47.5rem)] min-h-56 w-full') : 'h-14 w-24 shrink-0 rounded-xl object-cover',
        )}
      />

      {flash && (
        <div
          key={flash.key}
          aria-live="polite"
          className={clsx(
            'pointer-events-none absolute z-10 rounded-full bg-black/70 px-3 py-1 text-[13px] font-medium whitespace-nowrap text-white',
            overVideo ? 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2' : 'top-1/2 left-14 -translate-x-1/2 -translate-y-1/2',
          )}
        >
          {flash.text}
        </div>
      )}

      {overVideo ? (
        <div
          title={SHORTCUTS}
          className={clsx(
            'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pt-10 pb-2 transition-opacity duration-200',
            playing && !controlsShown ? 'pointer-events-none opacity-0' : 'opacity-100',
          )}
        >
          {scrubber}
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {transport}
            {volume}
            {time}
            <span className="flex-1" />
            {speed}
            <Control label="Mini player" onClick={onToggleExpanded} dark>
              <Minimize2 size={16} />
            </Control>
            <Control label={fullscreen ? 'Exit full screen (F)' : 'Full screen (F)'} onClick={toggleFullscreen} dark>
              {fullscreen ? <Minimize size={16} /> : <Fullscreen size={16} />}
            </Control>
          </div>
        </div>
      ) : (
        <>
          {transport}
          {time}
          {scrubber}
          {volume}
          {speed}
          <Control label="Expand video" onClick={onToggleExpanded}>
            <Maximize2 size={16} />
          </Control>
        </>
      )}
    </div>
  );
}

function Control({
  label,
  onClick,
  dark,
  primary,
  children,
}: {
  label: string;
  onClick: () => void;
  dark?: boolean;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-full transition-colors',
        primary ? 'h-9 w-9' : 'h-8 w-8',
        dark
          ? 'text-white hover:bg-white/15'
          : primary
            ? 'bg-accent text-on-accent hover:bg-accent-hover'
            : 'text-muted hover:bg-hover hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

// The circular arrow with the size of the jump inside it.
function SkipIcon({ icon: Icon }: { icon: typeof RotateCcw }) {
  return (
    <span className="relative flex h-[22px] w-[22px] items-center justify-center">
      <Icon size={22} strokeWidth={1.75} />
      <span className="absolute inset-0 flex items-center justify-center text-[8.5px] font-semibold">5</span>
    </span>
  );
}

// A native slider for keyboard and screen readers, drawn over a wider track that
// shows the position and the time under the mouse.
function Scrubber({ currentMs, lengthMs, dark, onSeek }: { currentMs: number; lengthMs: number; dark?: boolean; onSeek: (ms: number) => void }) {
  const [hover, setHover] = useState<{ x: number; ms: number } | null>(null);
  const percent = lengthMs ? Math.min(100, (currentMs / lengthMs) * 100) : 0;
  return (
    <div
      className={clsx('group/scrub relative flex h-6 items-center', dark ? 'w-full' : 'min-w-32 flex-1')}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        setHover({ x, ms: lengthMs * (x / rect.width) });
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div className={clsx('h-1 w-full overflow-hidden rounded-full transition-[height] group-hover/scrub:h-1.5', dark ? 'bg-white/30' : 'bg-fill-strong')}>
        <div className={clsx('h-full', dark ? 'bg-white' : 'bg-accent')} style={{ width: `${percent}%` }} />
      </div>
      <div
        className={clsx('pointer-events-none absolute h-3 w-3 -translate-x-1/2 rounded-full shadow-sm', dark ? 'bg-white' : 'bg-accent')}
        style={{ left: `${percent}%` }}
      />
      <input
        type="range"
        aria-label="Position"
        min={0}
        max={Math.max(1, lengthMs)}
        step={1000}
        value={Math.min(currentMs, lengthMs)}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0"
      />
      {hover && lengthMs > 0 && (
        <span
          className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-white tabular-nums"
          style={{ left: hover.x }}
        >
          {formatTimestamp(hover.ms)}
        </span>
      )}
    </div>
  );
}
