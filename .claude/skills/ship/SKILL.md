---
description: The release checklist for Hers — version, CHANGELOG, gates, tag.
disable-model-invocation: true
argument-hint: "[version, e.g. 1.4.2]"
---

# Ship $1

Side effects. Run only what is asked, stop at the first failure, and never push
a tag without the user saying so in this session.

1. **Clean tree.** `git status --porcelain` is empty, or stop and say what is
   dirty.
2. **The free gate.** `npm run check` — typecheck plus 525 tests, no key. It
   must be green. Paste the tail of the output.
3. **The privacy gate.** Run `/privacy-gate`. All four claims held.
4. **Version.** Bump `version` in `package.json` to `$1`. Semver: a changed env
   var, folder, or model name is a major-or-minor decision, not a patch — ask if
   it is ambiguous.
5. **CHANGELOG.** Run `/changelog-entry $1`. Read it back to the user before
   committing.
6. **The paid gate — the user's call, and their money.** Ask before running:
   - `npm run audit` (a few cents; `--quick` skips the multi-minute checks)
   - `npm run audit:bridges` (needs `livekit-server --dev` and a human who has
     messaged the Telegram bot)
   Report what each observed, not just PASS.
7. **Commit.** Subject `Version $1`. Body: the one thing worth knowing before
   upgrading, in prose. Follow the format of `git show 98ee1da`.
8. **Stop.** Tell the user the tag and push commands. Do not run them yourself
   unless they ask in this session.

If step 2 or 3 fails, the release does not happen. Say so and stop; do not
"fix it quickly" without checking first.
