# Archipelago Controller

The Controller-hosted room parity specification and release checklist is in [docs/0.2.0-controller-room-parity.md](docs/0.2.0-controller-room-parity.md).

A host-first desktop app for organizing player YAML templates, validating session builds, generating Archipelago sessions, and returning to past runs.

## Run locally

```powershell
npm install
npm run dev
```

The desktop window opens automatically. For a production-style local run:

```powershell
npm run build
npm run desktop
```

## First setup

Open **Settings** and choose:

- the Archipelago generator executable;
- the Archipelago host executable;
- a managed template library folder;
- an output folder for generated sessions.

For the detected installation, the app starts with `C:\ProgramData\Archipelago` paths filled in and imports YAMLs from `Players\Temp` when the library is empty.

Imported YAMLs are copied into game-specific folders when a library folder is configured. Source templates are never rewritten during generation: duplicate slot fixes are applied to working copies inside the session output folder.

The default generator argument template is:

```text
--player_files_path "{input}" --outputpath "{output}"
```

Adjust it in Settings if the installed Archipelago release uses different command-line options.

## Room data API

While Controller is running, other software can read every API-visible saved room through the provider-neutral broker at:

```text
http://127.0.0.1:38283/api/controller/v2/rooms
```

This works for official Archipelago rooms, locally hosted rooms, and remote Controller rooms. Individual snapshots are available at `/rooms/<managed-room-id>/snapshot`, and the live OpenAPI contract is served at `/openapi.yaml`. Local read requests need no key; refresh/wake actions and optional network access use the bearer key configured under **Settings → Room data API**.

## Verification

```powershell
npm test
npm run build
```
# Archipelago Controller

Desktop session builder, generator, and host console for Archipelago.

## Windows Release

Build both shareable Windows formats:

```powershell
npm install
npm run release
```

Artifacts are written to `release/`:

- `Archipelago Controller-<version>-x64-portable.exe` runs without installation.
- `Archipelago Controller-<version>-x64-setup.exe` installs Start menu and desktop shortcuts.

The recipient still needs their own Archipelago installation. Its location can be selected in the app under Settings.

These local builds are unsigned, so Windows SmartScreen may show an unknown-publisher warning. Public distribution without that warning requires a Windows code-signing certificate.
