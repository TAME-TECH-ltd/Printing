# Tame Print Service - Build Instructions

## Overview

This document provides comprehensive instructions for building the Tame Print Service application for Windows, including automated builds via GitHub Actions and local builds.

## 🚀 Quick Start (GitHub Actions - Recommended)

### Automatic Build on Push
1. **Push to main branch**: The application will automatically build on GitHub Actions
2. **Build artifacts**: Available in the Actions tab after completion
3. **Releases**: Automatically created for main branch pushes

### Manual Release Creation
1. Go to GitHub repository → Releases
2. Click "Create a new release"
3. Choose a tag (e.g., v1.2.3)
4. GitHub Actions will build and attach the installer

## 🛠️ Local Build (Windows)

### Prerequisites
- **Node.js**: 18.x or 20.x (LTS recommended)
- **npm**: 9.x or later
- **Git**: For cloning the repository

### Build Commands

#### Option 1: Simple Build Script
```bash
# Run the Windows batch file
build-windows.bat
```

#### Option 2: Manual npm Commands
```bash
# Install dependencies
npm install

# Build both installer and portable
npm run build:win

# Build only installer
npm run build:win-installer

# Build only portable
npm run build:win-portable

# Clean build artifacts
npm run clean
```

### Build Outputs
- **Location**: `dist/` folder
- **Files**:
  - `PrintingService-Setup-1.2.2.exe` - NSIS installer
  - `PrintingService-Portable-1.2.2.exe` - Portable executable

## 📦 Build Configuration

### Electron Builder Configuration
The build process uses `electron-builder` with the following optimizations:

- **ASAR packaging**: Reduces file count and improves loading
- **Maximum compression**: Minimizes file sizes
- **File filtering**: Excludes unnecessary files and documentation
- **Cross-platform support**: Windows, macOS, and Linux targets

### Size Optimization Features
- **Tree shaking**: Removes unused code
- **Dependency pruning**: Excludes dev dependencies
- **Asset optimization**: Compressed icons and resources
- **Minimal packaging**: Only essential files included

## 🔧 Build Scripts Reference

### Package.json Scripts
```json
{
  "build:win": "Build both installer and portable",
  "build:win-installer": "Build NSIS installer only",
  "build:win-portable": "Build portable executable only",
  "build:all": "Build for all platforms",
  "clean": "Remove build artifacts",
  "dist": "Run electron-builder directly"
}
```

### GitHub Actions Workflow
- **Trigger**: Push to main/develop, PRs, releases
- **Platform**: Windows-latest
- **Node versions**: 18.x and 20.x (matrix build)
- **Caching**: Electron and electron-builder caches
- **Artifacts**: Build outputs with 30-day retention

## 📁 Build Artifacts

### Generated Files
```
dist/
├── PrintingService-Setup-1.2.2.exe    # Windows installer
├── PrintingService-Portable-1.2.2.exe # Portable version
└── win-unpacked/                      # Unpacked application
```

### File Sizes (Estimated)
- **Installer**: ~80-120 MB
- **Portable**: ~70-100 MB
- **Unpacked**: ~150-200 MB

## 🚨 Troubleshooting

### Common Build Issues

#### 1. Node.js Version Mismatch
```bash
# Check Node.js version
node --version

# Use nvm to switch versions (Windows)
nvm use 18.17.0
```

#### 2. Dependency Issues
```bash
# Clear npm cache
npm cache clean --force

# Remove node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

#### 3. Build Failures
```bash
# Check build logs
npm run build:win --verbose

# Clean and rebuild
npm run clean
npm run build:win
```

#### 4. Electron Download Issues
```bash
# Set Electron mirror (if needed)
set ELECTRON_MIRROR=https://npm.taobao.org/mirrors/electron/
npm run build:win
```

### Performance Optimization

#### 1. Faster Builds
- Use SSD storage
- Ensure sufficient RAM (8GB+)
- Close unnecessary applications
- Use npm ci instead of npm install

#### 2. Smaller Outputs
- Enable maximum compression
- Exclude unnecessary files
- Use ASAR packaging
- Optimize assets before build

## 🔄 Continuous Integration

### GitHub Actions Features
- **Automatic builds** on code changes
- **Matrix builds** for multiple Node.js versions
- **Caching** for faster builds
- **Artifact management** with retention policies
- **Release automation** for main branch

### Workflow Triggers
```yaml
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
  release:
    types: [published]
```

## 📋 Build Checklist

### Before Building
- [ ] All tests pass
- [ ] Dependencies are up to date
- [ ] Version number is correct
- [ ] Assets are optimized
- [ ] Documentation is updated

### After Building
- [ ] Installer runs correctly
- [ ] Portable version works
- [ ] File sizes are reasonable
- [ ] Artifacts are uploaded
- [ ] Release notes are complete

## 🌐 Distribution

### Windows Installer
- **NSIS-based** installer
- **Custom branding** and icons
- **Desktop shortcuts** creation
- **Start menu** integration
- **Uninstaller** included

### Portable Version
- **Single executable** file
- **No installation** required
- **Portable** across systems
- **USB drive** compatible

## 📞 Support

### Build Issues
- Check GitHub Actions logs
- Review build configuration
- Verify Node.js compatibility
- Check dependency versions

### Application Issues
- Review application logs
- Check system requirements
- Verify printer configuration
- Test on clean system

## 🔗 Useful Links

- [Electron Builder Documentation](https://www.electron.build/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [NSIS Documentation](https://nsis.sourceforge.io/)
- [Node.js Downloads](https://nodejs.org/)
- [Project Repository](https://github.com/TAME-TECH-ltd/Printing)

---

**Note**: This build system is optimized for Windows environments and will automatically create professional installers with minimal file sizes. The GitHub Actions workflow ensures consistent builds across different environments.
