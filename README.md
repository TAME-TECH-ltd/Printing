# Tame Print Service

A professional Electron-based desktop application for managing thermal printers and invoice printing configurations. Built with modern Windows 11 design principles and optimized for production deployment.

## 🚀 Features

- **Modern Windows 11 UI** - Professional, card-based design with smooth animations
- **Thermal Printer Management** - Add, edit, and delete printer configurations
- **API Integration** - Connect to invoice systems with connection testing
- **Secure Authentication** - Login system (configurable for development/production)
- **Real-time Printing** - Automatic invoice and order printing
- **Cross-platform Support** - Windows, macOS, and Linux compatibility
- **Database Management** - SQLite-based configuration storage
- **Professional Build System** - Electron Builder with size optimization

## 🔧 Development vs Production Modes

The application supports two modes that can be easily toggled:

### **Development Mode (Default)**
- ✅ **Login skipped** - Automatically authenticates
- ✅ **Debug logging** enabled
- ✅ **Developer tools** accessible
- ✅ **Auto-authentication** for faster development

### **Production Mode**
- 🔒 **Login required** - Full authentication flow
- 🚫 **Debug logging** disabled
- 🚫 **Developer tools** hidden
- 🔐 **Manual authentication** required

### **How to Toggle Modes**

1. **Edit `config.js` file:**
   ```javascript
   // For Development (skip login)
   development: {
     skipLogin: true,           // Skip login screen
     autoAuthenticate: true,    // Auto-authenticate
     debugMode: true,           // Enable debug logging
     devTools: true,            // Show developer tools
   },
   
   // For Production (require login)
   production: {
     skipLogin: false,          // Require login
     autoAuthenticate: false,   // Manual authentication
     debugMode: false,          // Disable debug logging
     devTools: false,           // Hide developer tools
   }
   ```

2. **Set environment variable:**
   ```bash
   # For development
   export NODE_ENV=development
   
   # For production
   export NODE_ENV=production
   ```

3. **Or modify `main.js` directly:**
   ```javascript
   const isDevelopmentMode = true;  // true = skip login, false = require login
   ```

## 📋 System Requirements

- **Operating System:** Windows 10/11, macOS 10.14+, Ubuntu 18.04+
- **Node.js:** 18.x or 20.x
- **RAM:** 2GB minimum, 4GB recommended
- **Storage:** 100MB available space
- **Network:** Internet connection for API integration

## 🚀 Quick Start

### **Prerequisites**
```bash
# Install Node.js 18.x or 20.x
# Download from: https://nodejs.org/

# Verify installation
node --version
npm --version
```

### **Installation**
```bash
# Clone the repository
git clone https://github.com/TAME-TECH-ltd/Printing.git
cd tame-print-service

# Install dependencies
npm install

# Start the application
npm start
```

### **Default Credentials (Development Mode)**
- **Username:** `admin`
- **Password:** `admin123`

*Note: In development mode, login is automatically skipped.*

## 🏗️ Building the Application

### **Windows Builds**
```bash
# Build Windows installer (NSIS)
npm run build:win-installer

# Build Windows portable executable
npm run build:win-portable

# Build both
npm run build:win
```

### **Cross-platform Builds**
```bash
# Build for all platforms
npm run build:all

# Build for specific platform
npm run build:mac      # macOS
npm run build:linux    # Linux
```

### **Build Outputs**
- **Windows:** `dist/` folder with `.exe` installer and portable
- **macOS:** `dist/` folder with `.dmg` installer
- **Linux:** `dist/` folder with `.AppImage` and `.deb` packages

## 🔐 Authentication

### **Development Mode**
- Login is automatically skipped
- Application starts directly to main interface
- Useful for development and testing

### **Production Mode**
- Full login authentication required
- Secure password verification
- User session management

### **Customizing Authentication**
1. **Modify `config.js`** to change modes
2. **Update `main.js`** for custom logic
3. **Customize login UI** in `index.html`
4. **Modify authentication flow** in `app.js`

## 🎨 UI Customization

The application uses a modern Windows 11 design system:

### **Color Scheme**
- **Primary:** `#0078d4` (Microsoft Blue)
- **Secondary:** `#106ebe` (Dark Blue)
- **Success:** `#10b981` (Green)
- **Warning:** `#f59e0b` (Amber)
- **Error:** `#ef4444` (Red)

### **Styling**
- **CSS Framework:** Custom Windows 11 design
- **Responsive Design:** Mobile-first approach
- **Animations:** Smooth transitions and hover effects
- **Typography:** Segoe UI font family

