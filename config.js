module.exports = {
  development: {
    skipLogin: true,
    autoAuthenticate: true,
    debugMode: true,
    devTools: true,
  },

  production: {
    skipLogin: false,
    autoAuthenticate: false,
    debugMode: false,
    devTools: false,
  },

  environment: process.env.NODE_ENV || "development",

  get current() {
    return this.environment === "production"
      ? this.production
      : this.development;
  },

  isDevelopment() {
    return this.environment === "development";
  },

  isProduction() {
    return this.environment === "production";
  },
};
