import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlaceSense, WEATHER_TTL_MS, cityOf, placeLine } from './place.ts';

/** Answers keyed by which host the URL is for, so a test can fail one of them. */
function fetcher(answers: { geocode?: unknown; forecast?: unknown; throwOn?: string }): {
  fetcher: (url: string) => Promise<unknown>;
  urls: string[];
} {
  const urls: string[] = [];
  return {
    urls,
    fetcher: async (url: string) => {
      urls.push(url);
      const host = new URL(url).host;
      if (answers.throwOn && host.includes(answers.throwOn)) throw new Error('offline');
      return host.startsWith('geocoding') ? answers.geocode : answers.forecast;
    },
  };
}

const LONDON = { results: [{ latitude: 51.5, longitude: -0.13, name: 'London' }] };
const RAINING = { current: { temperature_2m: 11.4, weather_code: 63, is_day: 1 } };

test('the city is the last segment of the timezone, not the first', () => {
  assert.equal(cityOf('Europe/London'), 'London');
  assert.equal(cityOf('America/New_York'), 'New York');
  assert.equal(cityOf('America/Argentina/Salta'), 'Salta');
  assert.equal(cityOf('UTC'), 'UTC');
});

test('nothing about the user is in either request but a city name', async () => {
  const { fetcher: f, urls } = fetcher({ geocode: LONDON, forecast: RAINING });
  await new PlaceSense({ timeZone: 'Europe/London', fetcher: f }).refresh();

  assert.equal(urls.length, 2);
  assert.match(urls[0] ?? '', /^https:\/\/geocoding-api\.open-meteo\.com/);
  assert.match(urls[0] ?? '', /name=London/);
  assert.match(urls[1] ?? '', /^https:\/\/api\.open-meteo\.com/);
  // The whole privacy claim in one assertion: no IP, no coordinates the user
  // gave, nothing that identifies a person.
  for (const url of urls) {
    assert.doesNotMatch(url, /ip|token|key|user|id=/i);
  }
});

test('the forecast comes back in the words she would use', async () => {
  const { fetcher: f } = fetcher({ geocode: LONDON, forecast: RAINING });
  const place = await new PlaceSense({ timeZone: 'Europe/London', fetcher: f }).refresh();
  assert.equal(place.city, 'London');
  assert.deepEqual(place.weather, { temperature: 11, condition: 'raining', dark: false });
});

test('it is not asked again for an hour, and is after one', async () => {
  let now = 0;
  const { fetcher: f, urls } = fetcher({ geocode: LONDON, forecast: RAINING });
  const place = new PlaceSense({ timeZone: 'Europe/London', fetcher: f, now: () => now });

  await place.refresh();
  await place.refresh();
  assert.equal(urls.length, 2, 'the second call inside the hour asks nothing');

  now += WEATHER_TTL_MS + 1;
  await place.refresh();
  // The city is geocoded once for the life of the process; only the forecast
  // is asked for again.
  assert.equal(urls.length, 3);
  assert.match(urls[2] ?? '', /^https:\/\/api\.open-meteo\.com/);
});

test('two callers arriving together make one request each, not two', async () => {
  const { fetcher: f, urls } = fetcher({ geocode: LONDON, forecast: RAINING });
  const place = new PlaceSense({ timeZone: 'Europe/London', fetcher: f });
  await Promise.all([place.refresh(), place.refresh(), place.refresh()]);
  assert.equal(urls.length, 2);
});

test('a failed lookup leaves her with a city and no complaint', async () => {
  const { fetcher: f } = fetcher({ geocode: LONDON, throwOn: 'api.open-meteo' });
  const place = await new PlaceSense({ timeZone: 'Europe/Berlin', fetcher: f }).refresh();
  assert.equal(place.city, 'Berlin');
  assert.equal(place.weather, undefined);
  assert.equal(placeLine(place), 'You are both in Berlin.');
});

test('a city the geocoder does not know stops there', async () => {
  const { fetcher: f, urls } = fetcher({ geocode: { results: [] }, forecast: RAINING });
  const place = await new PlaceSense({ timeZone: 'Etc/GMT+3', fetcher: f }).refresh();
  assert.equal(place.weather, undefined);
  assert.equal(urls.length, 1, 'no forecast is asked for without coordinates');
});

test('the line she is given tells her not to read it out as a forecast', async () => {
  const { fetcher: f } = fetcher({ geocode: LONDON, forecast: RAINING });
  const place = await new PlaceSense({ timeZone: 'Europe/London', fetcher: f }).refresh();
  const line = placeLine(place);
  assert.match(line, /London/);
  assert.match(line, /11°C and raining/);
  assert.match(line, /do not\s+read it out/);
});
