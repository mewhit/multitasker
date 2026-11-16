const path = require('node:path');

module.exports = {
  appId: 'com.multitasker.desktop',
  productName: 'Multitasker',
  directories: {
    app: path.resolve(__dirname, '../.tmp/windows-app'),
    output: path.resolve(__dirname, '../release'),
  },
  electronDist: path.resolve(__dirname, '../desktop/node_modules/electron/dist'),
  electronVersion: require('../desktop/node_modules/electron/package.json').version,
  // Services use the bundled Node runtime and its native-module ABI.
  npmRebuild: false,
  asar: false,
  files: ['**/*', '!runtime/**/*'],
  extraResources: [{ from: '.tmp/windows-app/runtime', to: 'runtime' }],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    executableName: 'Multitasker',
    signAndEditExecutable: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    include: path.resolve(__dirname, 'installer.nsh'),
    artifactName: 'Multitasker-Setup-${version}.${ext}',
  },
};
