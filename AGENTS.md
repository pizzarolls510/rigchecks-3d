# RigCheck agent procedure

These rules apply to every automated or agent-assisted change in this repository.

## Publishing GLBs

- Always publish a GLB with `rigcheck upload <file.glb>`.
- Never manually combine a Cloud Storage upload with a Firestore document write.
- Do not bypass a failed `rigcheck check` validation.
- Use `rigcheck upload <file.glb> --dry-run` when the user has not explicitly authorized a real upload.

## Firebase and destructive operations

- Never deploy Firebase rules unless the user explicitly requests that exact action.
- Never delete a cloud model without explicit user confirmation identifying the model.
- Never expose credentials, authorization codes, access tokens, refresh tokens, or service-account keys in chat, logs, commits, or command output.
- Keep `rigcheck.config.json` uncommitted. It contains local machine configuration.

## Before cloud work

- Run `rigcheck doctor` before a real upload.
- Confirm that the reported project ID is exactly `rigcheck-cfbe3`.
- Confirm that the reported owner UID is the intended Firebase Authentication user.
- Run the relevant tests after changing CLI or cloud-schema code.

## Scope

- The first CLI release contains only `doctor`, `check`, `upload`, and `list`.
- Do not add deploy, delete, rename, download, or other commands without a new user request.
