/**
 * Which Live model can do what.
 *
 * Sending a config field a model does not accept is not a soft failure — the
 * setup is rejected and the socket closes, which looks to a user exactly like
 * "Anna is broken". So capabilities are declared here and the session strips
 * anything the chosen model cannot take.
 *
 * Facts as documented by Google at the time of writing:
 *
 *   gemini-2.5-flash-native-audio-preview-12-2025
 *     Native audio. Supports affective dialog and proactive audio.
 *   gemini-3.1-flash-live-preview
 *     Newer, native audio, thinking. Affective dialog and proactive audio are
 *     explicitly *not yet supported*, and function calling is synchronous only.
 *
 * Anna defaults to the 2.5 native-audio model, and the reason is narrow: mood
 * is a headline feature here, and `enableAffectiveDialog` is what puts the mood
 * in her actual voice rather than only in her word choice. Set `ANNA_MODEL` to
 * the 3.1 model to trade that for the newer model's reasoning.
 */

export interface ModelCapabilities {
  affectiveDialog: boolean;
  proactiveAudio: boolean;
  /** Native-audio models take `speechConfig`; all Live models here do. */
  nativeAudio: boolean;
}

const CAPABILITIES: Record<string, ModelCapabilities> = {
  'gemini-2.5-flash-native-audio-preview-12-2025': {
    affectiveDialog: true,
    proactiveAudio: true,
    nativeAudio: true,
  },
  'gemini-3.1-flash-live-preview': {
    affectiveDialog: false,
    proactiveAudio: false,
    nativeAudio: true,
  },
};

export const DEFAULT_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

export const KNOWN_LIVE_MODELS = Object.keys(CAPABILITIES);

/**
 * Unknown models get the conservative answer rather than an optimistic one.
 *
 * Someone will set `ANNA_MODEL` to something released after this file was
 * written, and the failure mode for guessing "yes" is a session that will not
 * open at all. Guessing "no" costs a feature and still talks.
 */
export function capabilitiesOf(model: string): ModelCapabilities {
  return (
    CAPABILITIES[model] ?? {
      affectiveDialog: false,
      proactiveAudio: false,
      nativeAudio: true,
    }
  );
}
