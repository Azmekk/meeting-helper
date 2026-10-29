// A single timed piece of text as returned by a provider (a word, sub-word, or spacing).
export type Token = {
  text: string;
  startMs: number;
  endMs: number;
  speaker?: string;
  language?: string;
};

// Consecutive tokens from one speaker, grouped the way the app will store them.
export type Segment = {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
};

export type Options = {
  // Language codes, most likely first (e.g. ["bg", "en"]). Empty = auto-detect.
  languages: string[];
  // Upper bound on speakers, if known. Only ElevenLabs accepts this.
  maxSpeakers?: number;
  // Names, jargon and product terms to bias recognition towards.
  terms: string[];
};

export type Parsed = {
  tokens: Token[];
  durationSec?: number;
  detectedLanguage?: string;
};

export type Provider = {
  name: string;
  model: string;
  envKey: string;
  // Published list price for batch transcription, used for the cost estimate only.
  usdPerHour: number;
  transcribe(file: string, opts: Options, apiKey: string): Promise<unknown>;
  parse(raw: any): Parsed;
};
