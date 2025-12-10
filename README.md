# Sasebo

**Sasebo** is a lightweight Cloudflare Worker that provides a simple web interface for browsing and downloading objects in your R2 buckets.

## Quick Start

1. Modify the `r2_buckets` bindings and customize the `OWNER` and `FAVICON` fields in the `vars` section of `wrangler.jsonc`.
2. Run `pnpm install` to install dependencies and generate type definitions.
3. Deploy the worker with `pnpm run deploy`.

## Supported Features

- _Range header (206 Partial Content)_ for range-based downloads (multipart/byteranges is not supported).
- _If-None-Match header (304 Not Modified)_ for ETag-based caching.

## LICENSE

This project is licensed under [Mozilla Public License 2.0 (MPL 2.0)](LICENSE)
