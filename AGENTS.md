# Release versioning

- Use Semantic Versioning (`MAJOR.MINOR.PATCH`) for application releases.
- Increment PATCH for backward-compatible bug fixes, MINOR for backward-compatible features, and MAJOR for breaking changes.
- Every new release must have a new version; do not overwrite a previous release with changed application code.
- The root `package.json` version is the source of truth for the Windows application and installer. Keep the root package entry and top-level version in `package-lock.json` synchronized with it.
- Update versioned installer references in documentation and regenerate the installer when preparing a release. Verify that the packaged application version and installer filename match the requested release.
