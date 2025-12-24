// gemini/avr-sts-gemini/get_auth_url.js
const { getAuthorizationUrl } = require('./utils/google_calendar_helper');

console.log("Please visit the following URL to authorize the application:");
console.log(getAuthorizationUrl());
