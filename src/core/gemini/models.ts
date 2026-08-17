/**
 * Which Live model can do what.
 *
 * Sending a config field a model does not accept is not a soft failure — the
 * setup is rejected and the socket closes, which looks to a user exactly like
 * "the app is broken". So capabilities are declared here and the session strips
 * anything the chosen model cannot take.
 *
 * As documented by Google:
 *
 *   gemini-2.5-flash-native-audio-preview-12-2025
 *     Native audio. Supports affective dialog and proactive audio.
 *   gemini-3.1-flash-live-preview
 *     Newer, native audio, thinking. Affective dialog and proactive audio are
 *     documented as not yet supported.
 *
 * ## Why the default is 3.1, despite 2.5 having the feature we wanted
 *
 * Measured, not read. On `gemini-2.5-flash-native-audio-preview-12-2025`,
 * **function declarations combined with audio input close the socket with
 * `1011 Internal error occurred.`** Reproduced every time, and narrowed by
 * bisection:
 *
 *     tools + text input     works
 *     audio input, no tools  works
 *     tools + audio input    1011, immediately, on every attempt
 *
 * The same session config on `gemini-3.1-flash-live-preview` works with one
 * tool and with all of them.
 *
 * That is not a trade worth making. Her tools are how she feels, remembers,
 * sends a picture and moves her face; a model that drops the connection the
 * moment a user *speaks to her with tools attached* has no working voice path
 * at all. `enableAffectiveDialog` — mood carried in the voice rather than only
 * in word choice — is the thing 2.5 was chosen for, and it is a refinement of a
 * feature, not the feature.
 *
 * So: 3.1 by default, mood still reaches her through the prompt, and
 * `HERS_MODEL` will still select 2.5 for anyone who wants affective dialog and
 * can live without tools on the voice path.
 */

export interface ModelCapabilities {
  affectiveDialog: boolean;
  proactiveAudio: boolean;
  /** Native-audio models take `speechConfig`; all Live models here do. */
  nativeAudio: boolean;
  /**
   * Whether function declarations survive being combined with audio input.
   *
   * A strange thing to have to record about a model, and it is here because one
   * of them does not.
   */
  toolsWithAudio: boolean;
}

const CAPABILITIES: Record<string, ModelCapabilities> = {
  'gemini-2.5-flash-native-audio-preview-12-2025': {
    affectiveDialog: true,
    proactiveAudio: true,
    nativeAudio: true,
    // See the header: tools plus audio input is a 1011 on this model.
    toolsWithAudio: false,
  },
  'gemini-3.1-flash-live-preview': {
    affectiveDialog: false,
    proactiveAudio: false,
    nativeAudio: true,
    toolsWithAudio: true,
  },
};

export const DEFAULT_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

export const KNOWN_LIVE_MODELS = Object.keys(CAPABILITIES);

/**
 * Unknown models get the conservative answer rather than an optimistic one.
 *
 * Someone will set `HERS_MODEL` to something released after this file was
 * written, and the failure mode for guessing "yes" is a session that will not
 * open at all. Guessing "no" costs a feature and still talks.
 */
export function capabilitiesOf(model: string): ModelCapabilities {
  return (
    CAPABILITIES[model] ?? {
      affectiveDialog: false,
      proactiveAudio: false,
      nativeAudio: true,
      // Optimistic on this one alone: refusing tools by default would silently
      // disable half of her behaviour on every model released after this file.
      toolsWithAudio: true,
    }
  );
}
