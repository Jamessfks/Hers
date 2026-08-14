/** Provider registry. The only place the rest of the app names a vendor. */

import type { LlmProviderId } from '../../shared/protocol.ts';
import { createAnthropicProvider } from './anthropic.ts';
import { createGoogleProvider } from './google.ts';
import { createOpenAiProvider } from './openai.ts';
import type { LlmProvider } from './types.ts';

export type { ChatMessage, CompletionRequest, LlmProvider } from './types.ts';
export { LlmError } from './types.ts';

const FACTORIES: Record<LlmProviderId, (key: string) => LlmProvider> = {
  anthropic: createAnthropicProvider,
  openai: createOpenAiProvider,
  google: createGoogleProvider,
};

export function createLlmProvider(id: LlmProviderId, apiKey: string): LlmProvider {
  const factory = FACTORIES[id];
  if (!factory) throw new Error(`Unknown LLM provider: ${id}`);
  return factory(apiKey);
}

/** Metadata for the settings screen, without instantiating anything. */
export const LLM_PROVIDER_INFO: ReadonlyArray<{
  id: LlmProviderId;
  label: string;
  keyUrl: string;
  keyPrefix: string;
}> = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
  },
  {
    id: 'google',
    label: 'Google (Gemini)',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPrefix: 'AIza',
  },
];
