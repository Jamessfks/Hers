/**
 * The stand-in figure, shown before a character is loaded.
 *
 * Anna ships without a character model, because every good VRM belongs to
 * somebody and bundling one would be either a licence violation or a bad
 * character. So the first run has to show *something*, and that something has
 * two jobs: make it obvious the app is alive and working, and make it obvious
 * that this is not the finished article.
 *
 * A luminous, deliberately abstract figure does both. It breathes, shifts its
 * weight, and brightens with her voice using the same envelope the real rig
 * uses, so the whole pipeline is visibly working the moment you type to her —
 * and nobody mistakes it for the product.
 *
 * Proportions are held to a real 1.68m figure with a 7.5-head canon, because a
 * placeholder with wrong proportions makes the framing look broken rather than
 * making the placeholder look abstract.
 */

import {
  AdditiveBlending,
  BackSide,
  CapsuleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Scene,
  SphereGeometry,
  TorusGeometry,
} from 'three';

export interface Placeholder {
  readonly height: number;
  update(deltaSeconds: number, speechEnergy: number): void;
  dispose(): void;
}

const GLOW = 0x9fd8ff;
const HEIGHT = 1.68;

export function createPlaceholder(scene: Scene): Placeholder {
  const group = new Group();

  const shell = new MeshStandardMaterial({
    color: 0xdcefff,
    emissive: GLOW,
    emissiveIntensity: 0.9,
    transparent: true,
    // High enough to read against a bright wallpaper, low enough to stay
    // obviously holographic. Below about 0.5 she disappears on a light desktop.
    opacity: 0.62,
    roughness: 0.3,
    metalness: 0,
  });

  /** Back-facing shell, slightly larger: a cheap rim light that needs no pass. */
  const halo = new MeshBasicMaterial({
    color: GLOW,
    transparent: true,
    opacity: 0.22,
    side: BackSide,
    blending: AdditiveBlending,
    depthWrite: false,
  });

  const parts: Mesh[] = [];

  function limb(
    radius: number,
    length: number,
    position: [number, number, number],
    tilt = 0,
  ): Mesh {
    const geometry = new CapsuleGeometry(radius, length, 6, 18);
    const mesh = new Mesh(geometry, shell);
    mesh.position.set(...position);
    mesh.rotation.z = tilt;
    group.add(mesh);

    const outline = new Mesh(geometry, halo);
    outline.position.copy(mesh.position);
    outline.rotation.copy(mesh.rotation);
    outline.scale.setScalar(1.06);
    group.add(outline);

    parts.push(mesh, outline);
    return mesh;
  }

  // 7.5-head canon on a 1.68m figure: head centre at 1.57, crotch at 0.84.
  const head = new Mesh(new SphereGeometry(0.105, 28, 20), shell);
  head.position.set(0, 1.565, 0);
  group.add(head);
  const headHalo = new Mesh(head.geometry, halo);
  headHalo.position.copy(head.position);
  headHalo.scale.setScalar(1.08);
  group.add(headHalo);
  parts.push(head, headHalo);

  const neck = limb(0.038, 0.05, [0, 1.46, 0]);
  const torso = limb(0.135, 0.36, [0, 1.19, 0]);
  const hips = limb(0.125, 0.1, [0, 0.9, 0]);

  // Arms hang just outside the torso, with a slight outward tilt.
  limb(0.045, 0.26, [-0.205, 1.22, 0], 0.06);
  limb(0.045, 0.26, [0.205, 1.22, 0], -0.06);
  limb(0.04, 0.24, [-0.225, 0.93, 0], 0.04);
  limb(0.04, 0.24, [0.225, 0.93, 0], -0.04);

  // Two legs, not one column: a single capsule reads as a chess piece.
  limb(0.062, 0.32, [-0.085, 0.63, 0]);
  limb(0.062, 0.32, [0.085, 0.63, 0]);
  limb(0.05, 0.3, [-0.085, 0.22, 0]);
  limb(0.05, 0.3, [0.085, 0.22, 0]);

  // A soft ring on the floor, so she reads as standing on the desk rather than
  // floating in front of it.
  const ring = new Mesh(
    new TorusGeometry(0.3, 0.005, 8, 72),
    new MeshBasicMaterial({
      color: GLOW,
      transparent: true,
      opacity: 0.55,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.008;
  group.add(ring);

  scene.add(group);

  let time = 0;

  return {
    height: HEIGHT,

    update(delta, speechEnergy) {
      time += delta;

      // The same idle vocabulary the real rig uses: breath, weight shift,
      // head micro-motion. Amplitudes match Body#applyIdle so that swapping in
      // a real character does not change how she carries herself.
      const breath = Math.sin((time * Math.PI * 2) / 4.3);
      torso.scale.setY(1 + breath * 0.016);
      neck.position.y = 1.46 + breath * 0.004;
      hips.rotation.z = Math.sin(time * 0.19) * 0.02;

      group.rotation.z = Math.sin(time * 0.19) * 0.011;
      group.position.x = Math.sin(time * 0.083) * 0.014;

      head.position.y = 1.565 + breath * 0.005;
      headHalo.position.y = head.position.y;
      const turn = Math.sin(time * 0.29) * 0.1 + Math.sin(time * 0.87) * 0.03;
      head.rotation.y = turn;
      headHalo.rotation.y = turn;
      head.rotation.x = Math.sin(time * 0.41) * 0.045;
      headHalo.rotation.x = head.rotation.x;

      // Voice drives brightness, so lip sync is legible without a mouth.
      shell.emissiveIntensity = 0.9 + speechEnergy * 1.1;
      halo.opacity = 0.22 + speechEnergy * 0.3;
      ring.scale.setScalar(1 + speechEnergy * 0.06);
    },

    dispose() {
      scene.remove(group);
      for (const mesh of [...parts, ring]) {
        mesh.geometry.dispose();
      }
      shell.dispose();
      halo.dispose();
      (ring.material as MeshBasicMaterial).dispose();
    },
  };
}
