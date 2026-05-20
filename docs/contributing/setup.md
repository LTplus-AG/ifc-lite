# Development Setup

Guide to setting up a development environment for IFClite.

## Prerequisites

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 18.0+ | JavaScript runtime |
| pnpm | 8.0+ | Package manager |
| Rust | stable | WASM compilation |
| wasm-pack | 0.12+ | WASM toolchain |

### Installing Prerequisites

=== "macOS"

    ```bash
    # Install Node.js via Homebrew
    brew install node@18

    # Install pnpm
    npm install -g pnpm

    # Install Rust
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

    # Add WASM target
    rustup target add wasm32-unknown-unknown

    # Install wasm-pack
    cargo install wasm-pack
    ```

=== "Linux"

    ```bash
    # Install Node.js (Ubuntu/Debian)
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs

    # Install pnpm
    npm install -g pnpm

    # Install Rust
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
    source ~/.cargo/env

    # Add WASM target
    rustup target add wasm32-unknown-unknown

    # Install wasm-pack
    cargo install wasm-pack
    ```

=== "Windows"

    ```powershell
    # Install Node.js via winget
    winget install OpenJS.NodeJS.LTS

    # Install pnpm
    npm install -g pnpm

    # Install Rust via rustup-init.exe
    # Download from https://rustup.rs

    # Add WASM target
    rustup target add wasm32-unknown-unknown

    # Install wasm-pack
    cargo install wasm-pack
    ```

## Clone and Build

### 1. Clone Repository

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/LTplus-AG/ifc-lite.git
cd ifc-lite
```

This skips automatic Git LFS downloads during clone. For heavy benchmark or stress-test fixtures, fetch only the exact files you need later:

```bash
git lfs pull --include="tests/models/ara3d/AC20-FZK-Haus.ifc"
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Build All Packages

```bash
pnpm build
```

### 4. Verify Build

```bash
# Run tests
pnpm test

# Start viewer
cd apps/viewer && pnpm dev
```

## Project Structure

```
ifc-lite/
├── rust/                  # Rust crates
│   ├── core/              # Parser crate
│   ├── geometry/          # Geometry crate
│   └── wasm-bindings/     # WASM crate
├── packages/              # TypeScript packages
│   ├── parser/            # @ifc-lite/parser
│   ├── geometry/          # @ifc-lite/geometry
│   ├── renderer/          # @ifc-lite/renderer
│   ├── query/             # @ifc-lite/query
│   ├── data/              # @ifc-lite/data
│   ├── export/            # @ifc-lite/export
│   └── codegen/           # Schema generator
├── apps/
│   └── viewer/            # Demo viewer app
├── docs/                  # Documentation
└── plan/                  # Specifications
```

## Development Workflow

### Watch Mode

Run all packages in watch mode:

```bash
pnpm -r dev
```

Or specific packages:

```bash
# Watch parser
cd packages/parser && pnpm dev

# Watch renderer
cd packages/renderer && pnpm dev
```

### Running the Viewer

```bash
cd apps/viewer
pnpm dev
```

Open http://localhost:5173 in your browser.

### Building WASM

```bash
cd rust/wasm-bindings
wasm-pack build --target web --release
```

The output goes to `rust/wasm-bindings/pkg/`.

### Running Rust Tests

```bash
cd rust
cargo test
```

### Generating Documentation

**Rust Documentation (rustdoc):**

```bash
# Generate and open in browser
cd rust && cargo doc --no-deps --open

# Generate for specific crate
cd rust/core && cargo doc --open

# Generate without opening
cargo doc --no-deps
# Output: target/doc/index.html
```

**MkDocs (Project Documentation):**

```bash
cd docs && mkdocs serve
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
cd rust
cargo clean
wasm-pack build --target web --release
```

### Node Modules Issues

```bash
# Clean install
rm -rf node_modules pnpm-lock.yaml
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