### **Customization Points**
- `assets/css/custom.css` - Main stylesheet
- `index.html` - UI structure
- `app.js` - Frontend logic
- `main.js` - Backend configuration

## 📱 API Integration

### **Configuration**
1. **Set API Base URL** in the application
2. **Test Connection** to verify endpoint
3. **Configure Printers** for different content types
4. **Set Content Filters** (Kitchen, Bar, Invoices)

### **Supported Content Types**
- **K** - Kitchen Orders
- **B** - Bar Orders  
- **I** - Invoices

### **API Endpoints**
- **Preloaders:** `/bkend/api/frontend/preloaders`
- **Next Printable Round:** `/bkend/api/next-printable-round`
- **Update Printed Round:** `/bkend/api/update-printed-round/{id}`

## 🗄️ Database

### **SQLite Database**
- **Location:** `~/.config/tame-print-service/printing.sqlite`
- **Tables:** `printers`, `settings`, `users`
- **Auto-initialization** on first run
- **Default admin user** created automatically

### **Schema**
```sql
-- Printers table
CREATE TABLE printers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  ip TEXT,
  port TEXT,
  interface TEXT NOT NULL,
  content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Settings table
CREATE TABLE settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_url TEXT NOT NULL,
  company_name TEXT,
  tin_number TEXT,
  phone TEXT,
  email TEXT,
  address_line TEXT,
  momo_code TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Users table
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 🚀 Deployment

### **GitHub Actions (Recommended)**
- **Automatic builds** on push to main/develop
- **Windows builds** with size optimization
- **Artifact uploads** for easy distribution
- **Release creation** for version management

### **Local Builds**
```bash
# Windows batch script
build-windows.bat

# PowerShell script
.\build.ps1

# Manual build
npm run build:win
```

### **Distribution**
- **Windows Installer:** Professional NSIS installer
- **Portable Executable:** No installation required
- **Auto-updates:** GitHub releases integration
- **Digital Signing:** Ready for code signing

## 🐛 Troubleshooting

### **Common Issues**

#### **Login Not Working**
- Check if in development mode (`config.js`)
- Verify database initialization
- Check console for error messages

#### **Printers Not Loading**
- Verify API connection
- Check network connectivity
- Review API endpoint configuration

#### **Build Failures**
- Ensure Node.js version compatibility
- Clear build cache: `npm run clean`
- Check available disk space

#### **Database Errors**
- Verify SQLite installation
- Check file permissions
- Review database path configuration

### **Debug Mode**
```bash
# Enable debug logging
export DEBUG=tame-print-service:*

# Start with debug
npm run dev
```

### **Logs**
- **Application logs:** Console output
- **Database logs:** SQLite query logs
- **Build logs:** Electron Builder output
- **Error logs:** IPC and runtime errors

## 🔒 Security Features

- **Context Isolation** - Prevents direct Node.js access
- **IPC Whitelisting** - Only allowed channels accessible
- **Sandbox Mode** - Restricted renderer process
- **Secure Communication** - Encrypted IPC channels
- **Input Validation** - Sanitized user inputs
- **Error Handling** - Secure error responses

## 🤝 Contributing

### **Development Setup**
```bash
# Fork the repository
git clone https://github.com/your-username/tame-print-service.git
cd tame-print-service

# Install dependencies
npm install

# Start development
npm run dev

# Run tests
npm test

# Build for testing
npm run build:win
```

### **Code Style**
- **JavaScript:** ES6+ with async/await
- **CSS:** BEM methodology
- **HTML:** Semantic markup
- **Vue.js:** Composition API

### **Pull Request Process**
1. **Fork** the repository
2. **Create** feature branch
3. **Make** changes with tests
4. **Submit** pull request
5. **Wait** for review and merge

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 📞 Support

- **Issues:** [GitHub Issues](https://github.com/TAME-TECH-ltd/tame-print-service/issues)
- **Discussions:** [GitHub Discussions](https://github.com/TAME-TECH-ltd/tame-print-service/discussions)
- **Documentation:** [Wiki](https://github.com/TAME-TECH-ltd/tame-print-service/wiki)

## 🙏 Acknowledgments

- **Electron** - Desktop application framework
- **Vue.js** - Progressive JavaScript framework
- **better-sqlite3** - Fast SQLite database
- **node-thermal-printer** - Thermal printer library
- **Microsoft Design System** - Windows 11 UI inspiration

---

**Built with ❤️ by TAME-TECH Team**

