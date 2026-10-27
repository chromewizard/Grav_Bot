# Public preview — October 27, 2026

Source selected from the `src` directory of Ian's Grav Bot project. The source project and installed app were left unchanged.

Publication changes:

- Included custom main-process, preload, renderer, CSS, HTML, and example role seed files.
- Excluded installers, application bundles, archived builds, personal state, screenshots, and the separate FindRequest handoff folder.
- Excluded the bundled Grok avatar runtime, fonts, sound files, and app icons. Added an original SVG avatar implementation, icon, system-font styling, and a synthesized notification tone.
- Removed personal paths, a fixed private Antigravity conversation ID, project-specific asset maps, and private project profile overrides. Example transcripts start empty.
- Isolated the public preview's data directory and loopback port from the original installation.
- Removed a startup routine that deleted legacy handoff files.
- Disabled automatic routing, automatic restart resumption, automatic CLI fallback retries, and permission bypass by default.
- Removed HTTP message sending, roster reads, and developer screenshot endpoints. Added workspace/symlink boundary checks and sandboxed HTML preview frames.
- Excluded private language-server credential discovery and voice streaming. The mic uses macOS Dictation instead.
- Added installation instructions, a dependency lockfile, and offline integration checks.

Still pending: live model-response acceptance on a signed-in account with available quota; real-Mac verification of microphone behavior, drag/drop, and all visual controls; packaging, code signing, notarization, and a distributable public installer; a license selection by the owner. The original DMG is not a release artifact of this public tree.

No claims are made about Turing-test performance, lower running costs, feature parity, or production readiness.
