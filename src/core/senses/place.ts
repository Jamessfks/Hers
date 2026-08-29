/**
 * Where she is, and what it is doing outside.
 *
 * Until v2.0 she had no idea. `situation.ts` used a bare `new Date()` and that
 * was the whole of her relationship with the outside world, which shows up in a
 * specific and unflattering way: she is the only person in the room who cannot
 * tell that it has been grey for four days.
 *
 * ## Where the location comes from, and where it does not
 *
 * From `Intl.DateTimeFormat().resolvedOptions().timeZone` — the IANA name the
 * operating system already holds, like `Europe/London` or `America/New_York` —
 * and the city is the last segment of it. That is a coarse answer and it is
 * chosen for being coarse.
 *
 * **Deliberately not IP geolocation.** The usual chain here is a request to a
 * service that reads the source address and hands back a street-level guess,
 * and it would be more accurate. It would also mean the user's IP arriving at
 * a third party who did not have it, for the sake of a companion knowing
 * whether to mention the rain. A timezone is already on the machine, it costs
 * no request at all, and the only thing that leaves here is a city name that
 * several million people share.
 *
 * **Deliberately not asking the browser.** `navigator.geolocation` is precise
 * to a few metres, prompts the user, and is wildly out of proportion to the
 * question. A companion does not need to know which room.
 *
 * ## The two hosts
 *
 * `geocoding-api.open-meteo.com` turns the city name into a latitude and
 * longitude; `api.open-meteo.com` turns those into a forecast. Open-Meteo
 * needs no key and no signup, which is the reason it is here rather than any of
 * the alternatives: a weather API that requires an account is a weather API
 * that requires the user to have an account somewhere, and this program asks
 * for two credentials already.
 *
 * Both are in `src/shared/destinations.ts` and both are named in
 * `docs/PRIVACY.md`, per `.claude/rules/network.md`.
 */

/** The whole answer, as the prompt needs it. */
export interface Place {
  /** The IANA timezone, e.g. `Europe/London`. Always known. */
  timeZone: string;
  /** The last segment of it with underscores removed, e.g. `New York`. */
  city: string;
  /** Absent until the geocoder has answered once. */
  weather?: Weather;
}

export interface Weather {
  /** Degrees Celsius, rounded. */
  temperature: number;
  /** What it is doing, in the words a person would use: "raining", "clear". */
  condition: string;
  /** True between the sunset and sunrise the forecast reports. */
  dark: boolean;
}

/**
 * How long a forecast is still a fair answer.
 *
 * An hour, matching the resolution Open-Meteo actually publishes. Asking more
 * often gets the same numbers back and spends somebody's rate limit on it.
 */
export const WEATHER_TTL_MS = 60 * 60 * 1000;

/**
 * WMO weather codes, in the words she would say rather than the words the
 * standard uses.
 *
 * The standard has 28 of them and distinguishes "slight" from "moderate"
 * drizzle. Nobody says that. The map collapses them to what a person leaning
 * out of a window would report, because the only use of this value is her
 * saying it out loud.
 */
const CONDITIONS: [max: number, said: string][] = [
  [0, 'clear'],
  [2, 'partly cloudy'],
  [3, 'overcast'],
  [48, 'foggy'],
  [57, 'drizzling'],
  [67, 'raining'],
  [77, 'snowing'],
  [82, 'pouring'],
  [86, 'snowing hard'],
  [99, 'thundering'],
];

function said(code: number): string {
  for (const [max, phrase] of CONDITIONS) if (code <= max) return phrase;
  return 'hard to say';
}

/** The seam the tests fake. Nothing else about this module reaches anywhere. */
export type Fetcher = (url: string) => Promise<unknown>;

const json: Fetcher = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`${String(response.status)} from ${new URL(url).host}`);
  return await response.json();
};

interface GeocodeAnswer {
  results?: { latitude: number; longitude: number; name: string }[];
}

interface ForecastAnswer {
  current?: { temperature_2m?: number; weather_code?: number; is_day?: number };
}

