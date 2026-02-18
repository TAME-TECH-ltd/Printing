# GitHub Actions for Tame Print Service

This repository includes automated build workflows for the Tame Print Service application.

## Workflows

### 1. CI - Build and Test (`ci.yml`)
- **Triggers**: Push to main/master/develop branches, Pull Requests
- **Purpose**: Continuous Integration - builds and tests the application
- **Platforms**: Windows, Linux
- **Artifacts**: Build outputs (retained for 7 days)

### 2. Build Optimized (`build-optimized.yml`)
- **Triggers**: Push to main/master, Pull Requests, Releases, Manual
- **Purpose**: Creates optimized builds without ffmpeg
- **Platforms**: Windows (optimized), macOS, Linux
- **Artifacts**: Platform-specific builds (retained for 30 days)

### 3. Build All Platforms (`build.yml`)
- **Triggers**: Push to main/master, Pull Requests, Releases
- **Purpose**: Standard builds for all platforms
- **Platforms**: Windows, macOS, Linux
- **Artifacts**: All platform builds

## Usage

### Automatic Builds
- Push code to `main` or `master` branch → Automatic build
- Create a Pull Request → Build and test
- Create a GitHub Release → Build and attach artifacts

### Manual Builds
- Go to Actions tab in GitHub
- Select "Build Optimized Tame Print Service"
- Click "Run workflow"

### Downloading Builds
1. Go to the Actions tab
2. Click on a completed workflow
3. Scroll down to "Artifacts" section
4. Download the build for your platform

## Build Outputs

### Windows
- `tame-print-service-windows-optimized`: Optimized build without ffmpeg
- Installer: `.exe` or `.msi` files

### macOS
- `tame-print-service-macos`: macOS application
- Package: `.dmg` files

### Linux
- `tame-print-service-linux`: Linux application
- Package: `.AppImage`, `.deb`, or `.rpm` files

## Configuration

The workflows use the following npm scripts:
- `npm run build:optimized` - Windows optimized build
- `npm run build:mac` - macOS build
- `npm run build:linux` - Linux build

## Requirements

- Node.js 18
- npm dependencies installed
- Electron Builder for packaging
