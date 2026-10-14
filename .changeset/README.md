# Changesets

A changeset is one Markdown file that names the size of the next version bump
and one line for the changelog.

Add a changeset in every pull request that changes a shipped file, a file under
`src` or `bin` that is not a test.

```bash
npx changeset          # choose the bump and write the line
npx changeset --empty  # a change that ships nothing new, such as a comment
```

The line reaches `CHANGELOG.md` as written, so write it for a seller who reads
the changelog: what changed for them, in one or two sentences.

## Choose the bump

The SDK stays on `0.x` while its surface moves.

| Change | Before 1.0.0 | After 1.0.0 |
|---|---|---|
| Remove or rename an export, a method, an option, or a CLI flag | minor | major |
| Change a type, a default, or an error code so that seller code breaks | minor | major |
| Raise the lowest Node version in `engines` | minor | major |
| Add an export, an optional option, or a CLI flag | patch | minor |
| Fix a defect with no change to the surface | patch | patch |
| A change that ships nothing new, such as a comment or a test | empty changeset | empty changeset |
