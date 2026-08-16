import assert from 'node:assert/strict';
import { test } from 'node:test';

import { portraitPrompt } from './text.ts';

/**
 * The prompt used to end with "Stylised illustration, not a photograph of a
 * real person", and it got exactly what it asked for: the pictures she sent
 * were cartoon drawings, and because the face had to be redrawn in another
 * medium it was not reliably her face either, reference image or not.
 *
 * These assertions are the guard rail. They are about what is asked for, not
 * about what comes back — what comes back costs four cents and cannot be
 * asserted on in a unit test.
 */

const reference = { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' };

/**
 * The prompt is wrapped for reading, and where the line breaks fall is not
 * behaviour. Asserting on the unwrapped text keeps these tests about what the
 * model is told rather than about the shape of the source file.
 */
function prompt(request: { description: string; appearance: string; reference?: typeof reference }) {
  return portraitPrompt(request).replace(/\s+/g, ' ');
}

test('the prompt asks for a photograph and never for an illustration', () => {
  const built = prompt({
    description: 'laughing in the kitchen',
    appearance: '24-year-old Chinese-American woman',
    reference,
  });

  assert.match(built, /photorealistic/i);
  assert.match(built, /photograph/i);
  assert.doesNotMatch(
    built,
    /stylised illustration|stylized illustration/i,
    'this exact phrase is what made her a cartoon',
  );
  assert.match(built, /not an illustration/i, 'saying it positively is not enough');
});

test('the prompt says outright that her face may not change', () => {
  const built = prompt({
    description: 'at the window watching the rain',
    appearance: 'dark brown eyes',
    reference,
  });

  assert.match(built, /reference image/i, 'the model has to be told the image is her');
  assert.match(built, /completely unchanged/i);
  assert.match(built, /same real person/i);
});

test('what the picture should show survives into the prompt', () => {
  const built = prompt({
    description: 'at the window watching the rain',
    appearance: 'dark brown eyes',
    reference,
  });

  assert.match(built, /at the window watching the rain/);
});

/**
 * Measured, and it cost an image to find. The profile calls her hair a
 * chin-length black bob; the uploaded photograph is a woman with long fair
 * hair. Sending both gave back the right face under the written hair — the
 * model has no way to know which of two contradicting sources is the real one,
 * so it is given one.
 */
test('the written appearance is left out when there is a photograph to copy', () => {
  const built = prompt({
    description: 'laughing in the kitchen',
    appearance: 'chin-length bob, blunt cut, in black',
    reference,
  });

  assert.doesNotMatch(
    built,
    /chin-length bob/,
    'a written description that contradicts the photograph restyles her',
  );
  assert.match(built, /do not restyle her/i);
  assert.match(built, /hair colour, hair length/i, 'the drift was in the hair specifically');
});

test('with no photograph it still asks for a real woman rather than a drawing', () => {
  const built = prompt({
    description: 'reading on the sofa',
    appearance: '24-year-old Chinese-American woman',
  });

  assert.match(built, /photorealistic/i);
  assert.match(built, /real woman/i);
  assert.doesNotMatch(built, /reference image/i, 'there is no reference to point at');
  assert.match(built, /24-year-old Chinese-American woman/, 'words are all it has to go on');
});

test('the photographic language the docs ask for is present', () => {
  const built = prompt({ description: 'smiling', appearance: '', reference });

  // The documented template is "A photorealistic [type of shot] of a [subject]
  // in a [setting]. [Description of the light]. Shot from a [camera angle] with
  // a [lens type]." Light and lens are the two the old prompt half-had.
  assert.match(built, /light/i);
  assert.match(built, /50mm|lens/i);
  assert.match(built, /no watermark/i);
});
