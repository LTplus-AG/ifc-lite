# Development Setup

Guide to setting up a development environment for IFClite.

## Prerequisites

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 22.x | JavaScript runtime (`engines` in `package.json`) |
| pnpm | 10.x (8.0+ minimum) | Package manager (pinned via `packageManager: pnpm@10.8.1`) |
| Rust | pinned nightly | WASM compilation; `rust-toolchain.toml` pins the nightly channel and the `wasm32-unknown-unknown` target, and rustup installs both automatically on first use in the repo |
| wasm-pack | 0.12+ | WASM toolchain (only needed to rebuild WASM; see `pnpm build:wasm:fetch` below) |

### Installing Prerequisites

=== "macOS"

    ```bash
    # Install Node.js via Homebrew
    brew install node@22

    # Install pnpm
    npm install -g pnpm

    # Install Rust (rustup reads rust-toolchain.toml and installs the
    # pinned nightly plus the wasm32-unknown-unknown target automatically)
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

    # Install wasm-pack
    cargo install wasm-pack
    ```

=== "Linux"

    ```bash
    # Install Node.js (Ubuntu/Debian)
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs

    # Install pnpm
    npm install -g pnpm

    # Install Rust (rustup reads rust-toolchain.toml and installs the
    # pinned nightly plus the wasm32-unknown-unknown target automatically)
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
    source ~/.cargo/env

    # Install wasm-pack
    cargo install wasm-pack
    ```

=== "Windows"

    ```powershell
    # Install Node.js via winget
    winget install OpenJS.NodeJS.LTS

    # Install pnpm
    npm install -g pnpm

    # Install Rust via rustup-init.exe (download from https://rustup.rs).
    # rustup reads rust-toolchain.toml and installs the pinned nightly
    # plus the wasm32-unknown-unknown target automatically.

    # Install wasm-pack
    cargo install wasm-pack
    ```

If you do not want a Rust toolchain at all, `pnpm build:wasm:fetch` downloads
the prebuilt `@ifc-lite/wasm` bundle from npm instead of compiling it.

## Clone and Build

### 1. Clone Repository

```bash
git clone https://github.com/LTplus-AG/ifc-lite.git
cd ifc-lite
```

The repository does not use Git LFS. Test model files (IFC/IFCX fixtures) are
not stored in git at all; they are fetched from a GitHub Release in the next
steps.

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Fetch Test Fixtures

```bash
pnpm fixtures
```

This downloads the IFC/IFCX test models catalogued in
`tests/models/manifest.json` from a GitHub Release. The fetch is selective and
idempotent: files already on disk with a matching SHA-256 are skipped, and
every download is hash-verified. Tests skip cleanly when fixtures are absent,
so this step is optional for a first build. See `tests/models/README.md` for
details.

### 4. Build All Packages

```bash
pnpm build
```

### 5. Verify Build

```bash
# Run tests
pnpm test

# Start viewer (builds packages, then runs the viewer dev server)
pnpm dev
```

## Project Structure

```
ifc-lite/
├── Cargo.toml             # Rust workspace root (members under rust/ and apps/server)
├── rust/                  # Rust crates
│   ├── core/              # ifc-lite-core (STEP parser)
│   ├── geometry/          # ifc-lite-geometry (geometry kernel, CSG)
│   ├── processing/        # ifc-lite-processing
│   ├── clash/             # ifc-lite-clash
│   ├── export/            # ifc-lite-export
│   ├── ffi/               # ifc-lite-ffi (native bindings)
│   └── wasm-bindings/     # ifc-lite-wasm (WASM crate)
├── packages/              # TypeScript packages (@ifc-lite/*)
│   ├── parser/            # @ifc-lite/parser
│   ├── geometry/          # @ifc-lite/geometry
│   ├── renderer/          # @ifc-lite/renderer
│   ├── query/             # @ifc-lite/query
│   ├── data/              # @ifc-lite/data
│   ├── export/            # @ifc-lite/export
│   ├── wasm/              # @ifc-lite/wasm (built bundle in pkg/)
│   └── ...                # cli, sdk, mcp, ids, bcf, collab, and more
├── apps/
│   ├── viewer/            # Viewer app
│   ├── viewer-embed/      # Embeddable viewer
│   ├── server/            # HTTP server (Rust)
│   └── landing/           # Landing page
└── docs/                  # Documentation (MkDocs)
```

## Development Workflow

### Watch Mode

Run a specific package in watch mode:

```bash
# Watch parser
cd packages/parser && pnpm dev

# Watch renderer
cd packages/renderer && pnpm dev
```

### Running the Viewer

From the repo root (builds workspace packages first):

```bash
pnpm dev
```

Or, if packages are already built:

```bash
cd apps/viewer
pnpm dev
```

Open http://localhost:3000 in your browser.

### Building WASM

```bash
pnpm build:wasm
```

The output goes to `packages/wasm/pkg/`. This needs the pinned nightly
toolchain and `wasm-pack`. Without a Rust toolchain, use
`pnpm build:wasm:fetch` to download the prebuilt bundle from npm.

### Running Rust Tests

The Cargo workspace root is the repo root:

```bash
cargo test --workspace
```

### Generating Documentation

**Rust Documentation (rustdoc):**

```bash
# Generate and open in browser (from the repo root)
cargo doc --no-deps --open

# Generate for a specific crate
cargo doc -p ifc-lite-core --open

# Generate without opening
cargo doc --no-deps
# Output: target/doc/index.html
```

**MkDocs (Project Documentation):**

```bash
# One-off: install MkDocs and plugins
pip install -r requirements-docs.txt

# Serve the docs site
pnpm docs:serve
# Opens at http://127.0.0.1:8000
```

## IDE Setup

### VS Code

Install recommended extensions:

```json
{
  "recommendations": [
    "rust-lang.rust-analyzer",
    "tamasfe.even-better-toml",
    "bradlc.vscode-tailwindcss",
    "esbenp.prettier-vscode",
    "dbaeumer.vscode-eslint"
  ]
}
```

### Settings

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "[rust]": {
    "editor.defaultFormatter": "rust-lang.rust-analyzer"
  },
  "rust-analyzer.cargo.features": "all"
}
```

## Common Tasks

### Adding a Dependency

TypeScript packages:

```bash
cd packages/parser
pnpm add new-package
```

Rust crates:

```bash
cd rust/core
cargo add new-crate
```

### Creating a New Package

```bash
mkdir packages/new-package
cd packages/new-package

# Initialize
pnpm init

# Add to workspace (update root package.json if needed)
```

### Updating Dependencies

```bash
# TypeScript
pnpm update -r

# Rust
cargo update
```

## Troubleshooting

### WASM Build Fails

```bash
# Clean and rebuild
cargo clean
pnpm build:wasm
```

### Node Modules Issues

```bash
# Clean install (keep pnpm-lock.yaml; it is the source of truth)
rm -rf node_modules
pnpm install
```

### TypeScript Errors

```bash
# Rebuild type declarations
pnpm -r build
```

## Contributing Changes

### 1. Create a Branch

```bash
git checkout -b feature/my-feature
# or
git checkout -b fix/bug-description
```

### 2. Make Changes

Make your changes and test them:

```bash
# Run tests
pnpm test

# Type check and lint
pnpm typecheck
pnpm lint

# Build to verify
pnpm build
```

### 3. Create Pull Request

Push your branch and open a PR on GitHub:

```bash
git push origin feature/my-feature
```

**PR Requirements:**
- All tests pass
- Code builds successfully
- Clear description of changes
- Reference related issues if applicable

## Next Steps

- [Testing](testing.md) - Testing guide
