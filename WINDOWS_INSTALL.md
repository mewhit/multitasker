# Windows install

## Standalone EXE installer (recommended)

Open `release\Multitasker-Setup-1.1.0.exe`. The installer includes Electron,
Node.js, the desktop UI, and the three local services. Users do not need Node.js
or the source checkout. The wizard supports choosing the installation directory,
creates shortcuts, and enables **Start Multitasker when I sign in to Windows**
by default. Uninstall through Windows Settings to remove the app and startup entry.

To build the installer on Windows x64, install the project dependencies first,
then run:

```powershell
npm run package:windows
```

This builds the application, prepares an isolated runtime in `.tmp\windows-app`,
and produces the installer in `release`. The first build downloads packaging
tools and runtime dependencies. The Node.js used for building is bundled with
its license; use an official Windows x64 Node.js installation with `LICENSE`
beside `node.exe`. Slack OAuth application settings are taken from the build
environment or `extension/slack/.env`; `SLACK_CLIENT_ID` and
`SLACK_CLIENT_SECRET` are required. Only these and the optional redirect URI and
scope settings are bundled. Workspace tokens, connected workspaces, and developer
`.env` files are excluded. The installed app can add Slack workspaces immediately;
existing local settings take precedence and connections survive upgrades.
The bundled client secret is extractable: keep this installer private. A public
distribution should perform the secret-bearing OAuth exchange on a server.
Configure other integrations separately on the installed machine.

Application data and service logs live under Electron's per-user application
data directory (`%APPDATA%\multitasker` by default). They are separate from the
installation directory and retained on uninstall. `MULTITASKER_DATA_DIR` can
override the data directory. Closing the app stops the services it started.
Avoid running the source checkout and installed app simultaneously because
they use the same default local ports.

The generated installer is currently unsigned and uses the default Electron
icon. Code signing and a custom application icon can be configured later.

Run `node packaging/smoke-test.cjs` after preparing the installer to verify the
bundled runtime, backend health, and shell gateway in an isolated data directory.

## Source-checkout wizard

Double-click `Setup.cmd` to open the graphical setup wizard, or run:

```powershell
npm run setup:windows
```

The wizard lets you choose automatic startup (enabled by default), Desktop and
Start Menu shortcuts, PATH integration, and launching after installation. It
shows installation output and allows retrying after a failure. Logs are saved
under `%LOCALAPPDATA%\Multitasker\SetupLogs`.

This is a setup wizard for the source checkout, not a standalone distributable
EXE. Install Node.js with npm first and keep this project folder in place after
installation. Dependency installation needs internet access and may require the
build tools used by native Node dependencies. No administrator access is needed
for the shortcuts or user PATH changes.

Automatic startup runs when the current user signs in after boot or restart;
it does not run a service before login. On subsequent installs, unchecked options
skip creating that integration; they do not remove previously installed shortcuts
or PATH entries. Use the uninstall command below to remove those integrations.

For command-line installation without the wizard, run this from the repository root:

```powershell
npm run install:windows
```

The installer is user-scoped. It installs dependencies, builds Multitasker, adds `bin\` to the user `PATH`, creates Start Menu/Desktop shortcuts, and adds a Startup shortcut so Multitasker opens when you sign in to Windows.

Useful options:

```powershell
.\scripts\install-windows.ps1 -NoDependencies -NoBuild
.\scripts\install-windows.ps1 -NoStartup
.\scripts\install-windows.ps1 -StartNow
npm run uninstall:windows
```

After install, open a new terminal and run:

```powershell
multitasker
```
