/**
 * The settings window.
 *
 * Three rules this file follows, all of which come from the same place — this
 * is the screen standing between a new user and a working companion:
 *
 *  1. **Every control writes immediately.** There is no Save button. A
 *     preferences pane with one invites you to lose work by closing the window,
 *     and there is nothing here that needs to be applied atomically.
 *  2. **A key is checked before it is stored.** Storing first and failing later
 *     produces the worst outcome available: an app that looks configured and
 *     then goes mute, with the real error in a log nobody opens.
 *  3. **Permissions are reported as observed, not as requested.** macOS never
 *     tells an app that a permission was revoked; the call just starts failing.
 *     Anna's sensors fail soft, which is correct and undebuggable, so this
 *     screen probes for the truth and offers the exact System Settings pane.
 */

import { MODEL_CATALOG, resolveModel, type ModelOption } from '../core/llm/models.ts';
import type {
  AnnaConfig,
  LibraryView,
  LlmProviderId,
  MemoryFactView,
  PermissionReport,
  VideoProviderView,
} from '../shared/protocol.ts';

/** Sentinel option value for "let me type a model id myself". */
const CUSTOM = '__custom__';

/**
 * Slots in a full clip library: idle plus the eighteen gestures.
 *
 * Duplicated from core/avatar/clips.ts rather than imported, because importing
 * it would pull `node:fs` into the settings bundle through the manual provider.
 * The estimate itself is computed in main against the real list; this is only
 * used to divide it back down to a per-clip figure.
 */
const CLIP_COUNT = 19;

declare global {
  interface Window {
    anna: import('../preload/index.ts').AnnaApi;
  }
}

const api = window.anna;

/** Provider menus, with the reason each one is worth choosing. */
interface ProviderEntry {
  id: string;
  label: string;
  url: string;
  why?: string;
  keyless?: boolean;
}

/**
 * `video` starts empty and is filled from main at boot.
 *
 * The other three are static because their provider lists are: three model
 * vendors, three voice vendors, three transcribers, all known at compile time.
 * The video list carries a *price* per provider, and a price is a property of
 * the adapter — Runway publishes a rate card, Hedra refuses to quote before
 * ingest — so hardcoding it here is how it goes stale without anyone noticing.
 */
const PROVIDERS: Record<Kind, ProviderEntry[]> = {
  llm: [
    { id: 'anthropic', label: 'Anthropic (Claude)', url: 'https://console.anthropic.com/settings/keys' },
    { id: 'openai', label: 'OpenAI', url: 'https://platform.openai.com/api-keys' },
    { id: 'google', label: 'Google (Gemini)', url: 'https://aistudio.google.com/apikey' },
  ],
  tts: [
    {
      id: 'cartesia',
      label: 'Cartesia Sonic',
      url: 'https://play.cartesia.ai/keys',
      why: 'Fastest to first sound, around 90ms. The default, because latency is the thing you feel.',
    },
    {
      id: 'elevenlabs',
      label: 'ElevenLabs',
      url: 'https://elevenlabs.io/app/settings/api-keys',
      why: 'The most expressive voices anywhere. Slightly slower, noticeably more alive.',
    },
    {
      id: 'hume',
      label: 'Hume Octave',
      url: 'https://platform.hume.ai/settings/keys',
      why: 'Takes an acting note per line, so Anna directs her own delivery.',
    },
  ],
  video: [],
  stt: [
    {
      id: 'apple',
      label: 'This Mac (on-device)',
      url: '',
      keyless: true,
      why: 'No key, no account, no network. macOS transcribes you on this machine and the audio never leaves it. Works on a plane.',
    },
    {
      id: 'deepgram',
      label: 'Deepgram',
      url: 'https://console.deepgram.com',
      why: 'More accurate on strong accents and noisy rooms. Your voice is sent to Deepgram.',
    },
    {
      id: 'openai',
      label: 'OpenAI Whisper',
      url: 'https://platform.openai.com/api-keys',
      why: 'Best on languages other than English. Your voice is sent to OpenAI.',
    },
  ],
};

