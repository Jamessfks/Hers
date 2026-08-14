/**
 * The stand-in figure, shown before a character is loaded.
 *
 * Anna ships without a character model, because every good VRM belongs to
 * somebody and bundling one would be either a licence violation or a bad
 * character. So the first run has to show *something*, and that something has
 * two jobs: make it obvious the app is alive and working, and make it obvious
 * that this is not the finished article.
 *
 * A luminous, deliberately abstract figure does both. It breathes, sways and
 * responds to her voice using the same envelope the real rig uses, so the whole
 * pipeline is visibly working the moment you type to her — and nobody mistakes
 * it for the product.
 */

import {
  AdditiveBlending,
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
  update(deltaSeconds: number, speechEnergy: number): void;
  dispose(): void;
}

const GLOW = 0x8ecdff;

export function createPlaceholder(scene: Scene): Placeholder {
  const group = new Group();

  const shell = new MeshStandardMaterial({
    color: GLOW,
    emissive: GLOW,
    emissiveIntensity: 0.55,
    transparent: true,
    opacity: 0.32,
    roughness: 0.25,
    metalness: 0,
  });

  const torso = new Mesh(new CapsuleGeometry(0.16, 0.52, 6, 18), shell);
  torso.position.y = 1.0;
  group.add(torso);

  const head = new Mesh(new SphereGeometry(0.115, 24, 18), shell);
  head.position.y = 1.48;
  group.add(head);

  const legs = new Mesh(new CapsuleGeometry(0.125, 0.62, 6, 16), shell);
  legs.position.y = 0.42;
  group.add(legs);

  for (const side of [-1, 1]) {
    const arm = new Mesh(new CapsuleGeometry(0.052, 0.46, 4, 12), shell);
    arm.position.set(side * 0.21, 1.0, 0);
    arm.rotation.z = side * 0.12;
    group.add(arm);
  }

  // A soft ring at the feet, so she reads as standing on the desk rather than
  // floating in front of it.
  const ring = new Mesh(
    new TorusGeometry(0.34, 0.006, 8, 64),
    new MeshBasicMaterial({ color: GLOW, transparent: true, opacity: 0.5, blending: AdditiveBlending }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.02;
  group.add(ring);

  scene.add(group);

  let time = 0;

  return {
    update(delta, speechEnergy) {
      time += delta;

      // The same idle vocabulary the real rig uses: breath, sway, micro-motion.
      const breath = Math.sin((time * Math.PI * 2) / 4.3);
      torso.scale.setY(1 + breath * 0.012);
      group.rotation.z = Math.sin(time * 0.19) * 0.012;
      group.position.x = Math.sin(time * 0.083) * 0.012;
      head.position.y = 1.48 + breath * 0.004;
      head.rotation.y = Math.sin(time * 0.29) * 0.09;
      head.rotation.x = Math.sin(time * 0.41) * 0.04;

      // Voice drives brightness, so lip sync is visible without a mouth.
      shell.emissiveIntensity = 0.55 + speechEnergy * 0.85;
      shell.opacity = 0.32 + speechEnergy * 0.18;
      ring.scale.setScalar(1 + speechEnergy * 0.05);
    },

    dispose() {
      scene.remove(group);
      group.traverse((object) => {
        if (object instanceof Mesh) {
          object.geometry.dispose();
          const material = object.material;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });
    },
  };
}
