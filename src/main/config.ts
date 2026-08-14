/**
 * User configuration.
 *
 * Plain JSON in `userData`, deep-merged over defaults on read. Merging rather
 * than replacing matters for forward compatibility: a config written by an
 * older build is missing whatever keys we added since, and the alternative to
 * merging is a migration for every new setting.
 *
 * Secrets never appear here. See secrets.ts.
 */

import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { merge } from '../shared/merge.ts';
import type { AnnaConfig } from '../shared/protocol.ts';

export const DEFAULT_CONFIG: AnnaConfig = {
  llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
  tts: { provider: 'cartesia', voiceId: '' },
  stt: { provider: 'deepgram' },
  avatar: { renderer: 'vrm', modelPath: '' },
  senses: {
    // Camera and microphone start off. A companion that switches on your camera
    // the first time you launch her has already lost the argument.
    camera: false,
    microphone: false,
    screenActivity: true,
    calendar: false,
    cameraIntervalSeconds: 45,
  },
  presence: {
    proactive: true,
    minMinutesBetweenOpeners: 25,
    quietHours: [1, 8],
  },
};

export class Config {
  readonly #path: string;
  #value: AnnaConfig;

  constructor(path = join(app.getPath('userData'), 'config.json')) {
    this.#path = path;
    this.#value = this.#read();
  }

  get(): AnnaConfig {
    return this.#value;
  }

  update(patch: DeepPartial<AnnaConfig>): AnnaConfig {
    this.#value = merge(this.#value, patch);
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify(this.#value, null, 2));
    return this.#value;
  }

  #read(): AnnaConfig {
    try {
      return merge(DEFAULT_CONFIG, JSON.parse(readFileSync(this.#path, 'utf8')));
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export { merge } from '../shared/merge.ts';