export interface PlaceOptions {
  /** Overridden in tests. `Intl` otherwise. */
  timeZone?: string;
  fetcher?: Fetcher;
  now?: () => number;
}

/**
 * Holds the answer and refuses to ask again for an hour.
 *
 * Failure is silent by design. A companion who says "I could not reach the
 * weather service" has told the user about a network problem they cannot fix
 * and did not ask about; a companion who simply does not mention the weather is
 * indistinguishable from one who had nothing to say about it. So a failed
 * lookup leaves `weather` absent, and the prompt section that renders it omits
 * the line rather than apologising for it.
 */
export class PlaceSense {
  #timeZone: string;
  #fetcher: Fetcher;
  #now: () => number;
  #weather: Weather | null = null;
  #at = 0;
  #coords: { latitude: number; longitude: number; name: string } | null = null;
  #inFlight: Promise<void> | null = null;

  constructor(options: PlaceOptions = {}) {
    this.#timeZone =
      options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    this.#fetcher = options.fetcher ?? json;
    this.#now = options.now ?? (() => Date.now());
  }

  /** What is known right now, without waiting for anything. */
  snapshot(): Place {
    return {
      timeZone: this.#timeZone,
      city: cityOf(this.#timeZone),
      ...(this.#weather ? { weather: this.#weather } : {}),
    };
  }

  /**
   * Fetch the forecast if the held one has expired.
   *
   * Shares one in-flight promise between callers for the same reason `wake()`
   * does: the browser connecting while the Telegram bridge is already running
   * is two callers arriving at the same moment, and two forecasts is one
   * forecast and one wasted request.
   */
  async refresh(): Promise<Place> {
    if (this.#weather && this.#now() - this.#at < WEATHER_TTL_MS) return this.snapshot();
    this.#inFlight ??= this.#fetch().finally(() => {
      this.#inFlight = null;
    });
    await this.#inFlight;
    return this.snapshot();
  }

  async #fetch(): Promise<void> {
    try {
      this.#coords ??= await this.#geocode();
      if (!this.#coords) return;
      const { latitude, longitude } = this.#coords;
      const forecast = (await this.#fetcher(
        'https://api.open-meteo.com/v1/forecast' +
          `?latitude=${String(latitude)}&longitude=${String(longitude)}` +
          '&current=temperature_2m,weather_code,is_day',
      )) as ForecastAnswer;
      const current = forecast.current;
      if (!current || typeof current.temperature_2m !== 'number') return;
      this.#weather = {
        temperature: Math.round(current.temperature_2m),
        condition: said(current.weather_code ?? 0),
        dark: current.is_day === 0,
      };
      this.#at = this.#now();
    } catch {
      // Held, not reported. See the note on the class.
    }
  }

  async #geocode(): Promise<{ latitude: number; longitude: number; name: string } | null> {
    const city = cityOf(this.#timeZone);
    const answer = (await this.#fetcher(
      'https://geocoding-api.open-meteo.com/v1/search' +
        `?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
    )) as GeocodeAnswer;
    return answer.results?.[0] ?? null;
  }
}

/**
 * `America/New_York` → `New York`.
 *
 * The last segment rather than the first, because the first is a continent and
 * the geocoder does poorly with `America`. Underscores are the separator IANA
 * uses for spaces, and the three-segment names — `America/Argentina/Salta` —
 * put the city last as well.
 */
export function cityOf(timeZone: string): string {
  const last = timeZone.split('/').pop() ?? timeZone;
  return last.replace(/_/g, ' ');
}

/** The line `nowSection` adds when there is anything to say. */
export function placeLine(place: Place): string {
  if (!place.weather) return `You are both in ${place.city}.`;
  const { temperature, condition, dark } = place.weather;
  return (
    `You are both in ${place.city}. Outside it is ${String(temperature)}°C and ` +
    `${condition}${dark ? ', and dark' : ''}. You can look out of the window; do not ` +
    'read it out like a forecast.'
  );
}
