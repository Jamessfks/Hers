---
description: Draft a CHANGELOG entry for the current diff in this project's voice — prose paragraphs with bolded lead sentences, reasoning included, breaking changes called out.
argument-hint: "[version, e.g. 1.4.2]"
allowed-tools: Bash(git log:*), Bash(git diff:*), Bash(git status:*), Read
---

# A CHANGELOG entry

Read the last three entries before writing. `sed -n '1,80p' CHANGELOG.md`. The
voice is not decorative — it is how this project explains itself, and a bullet
list of `- Fixed X` reads as a different project.

## Shape

```markdown
## v$1 — DD Month YYYY

**A bolded sentence stating what is now true.** Then the prose: what the old
behaviour was, exactly when it went wrong, what it does now, and — this is the
part that is usually missing — what the obvious alternative was and why it was
rejected. Concrete numbers, not adjectives: "eight seconds", not "a short wait".

**One paragraph per thing changed.** Ordered by what a reader needs to know
first, which is usually the security fix and never the refactor.
```

## Rules

- **Breaking is anything that changes a name already typed into a config file** —
  an environment variable, a folder, a model. Say what it is and what to do about
  it, in the entry, not in a footnote.
- British spelling. No emoji, no exclamation marks, no "we're excited to".
- Do not list things a reader cannot observe. An internal rename is not an entry.
- If a change has no user-visible effect and no reasoning worth recording, it
  does not get a paragraph.

## Source material

```bash
git log --format='%s%n%b%n---' $(git describe --tags --abbrev=0)..HEAD
git diff --stat $(git describe --tags --abbrev=0)..HEAD
```

The commit subjects are already written in this voice. Usually the entry is those
subjects, expanded with the reasoning from their bodies and merged where two
commits are one story.
