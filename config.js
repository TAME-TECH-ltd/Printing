// Configuration file for Tame Print Service
// Set this to false for production builds
module.exports = {
  // Development mode settings
  development: {
    skipLogin: true, // Skip login screen in development
    autoAuthenticate: true, // Automatically authenticate
    debugMode: true, // Enable debug logging
    devTools: true, // Show developer tools by default
  },

  // Production mode settings\
  production: {
    skipLogin: false, // Require login in production
    autoAuthenticate: false, // Manual authentication required
    debugMode: false, // Disable debug logging
    devTools: false, // Hide developer tools
  },

  // Current environment
  environment: process.env.NODE_ENV || "development",

  // Get current config based on environment
  get current() {
    return this.environment === "production"
      ? this.production
      : this.development;
  },

  // Helper function to check if in development mode
  isDevelopment() {
    return this.environment === "development";
  },

  // Helper function to check if in production mode
  isProduction() {
    return this.environment === "production";
  },
};