/**
 * Where each kind's provider lives in the config.
 *
 * Three of the four sit at `config[kind].provider`, which is why the original
 * `keyGroup` could index straight into the config with the kind. The video
 * provider does not — it belongs to `avatar`, alongside the photograph it
 * renders clips for. Rather than fork the whole key-group into a second
 * near-identical copy for one field name, the path is a parameter.
 */
const PROVIDER_FIELD: Record<Kind, { read(): string; patch(value: string): Record<string, unknown> }> = {
  llm: { read: () => config.llm.provider, patch: (value) => ({ llm: { provider: value } }) },
  tts: { read: () => config.tts.provider, patch: (value) => ({ tts: { provider: value } }) },
  stt: { read: () => config.stt.provider, patch: (value) => ({ stt: { provider: value } }) },
  video: {
    read: () => config.avatar.videoProvider,
    patch: (value) => ({ avatar: { videoProvider: value } }),
  },
};

type Kind = 'llm' | 'tts' | 'stt' | 'video';

let config: AnnaConfig;
let permissions: PermissionReport | null = null;
let videoProviders: VideoProviderView[] = [];

const $ = <T extends HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector) as T;

// ---------------------------------------------------------------------------
// Config writes
// ---------------------------------------------------------------------------

/** Writes a patch and keeps the local copy in step. */
async function patch(update: Record<string, unknown>): Promise<void> {
  config = await api.setConfig(update);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function keyGroup(kind: Kind): void {
  const group = $(`.key-group[data-kind="${kind}"]`);
  const select = group.querySelector<HTMLSelectElement>('[data-provider]')!;
  const input = group.querySelector<HTMLInputElement>('[data-key]')!;
  const button = group.querySelector<HTMLButtonElement>('[data-save]')!;
  const reveal = group.querySelector<HTMLButtonElement>('[data-reveal]')!;
  const forget = group.querySelector<HTMLButtonElement>('[data-forget]')!;
  const status = group.querySelector<HTMLParagraphElement>('[data-status]')!;
  const why = group.querySelector<HTMLParagraphElement>('[data-why]');

  for (const provider of PROVIDERS[kind]) {
    select.append(new Option(provider.label, provider.id));
  }
  select.value = PROVIDER_FIELD[kind].read();

  const currentProvider = () =>
    PROVIDERS[kind].find((entry) => entry.id === select.value);

  /** Reflects what is stored for the selected provider. */
  const describe = async (): Promise<void> => {
    const chosen = currentProvider();
    if (why && chosen?.why) why.textContent = chosen.why;

    /*
     * A provider that needs no key gets no key field.
     *
     * Leaving the row visible and inert is the usual shortcut and it is a lie:
     * an empty box next to "Check & save" reads as something you have not
     * finished, and the whole point of the on-device option is that there is
     * nothing left to do.
     */
    if (chosen?.keyless) {
      for (const control of [input, button, reveal, forget]) control.hidden = true;
      status.dataset['tone'] = 'good';
      status.textContent = 'Ready. No key needed, and nothing is sent anywhere.';
      return;
    }
    for (const control of [input, button, reveal]) control.hidden = false;

    const stored = await api.keyStatus();
    const entry = stored[`${kind}.${select.value}`];
    const present = entry?.present ?? false;

    forget.hidden = !present;
    input.placeholder = present ? 'replace key' : 'paste key';
    input.value = '';
    input.type = 'password';
    reveal.textContent = '👁';

    if (present) {
      status.dataset['tone'] = 'good';
      status.textContent = `Saved and working — ${entry?.hint ?? ''}`;
    } else {
      delete status.dataset['tone'];
      status.replaceChildren();
      if (chosen) {
        status.append('Needs a key. ');
        // A real link, opened in the actual browser by the main process. A
        // hostname you have to retype is a hostname nobody visits.
        const link = document.createElement('a');
        link.href = chosen.url;
        link.textContent = `Get one at ${hostOf(chosen.url)}`;
        link.target = '_blank';
        link.rel = 'noreferrer';
        status.append(link);
      }
    }
  };

  /**
   * Switching provider.
   *
   * The model has to be re-resolved here rather than carried over — this is the
   * exact path that used to leave `claude-sonnet-5` configured against OpenAI.
   */
  select.addEventListener('change', async () => {
    await patch(PROVIDER_FIELD[kind].patch(select.value));
    await describe();
    if (kind === 'llm') await loadModels({ refetch: true });
    if (kind === 'tts') await loadVoices();
    await refreshStatus();
  });

  reveal.addEventListener('click', () => {
    // Reveal is for checking a paste, not for reading back a stored key —
    // there is nothing in the field to reveal unless you just typed it.
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    reveal.textContent = showing ? '👁' : '🙈';
    input.focus();
  });

  const save = async (): Promise<void> => {
    const key = input.value.trim();
    if (!key) return;

    button.disabled = true;
    button.classList.add('busy');
    const label = button.textContent;
    button.textContent = 'Checking…';
    delete status.dataset['tone'];
    status.textContent = `Asking ${select.options[select.selectedIndex]?.text} whether this key works…`;

    const result = await api.validateAndSetKey(kind, select.value, key);

    button.disabled = false;
    button.classList.remove('busy');
    button.textContent = label;

    if (result.ok) {
      await describe();
      if (kind === 'llm') await loadModels({ refetch: true });
      if (kind === 'tts') await loadVoices();
    } else {
      status.dataset['tone'] = 'bad';
      status.textContent = result.reason;
    }
    await refreshStatus();
  };

  button.addEventListener('click', () => void save());
  input.addEventListener('keydown', (event) => {
    // Enter submits, because that is what everyone does after pasting a key.
    if (event.key === 'Enter') void save();
  });

  /**
   * Warn about a key that is obviously in the wrong box.
   *
   * Three key fields on one screen and three vendors with distinct prefixes:
   * pasting the Anthropic key into the OpenAI field is the single most common
   * mistake here, and "401 authentication_error" is a terrible way to find out.
   */
  input.addEventListener('input', async () => {
    if (!input.value.trim()) {
      if (status.dataset['tone'] === 'bad') await describe();
      return;
    }
    const warning = await api.keyShape(`${kind}.${select.value}`, input.value);
    if (warning) {
      status.dataset['tone'] = 'bad';
      status.textContent = warning;
    } else if (status.dataset['tone'] === 'bad') {
      delete status.dataset['tone'];
      status.textContent = '';
    }
  });

  forget.addEventListener('click', async () => {
    await api.deleteKey(`${kind}.${select.value}`);
    await describe();
    if (kind === 'llm') await loadModels({ refetch: true });
    if (kind === 'tts') await loadVoices();
    await refreshStatus();
  });

  void describe();
}

/**
 * Populates the model picker for the current provider.
 *
 * This is where the original bug lived. The old version wrote
 * `config.llm.model` straight into the field, so switching provider from
 * Anthropic to OpenAI left `claude-sonnet-5` selected — and every request then
 * failed with a vendor error nobody would trace back to a dropdown they had
 * touched a minute earlier.
 *
 * Now the model is *resolved* rather than carried: {@link resolveModel} can
 * never return a model belonging to another vendor, and when the live list is
 * available the answer is always something the account actually has.
 */
async function loadModels(options: { refetch?: boolean } = {}): Promise<void> {
  const select = $<HTMLSelectElement>('#llm-model');
  const note = $('#llm-model-note');
  const provider = config.llm.provider;

  if (options.refetch) {
    select.replaceChildren(new Option('Loading…', ''));
    select.disabled = true;
  }

  const live = await api.listModels(provider).catch((): ModelOption[] => []);
  const fromCatalogue = live.length === 0;
  const models: ModelOption[] = fromCatalogue
    ? MODEL_CATALOG[provider].map((id) => ({ id, label: id }))
    : live;

  const chosen = resolveModel({
    provider,
    current: config.llm.model,
    ...(config.llm.modelByProvider && { remembered: config.llm.modelByProvider }),
    // An empty live list means "could not fetch", not "this account has none",
    // so it must not constrain the choice.
    ...(fromCatalogue ? {} : { available: models.map((model) => model.id) }),
  });

  select.replaceChildren();
  for (const model of models) {
    select.append(new Option(model.label, model.id));
  }
  // A custom or fine-tuned id the list does not include still has to be
  // selectable, or opening settings would silently discard it.
  if (chosen && !models.some((model) => model.id === chosen)) {
    select.append(new Option(`${chosen} (custom)`, chosen));
  }
  select.append(new Option('Custom id…', CUSTOM));

  select.value = chosen;
  select.disabled = false;

  note.textContent = fromCatalogue
    ? 'Built-in list. Add a key above to see what your account can actually use.'
    : `${live.length} ${live.length === 1 ? 'model' : 'models'} on your account.`;
  delete note.dataset['tone'];

  if (chosen !== config.llm.model) await rememberModel(chosen);
}

/** Writes the model, and remembers it for this provider. */
async function rememberModel(model: string): Promise<void> {
  await patch({
    llm: {
      model,
      modelByProvider: { ...config.llm.modelByProvider, [config.llm.provider]: model },
    },
  });
}

function wireModelPicker(): void {
  const select = $<HTMLSelectElement>('#llm-model');
  const customRow = $<HTMLDivElement>('#llm-model-custom-row');
  const custom = $<HTMLInputElement>('#llm-model-custom');

  select.addEventListener('change', async () => {
    if (select.value === CUSTOM) {
      customRow.hidden = false;
      custom.value = config.llm.model;
      custom.focus();
      return;
    }
    customRow.hidden = true;
    await rememberModel(select.value);
    await refreshStatus();
  });

  const commitCustom = async (): Promise<void> => {
    const value = custom.value.trim();
    if (!value) return;
    await rememberModel(value);
    await loadModels();
    await refreshStatus();
  };
  custom.addEventListener('change', commitCustom);
  custom.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void commitCustom();
  });

  $<HTMLButtonElement>('#llm-model-refresh').addEventListener('click', () => {
    void loadModels({ refetch: true });
  });
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

