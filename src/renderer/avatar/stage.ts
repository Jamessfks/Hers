/**
 * The stage: renderer, camera, lights, and whatever character is loaded.
 *
 * Framing is the decision that matters most here. The brief is a *full-body*
 * companion — the thing that separates this from every talking-head product —
 * so the camera is framed head to feet with air above and below, at roughly eye
 * height on a standing figure, with a mild telephoto that keeps the perspective
 * flattering. A wide lens close in makes any character look like a fisheye
 * security camera, which is the opposite of intimate.
 *
 * The background is genuinely transparent: `alpha: true` plus a clear alpha of
 * zero, so the desktop shows through and she reads as standing on the desk
 * rather than inside a box.
 */

import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  PointLight,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface StageHandles {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  resize(): void;
}

export function createStage(canvas: HTMLCanvasElement): StageHandles {
  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
  });
  renderer.setClearAlpha(0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new Scene();

  // 28mm-equivalent would distort; 32 degrees is a short telephoto.
  const camera = new PerspectiveCamera(32, 1, 0.1, 20);
  camera.position.set(0, 1.05, 2.6);
  camera.lookAt(0, 0.95, 0);

  // Three-point-ish lighting, cool key from the screen side and a warm rim from
  // behind, so she separates from an arbitrary desktop background.
  const key = new DirectionalLight(0xffffff, 2.1);
  key.position.set(1.2, 2.4, 2.2);
  scene.add(key);

  const rim = new DirectionalLight(0x8ecdff, 1.4);
  rim.position.set(-1.8, 1.6, -2.0);
  scene.add(rim);

  const fill = new HemisphereLight(0xdfe9ff, 0x202028, 1.1);
  scene.add(fill);

  // A small warm light at chest height keeps faces from going flat.
  const bounce = new PointLight(0xffd9c0, 0.5, 6);
  bounce.position.set(0.4, 1.1, 1.4);
  scene.add(bounce);

  function resize(): void {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  resize();
  window.addEventListener('resize', resize);

  return { scene, camera, renderer, resize };
}

/**
 * Loads a VRM and prepares it for real-time use.
 *
 * `removeUnnecessaryJoints` and friends are not optional polish: VRoid exports
 * carry hundreds of spring-bone joints that cost more per frame than the rest
 * of the scene combined, and an avatar that drops to 20fps stops reading as
 * present no matter how good the model is.
 */
export async function loadVrm(url: string): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData['vrm'] as VRM | undefined;
  if (!vrm) throw new Error('That file loaded, but it is not a VRM character.');

  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.combineMorphs(vrm);

  // VRM 0.x characters face away from the camera; 1.0 face towards it.
  vrm.scene.rotation.y = vrm.meta?.metaVersion === '0' ? Math.PI : 0;

  vrm.scene.traverse((object) => {
    object.frustumCulled = false;
  });

  return vrm;
}

/**
 * Frames the camera to the loaded character, head to feet.
 *
 * Characters vary from 1.2m chibi proportions to 1.9m, and a fixed camera
 * either crops the tall ones at the knees or leaves the short ones as a distant
 * speck. Measuring the rig and solving for the distance that fits it is four
 * lines and removes the problem permanently.
 */
export function frameFullBody(camera: PerspectiveCamera, vrm: VRM): void {
  const head = vrm.humanoid?.getNormalizedBoneNode('head');
  // Head bone height plus a bit for the skull above it.
  const height = head ? Math.max(1.0, head.getWorldPosition(new Vector3()).y * 1.12) : 1.6;
  frameHeight(camera, height);
}

/**
 * Fits a figure of `height` metres, standing on y=0, into the frame.
 *
 * The headroom factor is doing real work. Solve it exactly and the character's
 * feet sit on the bottom edge of the window, which reads as cropped even though
 * nothing is missing — the eye needs to see a little floor under someone before
 * it believes they are standing on it.
 */
export function frameHeight(camera: PerspectiveCamera, height: number): void {
  const HEADROOM = 1.3;
  const framed = height * HEADROOM;
  const vertical = (camera.fov * Math.PI) / 180;
  const distance = framed / (2 * Math.tan(vertical / 2));

  camera.position.set(0, framed / 2, distance);
  camera.lookAt(0, framed / 2, 0);
  camera.updateProjectionMatrix();
}
