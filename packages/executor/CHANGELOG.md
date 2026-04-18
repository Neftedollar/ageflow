# Changelog

## 0.7.0

### Breaking

- `runNode()` signature changed in v0.6.3 (#167) from positional optional args to a single `RunNodeOpts` object after the required parameters. This was inadvertently shipped as a patch — now correctly versioned as a major bump. Existing JS callers using positional args must migrate to the options-object form.
