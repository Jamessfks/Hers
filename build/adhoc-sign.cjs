/**
 * An ad-hoc signature over the built macOS bundle, before the disk image is made.
 *
 * ## Why this file exists
 *
 * There is no Developer ID here and there is not going to be one until somebody
 * pays Apple $99 and hands over their legal identity. `identity: null` in
 * `electron-builder.yml` says so, and electron-builder does exactly what it is
 * told: it skips signing completely. That is not the same as shipping an
 * unsigned application, and the difference is the whole point of this file.
 *
 * What comes out of a skipped signing step is an app bundle whose main binary
 * still carries the linker's own signature from the Electron download —
 * `Identifier=Electron`, `Info.plist=not bound`, `Sealed Resources=none` — and
 * `codesign --verify` refuses it outright:
 *
 *     code has no resources but signature indicates they must be present
 *
 * On the machine that built it that is invisible, because a file you created
 * yourself has no quarantine flag and Gatekeeper never looks. On the machine
 * that downloaded it, the flag is there, Gatekeeper does look, and a signature
 * that fails to verify is not the ordinary "unidentified developer" prompt
 * somebody can right-click past — it is *"Hers is damaged and can't be opened.
 * You should move it to the Bin"*, which is unrecoverable advice for an
 * application that is not damaged at all.
 *
 * An ad-hoc signature — `codesign --sign -` — fixes that. It seals the bundle
 * and binds the Info.plist without asserting who made it, which is the honest
 * position: this build is genuinely from nobody in particular, and it should
 * say that rather than appearing corrupt. Apple Silicon requires *some* valid
 * signature to execute a binary at all, so this is also the difference between
 * an app and a crash on an arm64 Mac that did not build it.
 *
 * It does not make the first-launch warning go away, and it is not supposed to.
 * The README says which two clicks get past that, because that is the truth.
 *
 * ## `--deep`
 *
 * Apple's documentation discourages `--deep` for signing, and it is right to:
 * it applies the outer command's entitlements to nested code, which silently
 * breaks a hardened, notarised app. There are no entitlements here, and nothing
 * to break. What is left is the part `--deep` does well — signing a hundred and
 * sixty nested frameworks, helpers and `.node` binaries inside-out in the right
 * order — and hand-rolling that traversal to avoid a flag whose only hazard
 * does not apply would be the more dangerous choice.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { FuseV1Options, FuseVersion, flipFuses } = require('@electron/fuses');

/*
 * ## Why the fuses are flipped here and not in `electron-builder.yml`
 *
 * They were, once, for about ten minutes. electron-builder runs its own fuse
 * step *after* `afterPack`, so the order was: seal the bundle, then rewrite the
 * binary. Flipping a fuse edits the executable, which breaks the seal, and
 * `codesign --verify` said so:
 *
 *     invalid signature (code or signature have been modified)
 *
 * Which is exactly the state the whole of the comment above exists to prevent —
 * an app that reads as damaged rather than merely unsigned. Adding the fuses
 * that way made every download worse than having no fuses at all, and the build
 * still reported success.
 *
 * So the fuses are flipped in here, before the signature, and
 * `electron-builder.yml` has no `electronFuses` key. One step, one order, and
 * the verify at the end of this file is what proves it.
 *
 * What they turn off: `runAsNode` and the two Node CLI switches, which would
 * otherwise let `ELECTRON_RUN_AS_NODE=1 …/Hers -e '<js>'` run somebody else's
 * JavaScript under this application's identity — inheriting the Camera,
 * Microphone and Screen Recording permissions the user granted to *her*. That is
 * the ordinary way an Electron app becomes a route around a permission prompt
 * that was already answered.
 *
 * The limit, stated: an ad-hoc signature is reproducible by anyone, so somebody
 * who can write to the installed bundle can flip these back and re-sign it. This
 * raises the bar against an attacker who can run a command; it seals nothing.
 */
async function hardenFuses(app) {
  await flipFuses(app, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  });
}

exports.default = async function adhocSign(context) {
  /*
   * Fuses first, and above the darwin guard rather than below it.
   *
   * This function returned early on anything that was not macOS, so every
   * Windows build shipped with `RunAsNode` left on — and `RunAsNode` on means
   * `ELECTRON_RUN_AS_NODE=1 Hers.exe -e '<js>'` runs arbitrary JavaScript under
   * the application's own identity and its own permissions. The guard was
   * written for the ad-hoc signature below, which genuinely is macOS-only, and
   * it took the hardening with it. Nobody chose that.
   */
  const binary =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      : path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  await hardenFuses(binary);

  if (context.electronPlatformName !== 'darwin') return;

  const app = binary;

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });

  // Checked here rather than trusted, because the failure this replaced was
  // also a silent one. A build that cannot verify its own output should stop
  // at the build rather than at somebody's download.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });

  console.log(`  • fuses flipped, then ad-hoc signed  file=${path.relative(process.cwd(), app)}`);
};