async function loadVoices(): Promise<void> {
  const select = $<HTMLSelectElement>('#voice-id');
  const preview = $<HTMLButtonElement>('#voice-preview');

  select.replaceChildren(new Option('Loading voices…', ''));
  select.disabled = true;
  preview.disabled = true;

  const voices = await api.listVoices(config.tts.provider);
  select.replaceChildren();

  if (voices.length === 0) {
    select.append(new Option('Add a key to see voices', ''));
    return;
  }

  for (const voice of voices) {
    const option = new Option(voice.name, voice.id);
    if (voice.description) option.title = voice.description;
    select.append(option);
  }

  // Nothing chosen yet: take the first, so she can actually speak. A voice
  // provider with no voice selected is a companion that silently says nothing.
  const chosen = voices.some((voice) => voice.id === config.tts.voiceId)
    ? config.tts.voiceId
    : (voices[0]?.id ?? '');
  select.value = chosen;
  select.disabled = false;
  preview.disabled = !chosen;

  if (chosen !== config.tts.voiceId) await patch({ tts: { voiceId: chosen } });
  await refreshStatus();
}

function wireVoice(): void {
  const select = $<HTMLSelectElement>('#voice-id');
  const preview = $<HTMLButtonElement>('#voice-preview');

  select.addEventListener('change', async () => {
    await patch({ tts: { voiceId: select.value } });
    preview.disabled = !select.value;
    await refreshStatus();
  });

  preview.addEventListener('click', async () => {
    preview.disabled = true;
    const label = preview.textContent;
    preview.textContent = 'Fetching…';

    const result = await api.previewVoice(config.tts.provider, select.value);
    preview.textContent = label;
    preview.disabled = false;

    if ('error' in result) {
      const status = $('.key-group[data-kind="tts"] [data-status]');
      status.dataset['tone'] = 'bad';
      status.textContent = result.error;
      return;
    }

    const context = new AudioContext();
    const buffer = context.createBuffer(1, result.pcm.length, result.sampleRate);
    buffer.copyToChannel(new Float32Array(result.pcm) as Float32Array<ArrayBuffer>, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    source.onended = () => void context.close();
  });
}

// ---------------------------------------------------------------------------
// Her body
// ---------------------------------------------------------------------------

/**
 * The photograph, the provider that animates it, and the spend so far.
 *
 * The key input itself is not here — it is a `.key-group[data-kind="video"]` in
 * the markup, driven by the same {@link keyGroup} that drives the model, voice
 * and hearing keys. This wires the three things a video provider needs that a
 * text one does not: a photograph to work from, a folder for the provider that
 * has no API at all, and a price shown *before* the button that spends money.
 */
function wireBody(): void {
  const button = $<HTMLButtonElement>('#pick-portrait');
  const name = $('#portrait-name');
  const preview = $<HTMLImageElement>('#portrait-preview');
  const build = $<HTMLButtonElement>('#build-clip');
  const status = $('#library-status');
  const price = $('#library-price');
  const providerSelect = $<HTMLSelectElement>('#video-provider');
  const folderRow = $<HTMLDivElement>('#clip-folder-row');
  const folderButton = $<HTMLButtonElement>('#pick-clip-folder');
  const folderName = $('#clip-folder-name');

  /**
   * Shows the photograph back to the user.
   *
   * Worth the round trip for the bytes rather than showing a filename: the
   * whole avatar is this one frame, and "did it take the right picture" is a
   * question only a picture answers.
   */
  const showPortrait = async (): Promise<void> => {
    const bytes = await api.getPortrait();
    if (!bytes) {
      name.textContent = 'No photo yet';
      preview.hidden = true;
      return;
    }
    preview.src = URL.createObjectURL(new Blob([bytes as BlobPart]));
    preview.hidden = false;
    name.textContent = 'This is her';
  };

  /**
   * What the chosen provider would charge for a full library.
   *
   * Shown next to the button rather than after the first invoice, and phrased
   * differently depending on how well the number is actually known — a
   * published rate card gets a figure, a vendor that will not quote gets a
   * range and the word "somewhere". Presenting both with the same confidence is
   * the part that would mislead.
   */
  const showPrice = (): void => {
    const chosen = videoProviders.find((entry) => entry.id === providerSelect.value);
    if (!chosen) {
      price.textContent = '';
      return;
    }

    folderRow.hidden = !chosen.keyless;
    folderName.textContent = config.avatar.clipFolder || 'No folder chosen';

    if (chosen.keyless) {
      price.textContent =
        'Nothing is charged here — you render the clips yourself and drop them in the folder.';
      return;
    }
    if (!chosen.wired) {
      price.textContent = 'This one is not wired up in this build. Pick Hedra or Runway.';
      return;
    }
    price.textContent = chosen.estimate.confident
      ? `A full library of ${CLIP_COUNT} clips costs about $${chosen.estimate.low.toFixed(2)}. One clip is about $${(chosen.estimate.low / CLIP_COUNT).toFixed(2)}.`
      : `${chosen.label} will not quote a price before rendering. A full library is somewhere between $${chosen.estimate.low.toFixed(2)} and $${chosen.estimate.high.toFixed(2)}.`;
  };

  /**
   * Says what exists, what is running, and what has been spent.
   *
   * The spend is shown even when it is zero. This is the one screen in the app
   * behind which a bill accumulates, and a number that only appears once it is
   * large is a number nobody was watching.
   */
  const showLibrary = (view: LibraryView): void => {
    if (!view.portrait) {
      status.textContent = 'No photo yet';
      build.disabled = true;
      return;
    }
    build.disabled = view.building !== null;

    const spent = view.spentUsd > 0 ? ` · $${view.spentUsd.toFixed(2)} spent` : '';
    if (view.building) {
      status.textContent = `Rendering ${view.building}… (minutes, not seconds)${spent}`;
    } else if (view.ready.length === 0) {
      status.textContent = `No clips yet — she is the photograph${spent}`;
    } else {
      const failed = view.failed.length > 0 ? `, ${view.failed.length} failed` : '';
      status.textContent = `${view.ready.length} of ${view.total} clips${failed}${spent}`;
    }
  };

  button.addEventListener('click', async () => {
    const result = await api.pickPortrait();
    if (!result) return;
    if ('error' in result) {
      name.textContent = result.error;
      return;
    }
    await showPortrait();
    // The note is advice, not a failure — an unusual crop is allowed, it just
    // decides the shape of every clip, so it is said once and not repeated.
    if (result.note) status.textContent = result.note;
    showLibrary(await api.libraryStatus());
  });

  folderButton.addEventListener('click', async () => {
    const picked = await api.pickClipFolder();
    if (!picked) return;
    config = await api.getConfig();
    folderName.textContent = picked.folder;
  });

  build.addEventListener('click', async () => {
    build.disabled = true;
    status.textContent = 'Starting…';
    // One. The first clip answers questions the other eighteen depend on, and
    // rendering them all before looking at one bills for the same lesson
    // nineteen times.
    showLibrary(await api.buildLibrary(1));
  });

  // The price follows the provider menu, which `keyGroup` also listens to. Two
  // listeners on one select rather than a callback threaded through keyGroup:
  // they are independent concerns and the ordering between them does not matter.
  providerSelect.addEventListener('change', showPrice);

  api.onLibrary(showLibrary);
  showPrice();
  void showPortrait();
  void api.libraryStatus().then(showLibrary);
}

// ---------------------------------------------------------------------------
// Senses
// ---------------------------------------------------------------------------

interface ToggleSpec {
  title: string;
  note: string;
  get(): boolean;
  set(value: boolean): Promise<void>;
  permission?: keyof PermissionReport;
}

function renderToggles(target: HTMLElement, specs: ToggleSpec[]): void {
  target.replaceChildren();

  for (const spec of specs) {
    const item = document.createElement('li');
    item.className = 'toggle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = spec.get();
    checkbox.id = `toggle-${spec.title.replace(/\s+/g, '-').toLowerCase()}`;

    const text = document.createElement('label');
    text.className = 'toggle-text';
    text.htmlFor = checkbox.id;

    const title = document.createElement('span');
    title.className = 'toggle-title';
    title.textContent = spec.title;

    const note = document.createElement('span');
    note.className = 'toggle-note';
    note.textContent = spec.note;

    text.append(title, note);

    if (spec.permission && permissions) {
      const value = permissions[spec.permission];
      const granted = value === true || value === 'granted';
      // 'not-determined' is not a failure — macOS simply has not asked yet, and
      // it will ask the moment the sensor first runs. Saying "denied" here
      // would send people into System Settings to fix nothing.
      const undecided = value === 'not-determined' || value === 'unknown';
      if (!undecided) {
        const pill = document.createElement('span');
        pill.className = 'perm';
        pill.dataset['granted'] = String(granted);
        pill.textContent = granted ? 'permission granted' : 'macOS is blocking this';
        if (!granted) {
          const open = document.createElement('button');
          open.type = 'button';
          open.textContent = 'Open System Settings';
          open.addEventListener('click', () =>
            api.openPrivacyPane(String(spec.permission) === 'accessibility' ? 'accessibility' : String(spec.permission)),
          );
          pill.append(open);
        }
        note.append(' ', pill);
      }
    }

    checkbox.addEventListener('change', async () => {
      await spec.set(checkbox.checked);
    });

    item.append(checkbox, text);
    target.append(item);
  }
}

function sensesToggles(): ToggleSpec[] {
  return [
    {
      title: 'Screen activity',
      note: 'Which app you are in and how long since you last touched the keyboard. No keystrokes are read.',
      permission: 'accessibility',
      get: () => config.senses.screenActivity,
      set: (value) => patch({ senses: { screenActivity: value } }),
    },
    {
      title: 'Camera',
      note: 'One downscaled frame on a slow timer, turned into a sentence like "slumped, rubbing their eyes". The frame is never stored.',
      permission: 'camera',
      get: () => config.senses.camera,
      set: (value) => patch({ senses: { camera: value } }),
    },
    {
      title: 'Microphone',
      note: 'Talk to her out loud. Audio only leaves your machine when you actually speak.',
      permission: 'microphone',
      get: () => config.senses.microphone,
      set: (value) => patch({ senses: { microphone: value } }),
    },
    {
      title: 'Calendar',
      note: 'The next thing in the following four hours, so she knows what you are walking into.',
      permission: 'calendar',
      get: () => config.senses.calendar,
      set: (value) => patch({ senses: { calendar: value } }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

function wirePresence(): void {
  renderToggles($('#presence-toggles'), [
    {
      title: 'Let her speak first',
      note: 'She opens only when something is worth mentioning, and never twice for the same reason.',
      get: () => config.presence.proactive,
      set: (value) => patch({ presence: { proactive: value } }),
    },
  ]);

  const gap = $<HTMLInputElement>('#opener-gap');
  const gapOut = $<HTMLOutputElement>('#opener-gap-out');
  gap.value = String(config.presence.minMinutesBetweenOpeners);
  gapOut.textContent = `${gap.value} minutes`;
  gap.addEventListener('input', () => {
    gapOut.textContent = `${gap.value} minutes`;
  });
  gap.addEventListener('change', () =>
    patch({ presence: { minMinutesBetweenOpeners: Number(gap.value) } }),
  );

  const from = $<HTMLInputElement>('#quiet-from');
  const to = $<HTMLInputElement>('#quiet-to');
  const quiet = config.presence.quietHours ?? [1, 8];
  from.value = String(quiet[0]);
  to.value = String(quiet[1]);

  const writeQuiet = (): Promise<void> =>
    patch({
      presence: {
        quietHours: [clampHour(from.value), clampHour(to.value)] as [number, number],
      },
    });
  from.addEventListener('change', writeQuiet);
  to.addEventListener('change', writeQuiet);

  const interval = $<HTMLInputElement>('#camera-interval');
  const intervalOut = $<HTMLOutputElement>('#camera-interval-out');
  interval.value = String(config.senses.cameraIntervalSeconds);
  const showInterval = (): void => {
    const seconds = Number(interval.value);
    intervalOut.textContent =
      seconds < 60 ? `every ${seconds} seconds` : `every ${Math.round(seconds / 60)} minutes`;
  };
  showInterval();
  interval.addEventListener('input', showInterval);
  interval.addEventListener('change', () =>
    patch({ senses: { cameraIntervalSeconds: Number(interval.value) } }),
  );
}

function clampHour(value: string): number {
  const hour = Number.parseInt(value, 10);
  return Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 0;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

async function renderMemory(): Promise<void> {
  const stats = await api.memoryStats();
  const line = $('#memory-stats');

  if (stats.turns === 0) {
    line.textContent = 'Nothing yet. She starts remembering the first time you talk to her.';
  } else {
    const since = stats.since ? new Date(stats.since).toLocaleDateString() : 'recently';
    line.textContent = `${stats.facts} ${plural(stats.facts, 'thing')} she knows about you, distilled from ${stats.turns} ${plural(stats.turns, 'turn')} since ${since}.`;
  }

  const summary = $('#memory-summary');
  summary.textContent = stats.summary ? `Lately: ${stats.summary.split('\n')[0]}` : '';

  const list = $('#facts');
  const facts = await api.memoryFacts(200);
  list.replaceChildren();
  for (const fact of facts) list.append(factRow(fact, list));
}

function factRow(fact: MemoryFactView, list: HTMLElement): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'fact';

  const kind = document.createElement('span');
  kind.className = 'fact-kind';
  kind.textContent = fact.kind;

  const text = document.createElement('span');
  text.className = 'fact-text';
  text.textContent = fact.text;

  const meta = document.createElement('span');
  meta.className = 'fact-meta';
  meta.textContent = `used ${fact.recallCount}×`;

  const forget = document.createElement('button');
  forget.type = 'button';
  forget.textContent = 'Forget';
  forget.addEventListener('click', async () => {
    await api.forgetFact(fact.id);
    item.remove();
    if (list.children.length === 0) await renderMemory();
  });

  item.append(kind, text, meta, forget);
  return item;
}

function wireWipe(): void {
  const button = $<HTMLButtonElement>('#wipe');
  let armed = false;

  // Two clicks rather than a modal. A confirm() dialog on an always-on-top app
  // is a good way to lose a window behind everything else.
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Really? Everything?';
      window.setTimeout(() => {
        armed = false;
        button.textContent = 'Make her forget everything';
      }, 4000);
      return;
    }
    await api.wipeMemory();
    armed = false;
    button.textContent = 'Make her forget everything';
    await renderMemory();
  });
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

async function refreshStatus(): Promise<void> {
  const stored = await api.keyStatus();
  const hasLlm = stored[`llm.${config.llm.provider}`]?.present ?? false;
  const hasTts = stored[`tts.${config.tts.provider}`]?.present ?? false;
  const hasVoice = Boolean(config.tts.voiceId);
  const status = $('#status');

  if (hasLlm && hasTts && hasVoice) {
    status.dataset['ok'] = 'true';
    status.textContent = 'Ready. Close this window and say something to her.';
    return;
  }

  status.dataset['ok'] = 'false';
  const missing = [
    !hasLlm && 'a language key',
    !hasTts && 'a voice key',
    hasTts && !hasVoice && 'a voice',
  ].filter(Boolean);
  status.textContent = `She needs ${missing.join(' and ')} before she can talk.`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  config = await api.getConfig();
  permissions = await api.permissions().catch(() => null);

  // The video menu is filled before its key group is wired, because the group
  // reads its options — and the price it shows — out of that list.
  videoProviders = await api.videoProviders().catch(() => []);
  PROVIDERS.video = videoProviders.map((provider) => ({
    id: provider.id,
    label: provider.wired ? provider.label : `${provider.label} (not wired up)`,
    url: provider.site ?? '',
    why: provider.why,
    keyless: provider.keyless,
  }));

  for (const kind of ['llm', 'tts', 'stt', 'video'] as const) keyGroup(kind);
  wireModelPicker();
  wireVoice();
  wireBody();
  renderToggles($('#senses'), sensesToggles());
  wirePresence();
  wireWipe();

  await Promise.all([loadModels(), loadVoices(), renderMemory(), refreshStatus()]);

  api.onConfigChanged((next) => {
    config = next;
  });

  // Permissions change outside the app, so re-probe whenever the window is
  // brought back to the front rather than only on load.
  window.addEventListener('focus', async () => {
    permissions = await api.permissions().catch(() => null);
    renderToggles($('#senses'), sensesToggles());
    await renderMemory();
  });
}

void boot();
