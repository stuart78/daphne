/**
 * electron-builder configuration.
 *
 * This lives in a script rather than package.json so signing can depend on
 * whether credentials are actually present. A static config that always asks
 * for a hardened runtime fails outright on a machine with no certificate, which
 * would mean nobody could build the app without an Apple account.
 *
 * Three states, all of which produce a working build:
 *
 *   no certificate      unsigned, same as before. Gatekeeper needs the
 *                       right-click Open workaround on other machines.
 *   certificate only    signed and hardened, but not notarised. Still blocked
 *                       on a machine that has never seen the app.
 *   certificate + notary  signed, hardened and stapled. Opens normally.
 *
 * Set CSC_IDENTITY_AUTO_DISCOVERY=false to force an unsigned build even when a
 * certificate is available, which is faster for local iteration.
 */

const signing = process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false';

// electron-builder needs all three to talk to Apple's notary service. Missing
// any one of them, notarising is skipped rather than failing the build.
const notarizeReady = Boolean(
  process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID,
);

if (process.platform === 'darwin') {
  if (!signing) console.log('[daphne] macOS: signing disabled, building unsigned');
  else if (!notarizeReady) console.log('[daphne] macOS: signing, but not notarising');
  else console.log('[daphne] macOS: signing and notarising');
}

module.exports = {
  appId: 'net.oramics.daphne',
  productName: 'Daphne',
  copyright: 'After Daphne Oram',
  directories: {
    output: 'release',
    buildResources: 'build-resources',
  },
  // No node_modules: Vite has already bundled everything the renderer uses and
  // the shell has no runtime dependencies.
  //
  // A glob rather than a list of names. Naming each file meant that adding
  // menu.cjs shipped a build whose main process died on `require` at startup,
  // and nothing caught it, because the app runs fine from source where the file
  // is simply there on disk.
  files: ['*.cjs', 'renderer/**/*', 'package.json'],
  publish: [{ provider: 'github', owner: 'stuart78', repo: 'daphne' }],

  mac: {
    category: 'public.app-category.music',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    darkModeSupport: true,
    // Notarising requires the hardened runtime, and the hardened runtime
    // requires the entitlements in build-resources.
    hardenedRuntime: signing,
    entitlements: 'build-resources/entitlements.mac.plist',
    entitlementsInherit: 'build-resources/entitlements.mac.plist',
    // Skips a `spctl` check that fails on an unnotarised build and stops the
    // packaging step before the notary ever runs.
    gatekeeperAssess: false,
    ...(signing ? {} : { identity: null }),
    // `true`, not `{ teamId }`: electron-builder reads APPLE_TEAM_ID from the
    // environment and warns that passing it in config is deprecated.
    ...(signing && notarizeReady ? { notarize: true } : { notarize: false }),
  },

  dmg: {
    title: 'Daphne ${version}',
  },

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },

  linux: {
    category: 'AudioVideo',
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'tar.gz', arch: ['x64', 'arm64'] },
    ],
    // Defaults to ${name}, which is the scoped workspace package name.
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },
};
