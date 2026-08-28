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

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });

  // Checked here rather than trusted, because the failure this replaced was
  // also a silent one. A build that cannot verify its own output should stop
  // at the build rather than at somebody's download.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });

  console.log(`  • ad-hoc signed  file=${path.relative(process.cwd(), app)}`);
};
